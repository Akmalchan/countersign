// Email-level evidence for bills that arrived by email. Pure functions, shared by the
// server and the browser so both stamp the same way.
//
// Gmail writes an Authentication-Results header on every message it receives:
//   "mx.google.com; dkim=pass header.i=@vercel.com; spf=pass ...; dmarc=pass (p=REJECT) header.from=vercel.com"
// DMARC fail means the visible From domain was not actually authorized to send it.
// A Reply-To on a different domain than From is a classic redirect trick: you reply
// "to the vendor" and land in the attacker's inbox.

const domainOf = (addr) => String(addr ?? '').split('@')[1]?.toLowerCase().trim() ?? '';
const registrable = (d) => d.split('.').slice(-2).join('.');
// Billing platforms send on behalf of their merchants, with Reply-To set to the merchant
// (a Render invoice comes from stripe.com and replies go to render.com). That's normal.
export const BILLING_PLATFORMS = ['stripe.com', 'paypal.com', 'intuit.com', 'bill.com', 'xero.com', 'chargebee.com', 'paddle.com', 'squareup.com', 'freshbooks.com', 'zoho.com'];
const isPlatform = (d) => BILLING_PLATFORMS.some((p) => d === p || d.endsWith('.' + p));

// Plain labels for the inbox and mailbox lists.
export const SHORT = { dmarc: 'Sender not verified', spfdkim: 'Mail signature failed', replyto: 'Replies go elsewhere' };

export function parseAuthResults(header) {
  const text = (Array.isArray(header) ? header.join('; ') : String(header ?? '')).toLowerCase();
  const pick = (k) => text.match(new RegExp(`\\b${k}=([a-z]+)`))?.[1] ?? null;
  return { spf: pick('spf'), dkim: pick('dkim'), dmarc: pick('dmarc') };
}

/**
 * @param {{from:string, fromName?:string, replyTo?:string, auth:{spf,dkim,dmarc}}} email
 * @returns {{checks: Array<{id,name,status,severity?,finding}>, forcesHold: boolean, forcesStop: boolean}}
 */
export function analyzeEmail(email) {
  const checks = [];
  const { spf, dkim, dmarc } = email.auth ?? {};

  if (dmarc === 'pass') checks.push({ id: 'dmarc', name: 'Sender authenticated (DMARC)', status: 'pass', finding: `Gmail verified the message really came from ${domainOf(email.from)}` });
  else if (dmarc === 'fail') checks.push({ id: 'dmarc', name: 'Sender authenticated (DMARC)', status: 'flag', severity: 'high', finding: `DMARC failed: ${domainOf(email.from)} did not authorize this message. The From line is likely spoofed.` });
  else checks.push({ id: 'dmarc', name: 'Sender authenticated (DMARC)', status: 'unknown', finding: dmarc ? `DMARC result “${dmarc}”: the domain publishes no enforceable policy` : 'No DMARC result on this message' });

  const spfOk = spf === 'pass', dkimOk = dkim === 'pass';
  if (spfOk || dkimOk) checks.push({ id: 'spfdkim', name: 'Mail server signature (SPF/DKIM)', status: 'pass', finding: `${[spfOk && 'SPF', dkimOk && 'DKIM'].filter(Boolean).join(' and ')} passed` });
  else if (spf === 'fail' || dkim === 'fail') checks.push({ id: 'spfdkim', name: 'Mail server signature (SPF/DKIM)', status: 'flag', severity: 'med', finding: `SPF ${spf ?? 'none'}, DKIM ${dkim ?? 'none'}` });
  else checks.push({ id: 'spfdkim', name: 'Mail server signature (SPF/DKIM)', status: 'unknown', finding: 'No SPF/DKIM result on this message' });

  const fromD = domainOf(email.from), replyD = domainOf(email.replyTo);
  if (email.replyTo && replyD && registrable(replyD) !== registrable(fromD) && isPlatform(fromD) && dmarc === 'pass') {
    checks.push({ id: 'replyto', name: 'Reply-To matches sender', status: 'pass', finding: `Sent by ${registrable(fromD)} on behalf of ${replyD}; replies go to the merchant, which is normal for billing platforms` });
  } else if (email.replyTo && replyD && registrable(replyD) !== registrable(fromD)) {
    checks.push({ id: 'replyto', name: 'Reply-To matches sender', status: 'flag', severity: 'high', finding: `Replies go to ${email.replyTo}, not ${fromD}` });
  } else checks.push({ id: 'replyto', name: 'Reply-To matches sender', status: 'pass', finding: email.replyTo ? `Replies go to the same domain (${replyD})` : 'No separate Reply-To' });

  const high = checks.filter((c) => c.status === 'flag' && c.severity === 'high');
  return { checks, forcesHold: checks.some((c) => c.status === 'flag'), forcesStop: high.length >= 1 && checks.some((c) => c.id === 'dmarc' && c.status === 'flag') };
}

/** Email evidence can only make a stamp stricter, never looser. */
export function applyEmail(s, analysis) {
  if (!analysis) return s;
  const out = { ...s };
  if (analysis.forcesStop && out.band !== 'stop') {
    out.band = 'stop'; out.reason = 'The email failed authentication: the sender is likely spoofed. Do not pay.';
  } else if (analysis.forcesHold && out.band === 'clear') {
    out.band = 'hold'; out.reason = 'The bill looks fine, but the email it came in on has a red flag. A human needs to look.';
  }
  return out;
}
