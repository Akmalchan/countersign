// Reads a real bill (PDF or image) into fields, in the browser.
//   PDF   → pdf.js text layer (exact text, no OCR needed for digital invoices)
//   Image → tesseract.js OCR
// Then deterministic rules pull out each field and say how sure they are.
// Nothing is guessed silently: low-confidence fields are marked for a human to confirm.

let pdfjs = null;
async function loadPdfjs() {
  if (pdfjs) return pdfjs;
  pdfjs = await import('../../vendor/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('../../vendor/pdf.worker.min.mjs', import.meta.url).href;
  return pdfjs;
}

let tesseractReady = null;
function loadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  tesseractReady ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = new URL('../../vendor/tesseract.min.js', import.meta.url).href;
    s.onload = () => resolve(window.Tesseract);
    s.onerror = () => reject(new Error('could not load the OCR engine'));
    document.head.append(s);
  });
  return tesseractReady;
}

// Group pdf.js text items into visual lines (same baseline), left to right.
// Exported so the server (auto-ingest) reads PDFs exactly like the browser does.
export function itemsToLines(items) {
  const rows = [];
  for (const it of items) {
    if (!it.str?.trim()) continue;
    const y = it.transform[5], x = it.transform[4];
    let row = rows.find((r) => Math.abs(r.y - y) < 3);
    if (!row) { row = { y, parts: [] }; rows.push(row); }
    // Some invoice fonts (Stripe's, for one) map "-" to U+0000 in the text layer.
    row.parts.push({ x, s: it.str.replace(/\u0000/g, '-') });
  }
  rows.sort((a, b) => b.y - a.y);
  return rows.map((r) => r.parts.sort((a, b) => a.x - b.x).map((p) => p.s).join('  ').replace(/\s{3,}/g, '  ').trim());
}

// Re-join IDs that the text layer split around a hyphen: "XCIOXBLS  -  0004" → "XCIOXBLS-0004".
export function joinPdfLines(lines) {
  return lines.join('\n').replace(/\b([A-Z0-9]{2,})[ \t]+-[ \t]+(\d{2,})\b/g, '$1-$2');
}

export async function readDocument(file, onStep = () => {}) {
  const buf = await file.arrayBuffer();
  if (file.type === 'application/pdf') {
    onStep('Reading PDF text');
    const lib = await loadPdfjs();
    const doc = await lib.getDocument({ data: new Uint8Array(buf.slice(0)) }).promise;
    const lines = [];
    for (let p = 1; p <= Math.min(doc.numPages, 4); p++) {
      const page = await doc.getPage(p);
      lines.push(...itemsToLines((await page.getTextContent()).items));
    }
    const info = (await doc.getMetadata().catch(() => ({})))?.info ?? {};
    const meta = Object.fromEntries(['Producer', 'Creator', 'CreationDate', 'ModDate'].filter((k) => info[k]).map((k) => [k, String(info[k]).slice(0, 200)]));
    return { kind: 'pdf', method: 'PDF text layer', text: joinPdfLines(lines), buf, meta };
  }
  if (/^image\/(png|jpe?g|webp)$/.test(file.type)) {
    onStep('Running OCR on the image');
    const T = await loadTesseract();
    const { data } = await T.recognize(file, 'eng');
    return { kind: 'image', method: `OCR (${Math.round(data.confidence)}% confidence)`, text: data.text, buf, ocrConfidence: data.confidence };
  }
  throw new Error('Upload a PDF, PNG, JPEG or WebP');
}

// ---------------------------------------------------------------------------
// Field rules
// ---------------------------------------------------------------------------

