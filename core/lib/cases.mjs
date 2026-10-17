// Case lifecycle: an uploaded bill becomes a case, gets checked live, and moves through
// human decisions. Two-person rule: bills at or above policy.dualApprovalOver need
// approvals from two different people. A STOP stamp can't be approved at all unless the
// approver marks the flags that caused it as false alarms (with a reason), and even then
// the rescored bill must no longer be STOP.

import { writeFile, mkdir } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { runChecks, score, learn, DEFAULT_WEIGHTS, normalizeLabel, levenshtein } from '../../site/js/engine.js';
import { buildIntel } from './intel.mjs';
import { analyzeEmail, applyEmail } from '../../site/js/console/mailrules.js';
import { analyzeDocument, applyDocument, withoutDismissed } from '../../site/js/console/docrules.js';
import { applyCallback } from '../../site/js/console/callback.js';
import { fastLane } from '../../site/js/console/fastlane.js';
import { DEMO_INTEL } from './demo.mjs';
import { db, audit, newId, UPLOADS } from './store.mjs';

const MIME_EXT = { 'application/pdf': '.pdf', 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };
const FIELDS = ['vendorName', 'senderEmail', 'number', 'amount', 'currency', 'issued', 'due', 'bankLast4', 'address', 'body'];

const domainOf = (email) => String(email ?? '').split('@')[1]?.toLowerCase().trim() ?? '';
const registrable = (d) => d.split('.').slice(-2).join('.');
const normName = (s) => normalizeLabel(String(s ?? '').toLowerCase().replace(/\b(inc|llc|ltd|co|corp|corporation|company|gmbh|billing|invoices?)\b\.?/g, '').replace(/[^a-z0-9]/g, ''));

/** Which vendor does this bill CLAIM to be from? Name first (that's what a lookalike fakes), then domain. */
export function matchVendor(fields, vendors) {
  const n = normName(fields.vendorName);
  if (n.length >= 3) {
    let best = null;
    for (const v of vendors) {
      const vn = normName(v.name);
      const d = vn.includes(n) || n.includes(vn) ? 0 : levenshtein(vn, n);
      if (d <= 2 && (!best || d < best.d)) best = { v, d };
    }
    if (best) return best.v.key;
  }
  const dom = domainOf(fields.senderEmail);
  const byDomain = dom && vendors.find((v) => registrable(v.domain) === registrable(dom));
  return byDomain ? byDomain.key : null;
}

const vendorMap = (vendors) => Object.fromEntries(vendors.map((v) => [v.key, v]));

async function weights() {
  const policy = await db.get('policy');
  return { ...DEFAULT_WEIGHTS, ...(policy.weights ?? {}) };
}

// Billing platforms send invoices on behalf of their merchants (Render bills arrive from
// stripe.com). For those, the company to verify is the merchant, found in the PDF itself.
const BILLING_PLATFORMS = ['stripe.com', 'paypal.com', 'intuit.com', 'bill.com', 'xero.com', 'chargebee.com', 'paddle.com', 'squareup.com', 'freshbooks.com', 'zoho.com'];
const isPlatform = (d) => BILLING_PLATFORMS.some((p) => d === p || d.endsWith('.' + p));

function merchantDomain(c, policy) {
  const own = (policy.companyDomain ?? '').toLowerCase();
  const doms = [...String(c.text ?? '').matchAll(/[a-z0-9._%+-]+@([a-z0-9.-]+\.[a-z]{2,})/gi)].map((m) => m[1].toLowerCase());
  return doms.find((d) => !isPlatform(d) && d !== own && !/^(gmail|googlemail|yahoo|outlook|hotmail|icloud|me|proton(mail)?)\.(com|me)$/.test(d)) ?? null;
}

