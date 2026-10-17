// Countersign engine: deterministic invoice checks. No LLM in here.
// Every check returns { id, status: 'pass'|'flag'|'unknown', severity, finding, why, evidence[] }.
// The score is a pure function of those results and the current weights.

export const CHECKS = [
  { id: 'lookalike', name: 'Lookalike sender', plain: 'Is the email really from the company it claims?' },
  { id: 'bank', name: 'Bank details changed', plain: 'Is the money going somewhere new?' },
  { id: 'amount', name: 'Amount anomaly', plain: 'Is this bill way bigger than usual?' },
  { id: 'footprint', name: 'Vendor footprint', plain: 'Does this company actually exist?' },
  { id: 'address', name: 'Address & phone', plain: 'Do the contact details match the real company?' },
  { id: 'pressure', name: 'Pressure language', plain: 'Is the bill rushing you?' },
  { id: 'duplicate', name: 'Duplicate', plain: 'Have we paid this exact bill before?' },
  { id: 'reports', name: 'Scam reports', plain: 'Has anyone reported this sender?' },
];

export const POINTS = { med: 12, high: 24 };

export const DEFAULT_WEIGHTS = Object.fromEntries(CHECKS.map((c) => [c.id, 1]));

const HOMOGLYPHS = [
  ['rn', 'm'], ['vv', 'w'], ['0', 'o'], ['1', 'l'], ['3', 'e'], ['5', 's'], ['7', 't'], ['@', 'a'],
];

// Manipulation tactics, each phrase weighted by its category.
const PRESSURE_CATEGORIES = [
  { label: 'urgency', weight: 1, terms: ['urgent', 'immediately', 'today', 'within 24 hours', 'final notice', 'overdue', 'avoid suspension', 'suspended', 'asap'] },
  { label: 'secrecy', weight: 2, terms: ['do not call', "don't call", 'confidential', 'keep this between', 'by email only', 'reachable by email only', 'do not contact'] },
  { label: 'payment change', weight: 2, terms: ['new bank', 'changed our bank', 'updated banking', 'new account', 'wire', 'change of bank details'] },
  { label: 'authority / threat', weight: 1, terms: ['legal action', 'collections', 'lawyer', 'ceo', 'director'] },
];

export function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[m][n];
}

// Damerau–Levenshtein (optimal string alignment): like levenshtein, but swapping two neighbours costs 1.
export function damerauLevenshtein(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[m][n];
}

export function normalizeLabel(label) {
  let s = label.toLowerCase();
  for (const [from, to] of HOMOGLYPHS) s = s.split(from).join(to);
  return s;
}

function domainOf(email) {
  return (email.split('@')[1] || '').toLowerCase();
}

