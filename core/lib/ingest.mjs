// Auto-ingest: turns bill attachments in the mailbox store into checked cases with no
// clicks. Only PDFs that look like bills to pay (an invoice with an amount) are taken;
// receipts and refunds for things already paid are skipped, and so is anything that
// doesn't look like a bill (tickets, agreements). Skipped files stay importable by hand.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { db } from './store.mjs';
import { MAIL_DIR } from './mailbox.mjs';
import { pdfInfo } from './pdftext.mjs';
import { parseFields } from '../../site/js/console/extract.js';
import { createCase } from './cases.mjs';

let running = false;

// File names glue words together ("storereceipt.pdf"), so no word boundary there.
const looksPaidAlready = (name, text) => /(receipt|refund|credit\s*note)/i.test(name) || /\b(payment\s+received|paid\s+in\s+full|amount\s+paid)\b/i.test(text.slice(0, 1500));
const looksLikeBill = (name, text, fields) => Number(fields.amount) > 0 && (/invoice|bill|statement/i.test(name) || /\binvoice\b/i.test(text.slice(0, 2000)));

export async function ingestPending() {
  if (running) return { created: 0, skipped: 0, busy: true };
  running = true;
  let created = 0, skipped = 0;
  try {
    const [mail, policy, cases] = await Promise.all([db.get('mail'), db.get('policy'), db.get('cases')]);
    // The same invoice often rides on several emails (receipt, refund, reminder).
    const domainOf = (e) => String(e ?? '').split('@')[1]?.toLowerCase() ?? '';
    const seenInvoice = (num, from) => num && cases.some((c) => c.fields.number === num && domainOf(c.fields.senderEmail) === domainOf(from));
    for (const m of mail) {
      for (const f of m.files) {
        if (f.caseId || f.skipped || f.mime !== 'application/pdf') continue;
        let text, docMeta;
        try { ({ text, meta: docMeta } = await pdfInfo(await readFile(join(MAIL_DIR, f.stored)))); }
        catch { f.skipped = 'unreadable PDF'; skipped++; continue; }
        const { fields, meta } = parseFields(text, { companyDomain: policy.companyDomain ?? '' });
        if (looksPaidAlready(f.name, text)) { f.skipped = 'receipt or refund for something already paid'; skipped++; continue; }
        if (!looksLikeBill(f.name, text, fields)) { f.skipped = 'doesn’t look like a bill to pay'; skipped++; continue; }
        if (seenInvoice(fields.number, m.from)) { f.skipped = `invoice ${fields.number} already has a case`; skipped++; continue; }
        const buf = await readFile(join(MAIL_DIR, f.stored));
        await createCase({
          userId: 'system',
          file: { name: f.name, mime: f.mime, dataBase64: buf.toString('base64') },
          fields, fieldMeta: meta, text, docMeta,
          mailRef: { messageId: m.messageId, stored: f.stored },
        });
        created++;
      }
    }
    await db.save('mail');
  } finally { running = false; }
  return { created, skipped };
}
