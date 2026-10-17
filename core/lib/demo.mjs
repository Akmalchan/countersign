// Sample emails for demos. These are NEVER sent through real email: they're written
// straight into the console's mailbox store, marked demo:true and "[SAMPLE]", from a
// made-up vendor on reserved .example domains (RFC 2606: no real company can own them).
// Their vendor intel is sample data too, so no live lookups are made for them.

import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { db, newId } from './store.mjs';
import { analyzeEmail } from '../../site/js/console/mailrules.js';
import { MAIL_DIR } from './mailbox.mjs';

const SAMPLES = new URL('../../site/samples/', import.meta.url).pathname;

export const DEMO_VENDOR = {
  name: 'Northwind Logistics',
  domain: 'northwind-logistics.example',
  bankLast4: '3310',
  history: [5200, 4980, 5410, 5150],
  address: '88 Pier Rd, Oakland, CA',
  paidInvoices: ['NW-1102', 'NW-1131', 'NW-1166', 'NW-1190'],
  phone: '+1 510 555 0142',
  docFingerprints: ['producer: skia/pdf m155 | creator: headlesschrome 155'],
};

export const DEMO_INTEL = {
  'northwind-logistics.example': { summary: 'Sample data: Northwind Logistics · founded 2011 · ~140 employees', domainAgeDays: 5000, hasProfile: true, founded: 2011, employees: 140, scamReports: 0 },
  'n0rthwind-logistics.example': { summary: 'Sample data: no company profile · domain registered 6 days ago', domainAgeDays: 6, hasProfile: false, scamReports: 0 },
};

const EMAILS = [
  {
    file: 'sample-northwind-october.pdf',
    subject: '[SAMPLE] Invoice NW-1214 from Northwind Logistics',
    from: 'billing@northwind-logistics.example', fromName: 'Northwind Logistics Billing', replyTo: null,
    auth: { spf: 'pass', dkim: 'pass', dmarc: 'pass' },
    snippet: 'Hi, please find attached invoice NW-1214 for October freight and storage, due Nov 1. Thanks, Northwind Billing',
  },
  {
    file: 'sample-northwind-lookalike.pdf',
    subject: '[SAMPLE] URGENT: Final notice, invoice NW-1219 (new bank details)',
    from: 'billing@n0rthwind-logistics.example', fromName: 'Northwind Logistics Billing', replyTo: 'accounts@nw-payments.example',
    auth: { spf: 'softfail', dkim: 'none', dmarc: 'fail' },
    snippet: 'Your account will be suspended today. We changed our bank, wire the attached invoice to the new account. Do not call our office.',
  },
  {
    file: 'sample-northwind-tampered.pdf',
    subject: '[SAMPLE] Invoice NW-1221 from Northwind Logistics',
    from: 'billing@northwind-logistics.example', fromName: 'Northwind Logistics Billing', replyTo: null,
    auth: { spf: 'pass', dkim: 'pass', dmarc: 'pass' },
    snippet: 'Hi, attached is invoice NW-1221 for October freight. Same account as always. Thanks, Northwind Billing',
  },
];

export async function loadDemoEmails() {
  await db.update('vendors', (vendors) => {
    const v = vendors.find((x) => x.domain === DEMO_VENDOR.domain);
    if (!v) vendors.push({ key: newId('v'), ...DEMO_VENDOR, createdAt: new Date().toISOString() });
    else { if (!v.docFingerprints?.length) v.docFingerprints = DEMO_VENDOR.docFingerprints; if (!v.phone) v.phone = DEMO_VENDOR.phone; }
  });
  await mkdir(MAIL_DIR, { recursive: true });
  const added = [];
  await db.update('mail', async (mail) => {
    for (const e of EMAILS) {
      const key = newId('demo').replace('demo-', 'd');
      const stored = `${key}-0.pdf`;
      await copyFile(join(SAMPLES, e.file), join(MAIL_DIR, stored));
      const rec = {
        messageId: `<${key}@samples.countersign.local>`, key, uid: null, demo: true,
        date: new Date().toISOString(), subject: e.subject, from: e.from, fromName: e.fromName, replyTo: e.replyTo,
        auth: e.auth, analysis: analyzeEmail(e), snippet: e.snippet,
        files: [{ name: e.file.replace('sample-', ''), mime: 'application/pdf', size: 0, stored, caseId: null }],
        syncedAt: new Date().toISOString(),
      };
      mail.unshift(rec); added.push(rec);
    }
  });
  return added;
}