// Registrable part, good enough for the demo: last two labels.
function registrable(domain) {
  return domain.split('.').slice(-2).join('.');
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const usd = (n) => '$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 });

// ---- the eight checks -------------------------------------------------------

function checkLookalike(inv, vendor) {
  const sender = domainOf(inv.senderEmail);
  const evidence = [{ source: 'Invoice email', value: inv.senderEmail }];
  if (!vendor) {
    return { status: 'pass', finding: `No known brand imitated by ${sender}`, why: 'New vendor: compared against the top-brand list, nothing within 2 edits.', evidence };
  }
  evidence.push({ source: 'Vendor master', value: `known domain: ${vendor.domain}` });
  if (registrable(sender) === registrable(vendor.domain)) {
    return { status: 'pass', finding: `Sent from ${sender}, the vendor's real domain`, why: `registrable(${sender}) = ${registrable(vendor.domain)}`, evidence };
  }
  const brand = normalizeLabel(vendor.domain.split('.')[0]);
  const labels = sender.split('.').flatMap((l) => l.split('-')).map(normalizeLabel);
  const best = Math.min(...labels.map((l) => (l.includes(brand) ? 0 : levenshtein(l, brand))));
  if (best <= 2) {
    return {
      status: 'flag', severity: 'high',
      finding: `${sender} imitates ${vendor.domain}`,
      why: `After swapping lookalike characters (0→o, 1→l, rn→m), "${sender}" contains "${brand}" (edit distance ${best}) but is not ${vendor.domain}.`,
      evidence,
    };
  }
  return { status: 'flag', severity: 'med', finding: `Sender ${sender} isn't the vendor's usual domain`, why: `Expected ${vendor.domain}, got ${sender}.`, evidence };
}

function checkBank(inv, vendor) {
  const evidence = [{ source: 'Invoice', value: `pay to account ••${inv.bankLast4}` }];
  if (!inv.bankLast4) return { status: 'unknown', finding: 'No bank account on this bill', why: 'Paid by card or an online link, so there is no account number to compare.', evidence: [{ source: 'Invoice', value: 'no bank account listed' }] };
  if (!vendor) return { status: 'unknown', finding: 'No payment history for this vendor', why: 'First invoice: nothing to compare the bank account against.', evidence };
  evidence.push({ source: 'Vendor master', value: `last paid to ••${vendor.bankLast4}` });
  if (inv.bankLast4 === vendor.bankLast4) return { status: 'pass', finding: `Same account as every past payment (••${vendor.bankLast4})`, why: 'invoice.account = vendor_master.account', evidence };
  return { status: 'flag', severity: 'high', finding: `Account changed: ••${vendor.bankLast4} → ••${inv.bankLast4}`, why: 'A changed bank account is the single most common sign of invoice-redirect fraud. Verify by calling a number you already have.', evidence };
}

function checkAmount(inv, vendor) {
  if (!vendor || vendor.history.length < 3) {
    return { status: 'unknown', finding: 'Not enough past invoices to judge the amount', why: 'Needs at least 3 previous invoices.', evidence: [{ source: 'Vendor master', value: vendor ? `${vendor.history.length} past invoices` : 'no history' }] };
  }
  const med = median(vendor.history);
  const ratio = inv.amount / med;
  const evidence = [{ source: 'Vendor master', value: `past: ${vendor.history.map(usd).join(', ')}` }];
  // Robust z-score (Iglewicz–Hoaglin): median and MAD, so one odd past bill can't skew the baseline.
  const mad = median(vendor.history.map((x) => Math.abs(x - med)));
  if (mad === 0) {
    // All past bills identical: z is undefined, fall back to the plain ratio.
    const why = `All past bills were identical (MAD = 0), so ratio = ${usd(inv.amount)} ÷ median ${usd(med)} = ${ratio.toFixed(1)}×  (flag > 3×, high > 8×)`;
    if (ratio > 8) return { status: 'flag', severity: 'high', finding: `${ratio.toFixed(1)}× the usual amount`, why, evidence };
    if (ratio > 3) return { status: 'flag', severity: 'med', finding: `${ratio.toFixed(1)}× the usual amount`, why, evidence };
    return { status: 'pass', finding: `In line with past bills (${ratio.toFixed(1)}× median)`, why, evidence };
  }
  const z = (0.6745 * (inv.amount - med)) / mad;
  const zs = Math.abs(z) >= 10 ? String(Math.round(z)) : z.toFixed(1);
  const why = `z = 0.6745 × (${usd(inv.amount)} − ${usd(med)}) ÷ MAD ${usd(mad)} = ${zs}  (flag > 3.5, high > 8; also needs > 1.5× / > 3× the median)`;
  // Only bills bigger than usual count; the ratio guard stops tiny-variance vendors flagging small bumps.
  if (z > 8 && ratio > 3) return { status: 'flag', severity: 'high', finding: `${ratio.toFixed(1)}× the usual amount (robust z = ${zs})`, why, evidence };
  if (z > 3.5 && ratio > 1.5) return { status: 'flag', severity: 'med', finding: `${ratio.toFixed(1)}× the usual amount (robust z = ${zs})`, why, evidence };
  return { status: 'pass', finding: `In line with past bills (${ratio.toFixed(1)}× median)`, why, evidence };
}

function checkFootprint(inv, intel) {
  const sender = domainOf(inv.senderEmail);
  const d = intel[sender];
  const evidence = [{ source: 'Glasser · company_intelligence', value: d ? d.summary : `no record for ${sender}` }];
  if (!d) return { status: 'unknown', finding: `No public data for ${sender}`, why: 'Unknown is reported as unknown, never guessed.', evidence };
  if (d.notRegistered) {
    return { status: 'flag', severity: 'high', finding: `${sender} isn't a registered domain`, why: 'The domain registry (RDAP) has no record of it. A real vendor bills from a domain that exists.', evidence };
  }
  if (d.domainAgeDays !== null && d.domainAgeDays < 30) {
    return { status: 'flag', severity: 'high', finding: `Domain registered ${d.domainAgeDays} days ago`, why: 'domain_age < 30 days, no company profile, no measurable traffic.', evidence };
  }
  if (!d.hasProfile) return { status: 'flag', severity: 'med', finding: 'No company profile found', why: 'Real vendors almost always have a firmographic record.', evidence };
  return { status: 'pass', finding: `Real company: founded ${d.founded}, ~${d.employees} people`, why: 'Profile found, domain older than 1 year, measurable traffic.', evidence };
}

function checkAddress(inv, vendor, intel) {
  const sender = domainOf(inv.senderEmail);
  const place = intel[sender]?.place;
  if (!inv.address) return { status: 'unknown', finding: 'No address on this bill', why: 'Nothing to compare: the bill doesn’t list a vendor address.', evidence: [{ source: 'Invoice', value: 'no address found' }] };
  if (!vendor && !place) return { status: 'unknown', finding: 'No address on record to compare', why: 'Ask for a W-9 and verify the address independently.', evidence: [{ source: 'Glasser · web_research (places)', value: 'no listing found' }] };
  const expected = vendor ? vendor.address : place;
  const evidence = [{ source: 'Invoice', value: inv.address }, { source: vendor ? 'Vendor master' : 'Glasser · web_research (places)', value: expected }];
  // Compare the street line (before the first comma): "Covina, CA" vs "Covina, California 91723" is the same place.
  const norm = (s) => String(s ?? '').split(',')[0].toLowerCase().replace(/[^a-z0-9]/g, '');
  if (norm(inv.address) === norm(expected)) return { status: 'pass', finding: 'Address matches the record', why: 'street line of invoice.address = street line of record.address (ignoring spacing and punctuation)', evidence };
  return { status: 'flag', severity: 'med', finding: 'Address doesn’t match the real company', why: `Invoice says "${inv.address}", record says "${expected}".`, evidence };
}

function checkPressure(inv) {
  const text = inv.body.toLowerCase().replace(/[\u2018\u2019]/g, "'");
  // Whole words only, so "rewired" isn't "wire" and "ceos" in a URL isn't "ceo".
  const has = (t) => new RegExp(`(?<![a-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`).test(text);
  let hits = PRESSURE_CATEGORIES.flatMap((c) => c.terms.filter(has).map((term) => ({ term, cat: c })));
  // A phrase inside a longer matched phrase ("by email only" in "reachable by email only") counts once.
  hits = hits.filter((h) => !hits.some((o) => o.term !== h.term && o.term.includes(h.term)));
  const cats = PRESSURE_CATEGORIES.filter((c) => hits.some((h) => h.cat === c));
  const total = hits.reduce((s, h) => s + h.cat.weight, 0);
  const combo = cats.some((c) => c.label === 'secrecy') && cats.some((c) => c.label === 'payment change');
  const evidence = [{ source: 'Invoice text', value: hits.length ? hits.map((h) => `"${h.term}"`).join(', ') : 'no pressure terms' }];
  const why = `score = Σ category weights = ${total}  (flag ≥ 2, high ≥ 4, or secrecy + payment change)`;
  const finding = `Pressure tactics: ${cats.map((c) => c.label).join(', ')}`;
  if (total >= 4 || combo) return { status: 'flag', severity: 'high', finding, why, evidence };
  if (total >= 2) return { status: 'flag', severity: 'med', finding, why, evidence };
  return { status: 'pass', finding: 'Normal, calm wording', why, evidence };
}

function checkDuplicate(inv, vendor) {
  const paid = vendor?.paidInvoices || [];
  const evidence = [{ source: 'Payment log', value: paid.length ? `${paid.length} invoices paid` : 'nothing paid yet' }];
  const key = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, '');
  const mine = key(inv.number);
  if (paid.some((p) => key(p) === mine)) return { status: 'flag', severity: 'high', finding: `${inv.number} was already paid`, why: 'Same invoice number found in the payment log.', evidence };
  // Fuzzy: a resubmitted bill often has one character added, dropped, swapped or changed.
  const near = mine.length >= 4 && paid.find((p) => {
    const k = key(p);
    if (k.length < 4) return false;
    if (damerauLevenshtein(mine, k) !== 1) return false;
    // One digit changed for another is just the vendor's next sequential number (VC-2541 → VC-2542), not a resubmission.
    const diff = [...mine].map((ch, i) => i).filter((i) => mine.length === k.length && mine[i] !== k[i]);
    return !(diff.length === 1 && /\d/.test(mine[diff[0]]) && /\d/.test(k[diff[0]]));
  });
  if (near) {
    return {
      status: 'flag', severity: 'med',
      finding: `Looks like already-paid ${near} with one character changed (${inv.number})`,
      why: `edit distance("${inv.number}", "${near}") = ${damerauLevenshtein(mine, key(near))}, ignoring case and spaces (flag ≤ 1; a single digit change is treated as the next invoice in sequence)`,
      evidence: [...evidence, { source: 'Payment log', value: `paid: ${near}` }],
    };
  }
  return { status: 'pass', finding: 'Not paid before', why: `${inv.number} not in the payment log, and no paid number within 1 edit.`, evidence };
}