const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const MONEY = /\$?\s?(\d{1,3}(?:,\d{3})+(?:\.\d{2})?|\d+\.\d{2})/g;
const DATE = /([A-Z][a-z]{2,8}\.?\s\d{1,2},?\s?\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}-\d{2}-\d{2}|today|immediately|upon receipt|due on receipt)/i;
const STREET = /\b\d{1,6}\s+[A-Za-z0-9.'\- ]+?\b(St|Street|Ave|Avenue|Blvd|Boulevard|Rd|Road|Way|Pkwy|Parkway|Dr|Drive|Ln|Lane|Plaza|Ct|Court|Pl|Place|Hwy|Sq|Square)\b\.?[^\n]*/i;

const money = (s) => Number(String(s).replace(/[^0-9.]/g, ''));
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

function after(lines, re, valueRe) {
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (!m) continue;
    const rest = lines[i].slice(m.index + m[0].length);
    const v = rest.match(valueRe) ?? lines[i + 1]?.match(valueRe);
    if (v) return v[1] ?? v[0];
  }
  return null;
}

/**
 * @param {string} text   raw document text
 * @param {{companyDomain?: string}} opts   our own domain, so the bill-to block is ignored
 * @returns {{fields: object, meta: Record<string,{confidence:'high'|'medium'|'low', rule:string}>}}
 */