/** Run live intel + the engine for a case's current fields. */
export async function checkCase(c, { fresh = false } = {}) {
  const [vendors, policy] = await Promise.all([db.get('vendors'), db.get('policy')]);
  const sender = domainOf(c.fields.senderEmail);
  // Billed through a platform: check the merchant named on the bill, and say so.
  c.billedVia = null;
  let effectiveSender = c.fields.senderEmail;
  if (sender && isPlatform(sender)) {
    const merchant = merchantDomain(c, policy);
    if (merchant) { c.billedVia = { platform: registrable(sender), merchant }; effectiveSender = `billing@${merchant}`; }
  }
  c.vendorKey = matchVendor({ ...c.fields, senderEmail: effectiveSender }, vendors);
  const inv = { ...c.fields, senderEmail: effectiveSender, vendorKey: c.vendorKey, amount: Number(c.fields.amount) || 0, lines: [] };
  const domain = domainOf(inv.senderEmail);
  // Sample emails use sample vendor data: no live lookups for made-up .example domains.
  const live = c.demo
    ? { intel: DEMO_INTEL[domain] ?? null, sources: [{ source: 'Sample data (sample email, no live lookup)', ok: true, value: DEMO_INTEL[domain]?.summary ?? 'no sample record', runUrl: null, charge: 0, cached: false }], cost: 0 }
    : domain ? await buildIntel(domain, { fresh }) : { intel: null, sources: [], cost: 0 };
  const intel = live.intel ? { [domain]: live.intel } : {};
  const results = runChecks(inv, vendorMap(vendors), intel);
  const email = c.email ? analyzeEmail(c.email) : null;
  const doc = c.text ? analyzeDocument({ text: c.text, meta: c.docMeta, fields: c.fields, vendor: vendors.find((v) => v.key === c.vendorKey) }) : null;
  const s = applyCallback(applyDocument(applyEmail(score(results, await weights(), { dismissed: new Set(c.dismissed ?? []), isNewVendor: !c.vendorKey }), email), withoutDismissed(doc, c.dismissed)), c.callback);
  // (the callback answer, if any, is applied last: a human on a trusted number)
  c.check = { results, score: s, email, doc, intel: live.intel, sources: live.sources, cost: live.cost, checkedAt: new Date().toISOString() };
  c.fastLane = fastLane(c, vendors.find((v) => v.key === c.vendorKey));
  return c;
}

export async function createCase({ userId, file, fields, fieldMeta, text, mailRef, docMeta }) {
  const id = newId('case');
  let stored = null;
  if (file?.dataBase64) {
    const ext = MIME_EXT[file.mime] ?? (extname(file.name || '') || '.bin');
    if (!MIME_EXT[file.mime]) throw new Error('only PDF, PNG, JPEG or WebP uploads');
    const bytes = Buffer.from(file.dataBase64, 'base64');
    if (bytes.length > 12 * 1024 * 1024) throw new Error('file larger than 12 MB');
    await mkdir(UPLOADS, { recursive: true });
    const name = `${id}${ext}`;
    await writeFile(join(UPLOADS, name), bytes);
    stored = { name: file.name ?? name, stored: name, mime: file.mime, size: bytes.length };
  }
  const clean = Object.fromEntries(FIELDS.map((k) => [k, fields?.[k] ?? '']));
  clean.amount = Number(String(clean.amount).replace(/[^0-9.]/g, '')) || 0;

  // A bill that came from the mailbox: the email's own headers are the source of truth
  // for who sent it, not whatever address is printed on the PDF.
  let email = null, mailRec = null;
  if (mailRef?.messageId) {
    mailRec = (await db.get('mail')).find((m) => m.messageId === mailRef.messageId);
    if (mailRec) {
      email = { messageId: mailRec.messageId, from: mailRec.from, fromName: mailRec.fromName, replyTo: mailRec.replyTo, subject: mailRec.subject, date: mailRec.date, auth: mailRec.auth };
      clean.senderEmail = mailRec.from;
      fieldMeta = { ...(fieldMeta ?? {}), senderEmail: { confidence: 'high', rule: 'From header of the email (verified by Gmail)' } };
    }
  }

  const c = {
    id, createdAt: new Date().toISOString(), createdBy: userId, status: 'needs_review',
    file: stored, text: String(text ?? '').slice(0, 20000), fields: clean, fieldMeta: fieldMeta ?? {},
    email, demo: !!mailRec?.demo, dismissed: [], approvals: [], decision: null, vendorKey: null, check: null,
    docMeta: docMeta && typeof docMeta === 'object' ? Object.fromEntries(['Producer', 'Creator', 'CreationDate', 'ModDate'].filter((k) => docMeta[k]).map((k) => [k, String(docMeta[k]).slice(0, 200)])) : null,
  };
  await checkCase(c);
  await db.update('cases', (cases) => { cases.unshift(c); });
  if (mailRec) {
    const f = mailRec.files.find((x) => x.stored === mailRef.stored);
    if (f) f.caseId = id;
    await db.save('mail');
  }
  await audit(userId, 'case.created', id, { file: stored?.name ?? null, vendor: clean.vendorName, amount: clean.amount, stamp: c.check.score.band, risk: c.check.score.risk, via: email ? `email from ${email.from}` : 'upload' });
  return c;
}

export async function editFields(id, userId, patch) {
  const cases = await db.get('cases');
  const c = cases.find((x) => x.id === id);
  if (!c) throw Object.assign(new Error('case not found'), { code: 404 });
  if (['approved', 'rejected', 'dismissed'].includes(c.status)) throw Object.assign(new Error('case is closed'), { code: 409 });
  const changes = {};
  for (const k of FIELDS) {
    if (patch[k] === undefined) continue;
    const v = k === 'amount' ? Number(String(patch[k]).replace(/[^0-9.]/g, '')) || 0 : String(patch[k]);
    if (v !== c.fields[k]) { changes[k] = { from: c.fields[k], to: v }; c.fields[k] = v; c.fieldMeta[k] = { source: 'human', by: userId }; }
  }
  if (Object.keys(changes).length) {
    c.approvals = []; // any edit invalidates earlier signatures
    if (c.status === 'awaiting_second') c.status = 'needs_review';
    await checkCase(c);
    await db.save('cases');
    await audit(userId, 'case.fields_edited', id, { changes, stamp: c.check.score.band, risk: c.check.score.risk });
  }
  return c;
}