function checkReports(inv, intel) {
  const sender = domainOf(inv.senderEmail);
  const n = intel[sender]?.scamReports ?? 0;
  const evidence = [{ source: 'Glasser · web_research (search)', value: `"${sender}" scam OR fraud → ${n} report${n === 1 ? '' : 's'}` }];
  if (n >= 3) return { status: 'flag', severity: 'high', finding: `${n} public scam reports`, why: 'Counted results on complaint and forum sites.', evidence };
  if (n >= 1) return { status: 'flag', severity: 'med', finding: `${n} public scam report${n === 1 ? '' : 's'}`, why: 'Counted results on complaint and forum sites.', evidence };
  return { status: 'pass', finding: 'No scam reports found', why: 'Searched complaint and forum sites.', evidence };
}

export function runChecks(inv, vendors, intel) {
  const vendor = vendors[inv.vendorKey];
  const out = {
    lookalike: checkLookalike(inv, vendor),
    bank: checkBank(inv, vendor),
    amount: checkAmount(inv, vendor),
    footprint: checkFootprint(inv, intel),
    address: checkAddress(inv, vendor, intel),
    pressure: checkPressure(inv),
    duplicate: checkDuplicate(inv, vendor),
    reports: checkReports(inv, intel),
  };
  return CHECKS.map((c) => ({ ...c, ...out[c.id] }));
}

