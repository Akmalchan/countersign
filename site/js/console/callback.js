// Callback verification: the control finance teams are told to use. Never call the number
// printed on a suspicious bill (a scammer prints their own). Call the number we already
// trust: the vendor's record, or the company's listed phone from live data.
// Pure functions, shared by the server and the console.

const PHONE_RE = /(?:\+?1[\s.-]?)?\(?\b([2-9]\d{2})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})\b/g;

/** E.164 form of a US number, or '' when it isn't one. */
export function normPhone(s) {
  const d = String(s ?? '').replace(/\D/g, '');
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d[0] === '1') return '+' + d;
  if (String(s ?? '').trim().startsWith('+') && d.length >= 8) return '+' + d;
  return '';
}

export const prettyPhone = (e164) => {
  const m = String(e164 ?? '').match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : String(e164 ?? '');
};

/** Phone numbers printed on the bill, excluding anything that is clearly a bank number. */
export function phonesOnBill(text) {
  const out = new Set();
  for (const line of String(text ?? '').split('\n')) {
    if (/routing|account|iban|swift|aba|acct/i.test(line)) continue;
    for (const m of line.matchAll(PHONE_RE)) out.add('+1' + m[1] + m[2] + m[3]);
  }
  return [...out];
}

/** Which number to call and why, plus whether the bill's own number disagrees. */
export function callPlan(c, vendor) {
  const onBill = phonesOnBill(c.text);
  const fromRecord = normPhone(vendor?.phone);
  const fromLive = normPhone(c.check?.intel?.phone);
  const trusted = fromRecord || fromLive || '';
  const source = fromRecord ? 'the vendor record' : fromLive ? 'the company’s listed number (Glasser · Hunter)' : null;
  const mismatch = trusted && onBill.length > 0 && !onBill.includes(trusted);
  return { trusted, source, onBill, mismatch };
}

const YES = /\b(yes|yeah|yep|yup|correct|confirm(ed)?|that'?s right|we did|i did|sure|affirmative)\b/i;
const NO = /\b(no|nope|nah|never|didn'?t|did not|don'?t|not ours|not us|wrong)\b/i;
const STRONG_NO = /\b(did not|didn'?t|never|not ours|not us|nope|nah)\b|^\W*no\b/i;

/** What the person on the phone said, from their own words only. A clear no wins. */
export function classifyAnswer(userLines) {
  for (const line of [...userLines].reverse()) {
    if (STRONG_NO.test(line)) return 'denied';
    if (YES.test(line)) return 'confirmed';
    if (NO.test(line)) return 'denied';
  }
  return 'unclear';
}

/**
 * A callback is a human answering on a number we trust, so it can move the stamp both ways:
 * "no" stops the bill; "yes" clears a HOLD. It never unlocks a STOP: hard evidence (a fake
 * routing number, a lookalike domain) outranks a voice on the phone.
 */
export function applyCallback(s, cb) {
  if (!cb?.result) return s;
  const out = { ...s };
  if (cb.result === 'denied') {
    out.band = 'stop';
    out.reason = 'The vendor said on the phone they did not send this bill. Do not pay.';
  } else if (cb.result === 'confirmed' && out.band === 'hold') {
    out.band = 'clear';
    out.reason = 'The vendor confirmed this bill by phone, on a number we trust (not the one printed on the bill).';
  }
  return out;
}

export const CALL_LABEL = { confirmed: 'Vendor confirmed by phone', denied: 'Vendor denied sending this bill', unclear: 'Answer unclear', no_answer: 'No answer', failed: 'Call failed' };