export function parseFields(text, { companyDomain = '' } = {}) {
  // Keep double spaces: they're the column gaps between left and right blocks.
  const lines = text.split(/\n/).map((l) => l.replace(/[ \t]{3,}/g, '  ').replace(/[ \t]? /g, ' ').trim()).filter(Boolean);
  const fields = {}; const meta = {};
  const set = (k, v, confidence, rule) => { fields[k] = v ?? ''; meta[k] = { confidence: v ? confidence : 'low', rule: v ? rule : 'not found, needs a human' }; };

  // Sender email: first email that isn't ours (ours is the bill-to block).
  const emails = [...text.matchAll(EMAIL)].map((m) => m[0].toLowerCase());
  const own = companyDomain.toLowerCase();
  const sender = emails.find((e) => !own || !e.endsWith('@' + own) && !e.endsWith('.' + own));
  set('senderEmail', sender, 'high', 'first email that isn’t your company’s');

  // Bill-to block starts where our company or "bill to" appears; vendor info is above it.
  // Two-column layouts (Stripe, many SaaS) put the vendor block on the LEFT of the same
  // rows as "Bill to", so we also take the left-hand segment of the rows that follow.
  const billTo = lines.findIndex((l) => /bill(ed)?\s*to|ship\s*to|customer/i.test(l));
  let head = billTo > 0 ? lines.slice(0, billTo) : lines.slice(0, 8);
  let leftOfBillTo = null;
  if (billTo >= 0) {
    const left = lines[billTo].split(/bill(ed)?\s*to|ship\s*to/i)[0].trim();
    leftOfBillTo = left || null;
    if (left) {
      const leftCol = [left];
      for (const l of lines.slice(billTo + 1, billTo + 7)) {
        const seg = l.split(/\s{2,}/)[0].trim();
        if (!seg || EMAIL.test(seg)) { EMAIL.lastIndex = 0; break; }
        leftCol.push(seg);
      }
      EMAIL.lastIndex = 0;
      head = [...head, ...leftCol];
    }
  }

  // Vendor name: first header line that isn't the word "invoice", an email, a date or an address.
  const LABEL = /^(no\.?|number|#|date|due|page|invoice\s*(no|number|#)|receipt|statement|billing\s*period|team\s*name|customer|account|po\b|order)\b/i;
  const tidyName = (s) => clean(String(s ?? '').replace(/\(?@[\w.-]+\)?/g, '').replace(/[,;:]+$/, ''));
  let nameLine, nameRule;
  if (leftOfBillTo) {
    // Two-column layout: the vendor's name opens the left block on the "Bill to" row.
    nameLine = leftOfBillTo.split(/\s{2,}/)[0]; nameRule = 'left of “Bill to” (two-column invoice)';
  } else {
    nameLine = head.map((l) => l.replace(/\b(tax\s+)?invoice\b/ig, '').replace(EMAIL, '').split(/\s{2,}/)[0]?.trim() ?? '')
      .find((l) => l.length >= 2 && l.length <= 60 && !STREET.test(l) && !DATE.test(l) && !LABEL.test(l) && !/^@/.test(l) && /[a-z]/i.test(l));
    nameRule = 'first line of the letterhead';
  }
  set('vendorName', tidyName(nameLine?.split(/Invoice No|Issue date|Due date/i)[0]) || '', 'medium', nameRule);

  // Address: first street-looking line in the vendor's header, plus the city line under it.
  const ai = head.findIndex((l) => STREET.test(l.split(/\s{2,}/)[0]));
  let addr = ai >= 0 ? clean(head[ai].split(/\s{2,}/)[0].match(STREET)?.[0] ?? head[ai].split(/\s{2,}/)[0]) : null;
  // Pull in a suite line ("Ste 300") and the city line under the street.
  for (let j = ai + 1; addr && j <= ai + 2 && j < head.length; j++) {
    const next = clean(head[j].split(/\s{2,}/)[0]);
    if (/^(ste|suite|unit|apt|fl|floor|#)\b/i.test(next)) { addr = `${addr} ${next}`; continue; }
    if (/^[A-Z][A-Za-z .'-]+,\s*[A-Za-z .]+/.test(next) && !STREET.test(next)) addr = `${addr}, ${next}`;
    break;
  }
  set('address', addr, 'medium', 'first street address in the vendor block');

  // Invoice number.
  const num = after(lines, /invoice\s*(no\.?|number|#)\s*:?/i, /([A-Z0-9][A-Z0-9-]{2,})/i)
    ?? text.match(/\b([A-Z]{2,4}-\d{3,8})\b/)?.[1];
  set('number', num, /invoice\s*(no|number|#)/i.test(text) ? 'high' : 'medium', 'value next to “Invoice No.”');

  // Total: the money on a "total / amount due / balance due" line; else the largest amount.
  let total = null, totalRule = '';
  for (let i = 0; i < lines.length; i++) {
    if (!/(total\s*due|amount\s*due|balance\s*due|total\s*\(|grand\s*total|^total\b)/i.test(lines[i])) continue;
    // The number is usually on the same line; in PDFs a bigger font can push it a line up or down.
    for (const l of [lines[i], lines[i + 1], lines[i - 1]]) {
      const ms = l ? [...l.matchAll(MONEY)] : [];
      if (ms.length) { total = money(ms[ms.length - 1][1]); totalRule = 'amount on the “Total due” line'; break; }
    }
  }
  if (!total) {
    const all = [...text.matchAll(MONEY)].map((m) => money(m[1])).filter((n) => n > 0);
    if (all.length) { total = Math.max(...all); totalRule = 'largest amount on the bill (no “total” label found)'; }
  }
  set('amount', total ? String(total) : '', totalRule.startsWith('amount on') ? 'high' : 'low', totalRule);
  fields.currency = /€|EUR\b/.test(text) ? 'EUR' : /£|GBP\b/.test(text) ? 'GBP' : 'USD';

  // Dates.
  set('issued', after(lines, /((issue|invoice)\s*date|date\s*of\s*issue)\s*:?/i, DATE), 'high', 'value next to “Issue date”');
  set('due', after(lines, /(due\s*date|payment\s*due|due)\s*:?/i, DATE), 'high', 'value next to “Due date”');

  // Bank account: IBAN, else the digits after "account number".
  const iban = text.match(/\b([A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}(?:\s?[A-Z0-9]{1,4})?)\b/);
  const acct = iban?.[1] ?? after(lines, /(account\s*(number|no\.?|#)|acct\.?\s*(no\.?|#)?)\s*:?/i, /([0-9][0-9 \-]{3,})/);
  const digits = acct ? acct.replace(/[^0-9A-Z]/gi, '') : '';
  set('bankLast4', digits.length >= 4 ? digits.slice(-4) : '', 'high', iban ? 'last 4 of the IBAN' : 'last 4 of “Account number”');

  // The whole text is what the pressure-language check reads.
  fields.body = clean(text).slice(0, 4000);
  meta.body = { confidence: 'high', rule: 'full document text' };
  return { fields, meta };
}