export async function decide(id, { userId, action, reason, dismissed = [] }) {
  const [cases, users, policy, vendors] = await Promise.all([db.get('cases'), db.get('users'), db.get('policy'), db.get('vendors')]);
  const c = cases.find((x) => x.id === id);
  const user = users.find((u) => u.id === userId);
  const fail = (code, msg) => { throw Object.assign(new Error(msg), { code }); };
  if (!c) fail(404, 'case not found');
  if (!user) fail(400, 'unknown user');
  if (['approved', 'rejected', 'dismissed'].includes(c.status)) fail(409, `case already ${c.status}`);
  if (!['approve', 'reject', 'hold', 'dismiss'].includes(action)) fail(400, 'action must be approve, reject, hold or dismiss');
  if (!reason || String(reason).trim().length < 3) fail(400, 'a reason is required for every decision');

  // Re-score with the dismissals this person is vouching for.
  c.dismissed = [...new Set(dismissed)];
  const s = applyCallback(applyDocument(applyEmail(score(c.check.results, { ...DEFAULT_WEIGHTS, ...(policy.weights ?? {}) }, { dismissed: new Set(c.dismissed), isNewVendor: !c.vendorKey }), c.check.email), withoutDismissed(c.check.doc, c.dismissed)), c.callback);
  c.check.score = s;

  if (action === 'approve') {
    if (s.band === 'stop') fail(403, 'Locked: the stamp is STOP. Resolve the flags or mark them as false alarms with a reason first.');
    // Segregation of duties: whoever entered a bill can't also approve it.
    if (c.createdBy === userId) fail(403, 'Segregation of duties: you uploaded this bill, so someone else has to approve it.');
    if (c.approvals.some((a) => a.userId === userId)) fail(409, 'you already signed this bill; a different person must countersign');
    c.approvals.push({ userId, name: user.name, role: user.role, at: new Date().toISOString(), reason });
    const required = c.fields.amount >= policy.dualApprovalOver ? 2 : 1;
    if (c.approvals.length < required) {
      c.status = 'awaiting_second';
      await db.save('cases');
      await audit(userId, 'case.signed', id, { signatures: `${c.approvals.length}/${required}`, reason });
      return c;
    }
    c.status = 'approved';
    c.decision = { action, at: new Date().toISOString(), by: c.approvals.map((a) => a.name) };
    // The vendor's records learn from a fully approved bill.
    const dom = domainOf(c.fields.senderEmail);
    let v = vendors.find((x) => x.key === c.vendorKey);
    if (!v) {
      v = { key: newId('v'), name: c.fields.vendorName || dom, domain: dom, bankLast4: c.fields.bankLast4, history: [], address: c.fields.address, paidInvoices: [], createdAt: new Date().toISOString() };
      vendors.push(v);
      await audit(userId, 'vendor.created', id, { vendor: v.name, domain: v.domain });
    }
    v.history = [...(v.history ?? []), c.fields.amount].slice(-12);
    v.paidInvoices = [...(v.paidInvoices ?? []), c.fields.number];
    // Remember what software made this vendor's real bills, so an edited copy stands out.
    const fp = c.check.doc?.checks.find((x) => x.id === 'fingerprint')?.fingerprint;
    if (fp) v.docFingerprints = [...new Set([...(v.docFingerprints ?? []).filter((x) => x !== fp), fp])].slice(-5);
    await db.save('vendors');
  } else if (action === 'dismiss') {
    // Not a bill (a receipt, a duplicate, a ticket): closed without paying or rejecting.
    c.status = 'dismissed';
    c.decision = { action, at: new Date().toISOString(), by: [user.name], reason };
    await db.save('cases');
    await audit(userId, 'case.dismissed', id, { reason });
    return c;
  } else {
    c.status = action === 'reject' ? 'rejected' : 'on_hold';
    c.decision = { action, at: new Date().toISOString(), by: [user.name], reason };
  }

  // Learning: dismissals make a check quieter, rejections make flags louder.
  const learned = learn({ ...DEFAULT_WEIGHTS, ...(policy.weights ?? {}) }, c.check.results, action === 'reject' ? 'reject' : 'approve', new Set(c.dismissed));
  if (learned.changes.length) {
    policy.weights = learned.weights;
    await db.save('policy');
    await audit('system', 'policy.weights_learned', id, { changes: learned.changes, from: user.name });
  }
  await db.save('cases');
  await audit(userId, `case.${action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'held'}`, id, { reason, dismissed: c.dismissed, stamp: s.band, risk: s.risk });
  return c;
}