// ---- score ------------------------------------------------------------------

const COMBOS = [
  { needs: ['lookalike', 'bank'], bonus: 25, label: 'Lookalike sender + new bank account: the classic invoice-redirect scam' },
  { needs: ['bank', 'pressure'], bonus: 10, label: 'New bank account + pressure to pay fast' },
  { needs: ['footprint', 'amount'], bonus: 10, label: 'Brand-new domain asking for an unusually large payment' },
];

export function score(results, weights, { dismissed = new Set(), isNewVendor = false } = {}) {
  const active = results.filter((r) => r.status === 'flag' && !dismissed.has(r.id));
  const flagged = new Set(active.map((r) => r.id));
  let risk = 0;
  const parts = [];
  for (const r of active) {
    const pts = POINTS[r.severity] * (weights[r.id] ?? 1);
    risk += pts;
    parts.push({ id: r.id, pts });
  }
  const combos = COMBOS.filter((c) => c.needs.every((id) => flagged.has(id)));
  for (const c of combos) risk += c.bonus;
  risk = Math.min(100, Math.round(risk));

  const known = results.filter((r) => r.status !== 'unknown').length;
  const confidence = Math.round((known / results.length) * 100);

  let band;
  if (risk >= 60) band = 'stop';
  else if (risk >= 25 || isNewVendor || confidence < 70) band = 'hold';
  else band = 'clear';

  const reason =
    band === 'stop' ? 'Likely fraud. Do not pay until you verify by phone.' :
    band === 'hold' && isNewVendor && risk < 25 ? 'First payment to a new vendor. Verify with a phone call before paying.' :
    band === 'hold' && confidence < 70 ? 'Not enough evidence to clear it. A human needs to look.' :
    band === 'hold' ? 'Some flags need a human look.' :
    'Everything matches. Waiting for your signature.';

  return { risk, confidence, band, reason, parts, combos };
}

// ---- learning from the human --------------------------------------------------

export function learn(weights, results, decision, dismissed) {
  const next = { ...weights };
  const changes = [];
  for (const r of results) {
    if (r.status !== 'flag') continue;
    const before = next[r.id];
    if (dismissed.has(r.id)) next[r.id] = Math.max(0.3, +(before * 0.85).toFixed(2));
    else if (decision === 'reject') next[r.id] = Math.min(2, +(before * 1.1).toFixed(2));
    if (next[r.id] !== before) changes.push({ id: r.id, before, after: next[r.id] });
  }
  return { weights: next, changes };
}
