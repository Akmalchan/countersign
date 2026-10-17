// Document-level evidence: what the PDF itself gives away. Pure functions, shared by the
// server and the browser so both stamp the same way.
//
// Three things a forger has a hard time faking:
//   1. Bank numbers carry checksums. A US routing number (ABA) and an IBAN both have a
//      check digit, so a made-up or mistyped number usually fails the math.
//   2. Line items have to add up to the total. "Add a zero to the total" edits rarely
//      bother to fix the rows above it.
//   3. Every PDF records the software that made it (Producer/Creator) and when it was
//      created and last modified. A vendor's billing system makes every bill the same
//      way; a bill run through iLovePDF three days later is a different story.

const money = (n) => `$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Plain labels for the inbox and mailbox lists.
export const SHORT_DOC = { banknum: 'Fake bank number', arith: 'Numbers don’t add up', fingerprint: 'Document edited' };

// ---------- 1. Bank numbers ----------

/** ABA routing checksum: 3(d1+d4+d7) + 7(d2+d5+d8) + (d3+d6+d9) must be a multiple of 10. */
export function abaValid(routing9) {
  const s = String(routing9 ?? '');
  if (!/^\d{9}$/.test(s)) return false;
  const d = [...s].map(Number);
  return (3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + (d[2] + d[5] + d[8])) % 10 === 0;
}

/** ISO 13616 IBAN check: move the first 4 chars to the end, letters to numbers, mod 97 must be 1. */
export function ibanValid(iban) {
  const s = String(iban ?? '').replace(/\s+/g, '').toUpperCase();
  if (s.length < 15 || s.length > 34 || !/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(s)) return false;
  const digits = (s.slice(4) + s.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let rem = 0;
  for (let i = 0; i < digits.length; i += 7) rem = Number(String(rem) + digits.slice(i, i + 7)) % 97;
  return rem === 1;
}

const ROUTING_RE = /\b(?:routing|aba|rtn)\b(?:\s*(?:number|no\.?|num|#))?\s*[:#]?\s*(\d(?:[ -]?\d){5,12})(?!\d)/gi;
// IBANs are printed uppercase, either compact or in groups of 4. The final short group must
// not be a following label like "BIC:".
const IBAN_RE = /\bIBAN\b(?:\s*(?:number|no\.?|#))?\s*[:#]?\s*([A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3}(?![\w:]))?)/g;

export function findBankNumbers(text) {
  const t = String(text ?? '');
  const routing = [...new Set([...t.matchAll(ROUTING_RE)].map((m) => m[1].replace(/\D/g, '')))];
  const iban = [...new Set([...t.matchAll(IBAN_RE)].map((m) => m[1].replace(/\s+/g, '')))];
  return { routing, iban };
}

function checkBank(text) {
  const base = { id: 'banknum', name: 'Bank number checksum' };
  const why = 'US routing numbers have a built-in checksum: 3×(d1+d4+d7) + 7×(d2+d5+d8) + (d3+d6+d9) must end in 0. IBANs use ISO 13616 mod-97: the number must leave a remainder of 1. A made-up number almost always fails.';
  const { routing, iban } = findBankNumbers(text);
  if (!routing.length && !iban.length) return { ...base, status: 'unknown', finding: 'No routing number or IBAN on this bill', why };
  const bad = [
    ...routing.filter((r) => !abaValid(r)).map((r) => r.length === 9 ? `Routing number ${r} fails the ABA checksum` : `Routing number ${r} isn’t 9 digits`),
    ...iban.filter((i) => !ibanValid(i)).map((i) => `IBAN ${i} fails the mod-97 check`),
  ];
  if (bad.length) return { ...base, status: 'flag', severity: 'high', finding: `${bad.join('; ')}: it can’t be a real bank account`, why };
  const ok = [...routing.map((r) => `Routing number ${r} passes the ABA checksum`), ...iban.map((i) => `IBAN ${i} passes the mod-97 check`)];
  return { ...base, status: 'pass', finding: ok.join('; '), why };
}

// ---------- 2. Arithmetic ----------

// Money needs cents ("$4,100.00", "-$5.00", "($5.00)", "1,240.00 USD") so a Qty column like "1" never counts.
const MONEY_CELL = /^(-|\()?\s*(?:US)?\$?\s*(-)?\s*(\d{1,3}(?:,\d{3})+|\d+)\.(\d{2})\)?(?:\s*(?:USD|EUR|GBP))?$/i;
function parseMoney(cell) {
  const m = String(cell).trim().match(MONEY_CELL);
  if (!m) return null;
  const v = Number(m[3].replace(/,/g, '') + '.' + m[4]);
  return m[1] || m[2] ? -v : v;
}
const cellsOf = (line) => line.trim().split(/\s{2,}/).filter(Boolean);
const HEADER_DESC = /^(description|item|items|service|services|details)$/i;
const HEADER_AMT = /^(amount|total|line total|price|amount \(usd\))$/i;
const SUBTOTAL = /^sub\s*-?\s*total\b/i;
const TAX = /^(sales tax|tax|vat|gst|hst)\b/i;
const TOTAL = /^(total|grand total|invoice total|amount due|balance due)\b/i;

/** Reads line items and totals from extractor text (one visual line per line, columns split by 2+ spaces). */
export function parseAmounts(text) {
  const lines = String(text ?? '').split('\n');
  const start = lines.findIndex((l) => { const c = cellsOf(l); return c.some((x) => HEADER_DESC.test(x)) && c.some((x) => HEADER_AMT.test(x)); });
  if (start < 0) return null;
  const items = []; let i = start + 1;
  for (; i < lines.length; i++) {
    const c = cellsOf(lines[i]);
    if (!c.length) continue;
    if (SUBTOTAL.test(c[0]) || TAX.test(c[0]) || TOTAL.test(c[0])) break;
    if (c.length === 1 && parseMoney(c[0]) !== null) return null; // amount split from its row: don't guess
    const amt = c.length >= 2 ? parseMoney(c[c.length - 1]) : null;
    if (amt !== null) items.push({ label: c[0], amount: amt });
  }
  // Totals block: from the end of the items to the first Total line. The amount is the last
  // cell on the label's line, or the next line when the PDF put it on its own line.
  let subtotal = null, tax = null, total = null, unexplained = 0;
  for (; i < lines.length && total === null; i++) {
    const c = cellsOf(lines[i]);
    if (!c.length) continue;
    let amt = c.length >= 2 ? parseMoney(c[c.length - 1]) : null;
    if (amt === null && c.length === 1 && !parseMoney(c[0])) {
      const next = cellsOf(lines[i + 1] ?? '');
      if (next.length === 1 && parseMoney(next[0]) !== null) { amt = parseMoney(next[0]); i++; }
    }
    if (amt === null) continue;
    if (SUBTOTAL.test(c[0])) subtotal ??= amt;
    else if (TAX.test(c[0])) tax = (tax ?? 0) + amt;
    else if (TOTAL.test(c[0])) total = amt;
    else unexplained++; // shipping, discounts, credits: we don't guess their sign
  }
  return { items, subtotal, tax, total, unexplained };
}

const near = (a, b) => Math.abs(a - b) <= 0.01;

function checkArith(text) {
  const base = { id: 'arith', name: 'Line items vs total' };
  const why = 'Adds up the line items and compares them with the subtotal, tax and total printed on the bill. Editing just the total (for example adding a zero) leaves the rows above it disagreeing.';
  const p = parseAmounts(text);
  if (!p || !p.items.length || p.total === null) return { ...base, status: 'unknown', finding: 'Couldn’t read the line items and total on this bill', why };
  const sum = Math.round(p.items.reduce((a, x) => a + x.amount, 0) * 100) / 100;
  const n = p.items.length;
  const itemsWord = n > 1 ? `${n} line items add` : '1 line item adds';
  if (near(sum, p.total)) return { ...base, status: 'pass', finding: `${itemsWord} up to the ${money(p.total)} total`, why };
  const sev = (gap) => (Math.abs(gap) > Math.abs(p.total) * 0.01 ? 'high' : 'med');
  if (p.subtotal !== null && !near(sum, p.subtotal) && !p.unexplained) {
    return { ...base, status: 'flag', severity: sev(sum - p.subtotal), finding: `Line items add up to ${money(sum)} but the subtotal says ${money(p.subtotal)}`, why };
  }
  if (p.subtotal !== null && near(sum, p.subtotal)) {
    if (p.tax !== null && near(p.subtotal + p.tax, p.total)) return { ...base, status: 'pass', finding: `${itemsWord.replace(/ adds?$/, '')} plus ${money(p.tax)} tax add up to the ${money(p.total)} total`, why };
    if (p.tax === null && !p.unexplained) return { ...base, status: 'flag', severity: sev(p.total - sum), finding: `Line items add up to ${money(sum)} but the total says ${money(p.total)}`, why };
    if (p.tax !== null && !p.unexplained) return { ...base, status: 'flag', severity: sev(p.total - p.subtotal - p.tax), finding: `Subtotal ${money(p.subtotal)} plus ${money(p.tax)} tax is ${money(p.subtotal + p.tax)}, but the total says ${money(p.total)}`, why };
  }
  // No subtotal/tax lines between items and total: a plain items -> total bill.
  if (p.subtotal === null && p.tax === null && !p.unexplained) {
    return { ...base, status: 'flag', severity: sev(p.total - sum), finding: `Line items add up to ${money(sum)} but the total says ${money(p.total)}`, why };
  }
  return { ...base, status: 'unknown', finding: 'The bill has adjustments (shipping, discounts or credits) we can’t check line by line', why };
}

// ---------- 3. PDF fingerprint ----------

// Tools people use to edit an existing PDF, not to generate one.
export const EDITORS = [
  [/ilovepdf/i, 'iLovePDF'], [/smallpdf/i, 'Smallpdf'], [/sejda/i, 'Sejda'], [/pdfescape/i, 'PDFescape'],
  [/pdf-?xchange/i, 'PDF-XChange'], [/pdfelement|wondershare/i, 'PDFelement'], [/phantompdf/i, 'Foxit PhantomPDF'],
  [/nitro/i, 'Nitro PDF'], [/acrobat pro/i, 'Adobe Acrobat Pro'], [/pdffiller/i, 'pdfFiller'], [/docfly/i, 'DocFly'],
];

function normTool(s) {
  let t = String(s ?? '').trim();
  // Browser user agents: keep just the browser and its major version.
  const ua = t.match(/\b(HeadlessChrome|Chrome|Firefox|Edg|Safari)\/(\d+)/);
  if (/^Mozilla\/\d/.test(t) && ua) t = `${ua[1]} ${ua[2]}`;
  return t.toLowerCase()
    .replace(/\((?:https?:\/\/|www\.)[^)]*\)/g, ' ')  // "(https://github.com/...)"
    .replace(/[©®™]\s*[\d-]*/g, ' ')
    .replace(/\b(\d+)(?:\.\d+)+\b/g, '$1')           // 7.1.14 -> 7
    .replace(/\s+/g, ' ').trim();
}

/** "producer: skia/pdf m155 | creator: headlesschrome 155". Same tool family + major version matches. */
export function pdfFingerprint(meta) {
  if (!meta) return '';
  return `producer: ${normTool(meta.Producer) || 'none'} | creator: ${normTool(meta.Creator) || 'none'}`;
}

// Fingerprints match exactly, or as the same tool family ignoring version numbers, so a
// vendor whose billing system upgrades Chrome every month doesn't trip the flag.
const family = (fp) => String(fp).replace(/\d+/g, '#');
export const sameFingerprint = (a, b) => a === b || family(a) === family(b);

/** PDF date "D:20261016123000-07'00'" -> ms since epoch, or null. */
export function parsePdfDate(s) {
  const m = String(s ?? '').match(/^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?\s*(Z|[+-])?(\d{2})?'?(\d{2})?'?/);
  if (!m) return null;
  const [, y, mo = '01', d = '01', h = '00', mi = '00', se = '00', sign, oh = '00', om = '00'] = m;
  const ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se);
  if (Number.isNaN(ms)) return null;
  const off = sign === '+' || sign === '-' ? (sign === '+' ? 1 : -1) * (+oh * 60 + +om) * 60000 : 0;
  return ms - off;
}

const pretty = (s) => s.replace(/\bpdf\b/g, 'PDF').replace(/^./, (c) => c.toUpperCase());
const toolName = (fp) => { const t = String(fp).match(/producer: ([^|]+?) \|/)?.[1] ?? fp; return t === 'none' ? 'no software name' : pretty(t); };
// "pdf-lib (https://github.com/...); modified using iText..." -> "pdf-lib"
const displayTool = (meta) => String(meta.Producer || meta.Creator || '').split(/[;(]/)[0].trim() || 'no software name';
function ago(ms) {
  const h = ms / 3600000;
  if (h < 48) { const n = Math.round(h); return `${n} hour${n === 1 ? '' : 's'}`; }
  const d = Math.round(h / 24); return `${d} days`;
}

function checkFingerprint(meta, vendor) {
  const base = { id: 'fingerprint', name: 'Document history' };
  const why = 'Every PDF records the software that made it and when it was created and last changed. A vendor’s billing system makes every bill the same way, so a different tool, a PDF editor, or an edit days later means someone changed the file after it was issued.';
  if (!meta || typeof meta !== 'object') return { ...base, status: 'unknown', finding: 'No document metadata to compare', why };
  const fp = pdfFingerprint(meta);
  const known = (vendor?.docFingerprints ?? []).filter(Boolean);
  const matchesHistory = known.some((k) => sameFingerprint(k, fp));
  const reasons = [];
  if (known.length && !matchesHistory) reasons.push(`Made with ${displayTool(meta)}; this vendor’s past bills were made with ${[...new Set(known.map(toolName))].join(' or ')}`);
  const editor = EDITORS.find(([re]) => re.test(`${meta.Producer ?? ''} ${meta.Creator ?? ''}`));
  if (editor && !matchesHistory) {
    if (reasons.length) reasons[0] = reasons[0].replace(`Made with ${displayTool(meta)}`, `Made with ${editor[1]}, a PDF editor`);
    else reasons.push(`Made with ${editor[1]}, a PDF editor`);
  }
  const created = parsePdfDate(meta.CreationDate), modified = parsePdfDate(meta.ModDate);
  if (created !== null && modified !== null && modified - created > 3600000) reasons.push(`Edited ${ago(modified - created)} after it was created`);
  if (reasons.length) return { ...base, status: 'flag', severity: 'med', finding: reasons.join('. '), why, fingerprint: fp };
  return { ...base, status: 'pass', finding: known.length ? 'Same software as this vendor’s past bills; no signs of editing' : (meta.Producer || meta.Creator ? `Made with ${displayTool(meta)}; no signs of editing` : 'No signs of editing (no software name recorded)'), why, fingerprint: fp };
}

// ---------- Combined ----------

/**
 * @param {{text:string, meta?:{Producer?,Creator?,CreationDate?,ModDate?}, fields?:object, vendor?:{docFingerprints?:string[]}}} doc
 * @returns {{checks: Array<{id,name,status,severity?,finding,why}>, forcesHold: boolean, forcesStop: boolean}}
 */
export function analyzeDocument({ text, meta, fields, vendor } = {}) {
  const checks = [checkBank(text), checkArith(text), checkFingerprint(meta, vendor)];
  const flagged = (id) => checks.some((c) => c.id === id && c.status === 'flag');
  return {
    checks,
    forcesHold: checks.some((c) => c.status === 'flag'),
    forcesStop: flagged('banknum') || (flagged('arith') && flagged('fingerprint')),
  };
}

/** The same analysis with the checks a person marked as false alarms taken out. */
export function withoutDismissed(analysis, dismissed) {
  if (!analysis) return analysis;
  const ds = dismissed instanceof Set ? dismissed : new Set(dismissed ?? []);
  const flags = analysis.checks.filter((c) => c.status === 'flag' && !ds.has(c.id));
  const has = (id) => flags.some((c) => c.id === id);
  return { ...analysis, forcesHold: flags.length > 0, forcesStop: has('banknum') || (has('arith') && has('fingerprint')) };
}

/** Document evidence can only make a stamp stricter, never looser. */
export function applyDocument(s, analysis) {
  if (!analysis) return s;
  const out = { ...s };
  if (analysis.forcesStop && out.band !== 'stop') {
    out.band = 'stop'; out.reason = 'The document itself looks forged or edited. Do not pay.';
  } else if (analysis.forcesHold && out.band === 'clear') {
    out.band = 'hold'; out.reason = 'The bill looks fine, but the PDF itself has a red flag. A human needs to look.';
  }
  return out;
}
