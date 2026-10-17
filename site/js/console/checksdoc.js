// "How the checks work" page. Plain explanation of every deterministic check,
// its formula, its data source and cost, and how the score, stamp and learning work.
// No DOM access at module load; everything happens inside renderChecksDoc().

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const BILL = [
  {
    id: 'lookalike',
    name: 'Lookalike sender',
    plain: 'Catches a sender domain made to look like a vendor you already pay.',
    formula: 'swap lookalike characters: 0 to o, 1 to l, rn to m\nedit_distance(sender, real vendor domain) ≤ 2  gives  high',
    source: 'Your vendor records and the bill',
    cost: 'Free',
    example: 'g00gle-cloud-billing.co reads as google, but it is not google.com.',
  },
  {
    id: 'bank',
    name: 'Bank details changed',
    plain: 'Catches a bill asking you to pay a different account than the one you paid last time.',
    formula: 'account on bill ≠ account last paid  gives  high\nno account on bill (card payment)  gives  no data',
    source: 'Your vendor records and the bill',
    cost: 'Free',
    example: 'Last paid to account ending 4410; this bill says ending 9032.',
  },
  {
    id: 'amount',
    name: 'Amount anomaly',
    plain: 'Catches a bill far larger than this vendor normally sends, using a statistic that one odd past bill cannot skew.',
    formula: 'z = 0.6745 × (amount − median) ÷ MAD\nMAD = median of |xᵢ − median| over past bills\nflag: z > 3.5 and amount > 1.5 × median\nhigh: z > 8 and amount > 3 × median\nall past bills identical: ratio > 3 flag, > 8 high\nneeds 3 or more past bills',
    source: 'Your past bills from this vendor',
    cost: 'Free',
    example: 'Usually about $1,200 a month; this bill is $14,800.',
    note: 'Robust z-score from Iglewicz and Hoaglin.',
  },
  {
    id: 'footprint',
    name: 'Vendor footprint',
    plain: 'Catches companies that do not really exist, or whose domain was registered days ago.',
    formula: 'domain not registered, or under 30 days old  gives  high\nno company profile found  gives  flag',
    source: 'Company profile via Glasser (Hunter), domain age via public RDAP',
    cost: '$0.0049 per profile, RDAP free',
    example: 'A domain registered 6 days before the bill arrived.',
  },
  {
    id: 'address',
    name: 'Address',
    plain: 'Catches a bill whose street address does not match the one on file.',
    formula: 'normalize(street on bill) ≠ normalize(street on file)  gives  flag\nnormalize ignores spacing and punctuation',
    source: 'Your vendor records and the bill',
    cost: 'Free',
    example: '"200 Main St." and "200 main st" match; "14 Harbor Rd" does not.',
  },
  {
    id: 'pressure',
    name: 'Pressure tactics',
    plain: 'Catches wording that rushes you, asks for secrecy, or changes how to pay.',
    formula: 'urgency 1 · secrecy 2 · payment change 2 · authority or threat 1\nscore = sum of weights of distinct phrases\nflag: score ≥ 2\nhigh: score ≥ 4, or secrecy and payment change together',
    source: 'The bill text',
    cost: 'Free',
    example: '"We changed our bank" plus "by email only" is secrecy and payment change together.',
  },
  {
    id: 'duplicate',
    name: 'Duplicate',
    plain: 'Catches a bill you already paid, including one with its number slightly altered.',
    formula: 'invoice number already paid  gives  high\nDamerau–Levenshtein(number, paid number) ≤ 1  gives  flag',
    source: 'Your past bills',
    cost: 'Free',
    example: 'VC-2541A is one character away from paid bill VC-2541.',
  },
  {
    id: 'reports',
    name: 'Scam reports',
    plain: 'Catches senders that people have already reported online as scams.',
    formula: 'count results on complaint or forum sites\n  that name the exact domain and use scam words\nlarge established companies (5+ years, 200+ people) discounted\nflag: count ≥ 1\nhigh: count ≥ 3',
    source: 'Google search via Glasser (Serper)',
    cost: '$0.0011 per search',
    example: 'Big companies get impersonated, so reports that mention them do not count against them.',
  },
];

const EMAIL = [
  {
    name: 'Sender verified (DMARC)',
    plain: 'Catches mail that claims a domain the domain owner never authorized.',
    formula: 'DMARC = fail  gives  the From domain did not authorize this message',
    example: 'From says billing@vendor.com, but vendor.com rejects the sending server.',
  },
  {
    name: 'Mail signature (SPF and DKIM)',
    plain: 'Checks the sending server is allowed for the domain and the message was signed and not altered on the way.',
    formula: 'SPF: sending server listed by the domain\nDKIM: cryptographic signature matches the message',
    example: 'A DKIM signature that no longer matches means the message changed after sending.',
  },
  {
    name: 'Replies go elsewhere',
    plain: 'Catches mail where your reply would go to a different company than the sender.',
    formula: 'Reply-To domain ≠ From domain  gives  high\nexcept billing platforms (Stripe, PayPal, Bill.com and similar)\n  sending for the merchant with DMARC pass',
    example: 'From vendor.com, but Reply-To is vendor-accounts.net.',
  },
];

const DOC = [
  {
    name: 'Bank numbers are real',
    plain: 'Catches made-up account numbers. A number that fails its check digit cannot be a real account.',
    formula: 'US routing: 3·(d1+d4+d7) + 7·(d2+d5+d8) + (d3+d6+d9) ≡ 0 (mod 10)\nIBAN: move first 4 characters to the end,\n  letters become numbers (A = 10 … Z = 35),\n  the whole number mod 97 must equal 1\nfails  gives  high',
    example: 'Routing number 021000021 passes; change one digit and it fails.',
  },
  {
    name: 'The numbers add up',
    plain: 'Catches totals that do not match the line items, a common sign of an edited bill.',
    formula: '|Σ line items − total| ≤ $0.01, or subtotal + tax = total\ngap > 1% of total  gives  high\nsmaller gap  gives  flag',
    example: 'Lines sum to $4,200.00 but the total says $42,000.00.',
  },
  {
    name: 'Document was not tampered with',
    plain: 'Every PDF records the software that made it and when. Changes to that story are worth a look.',
    formula: 'different software than this vendor’s past bills  gives  flag\nmade or saved with a PDF editing tool  gives  flag\nmodified more than 1 hour after created  gives  flag',
    example: 'Past bills came from QuickBooks; this one was last saved in a PDF editor.',
  },
];

const fmtW = (w) => (Number.isFinite(Number(w)) ? Number(w) : 1).toFixed(2);

function checkRow(c, meta) {
  return `
    <div class="cd-check">
      <div class="cd-check-h"><h3 class="cd-name">${esc(c.name)}</h3></div>
      <p class="cd-plain">${esc(c.plain)}</p>
      <pre class="cd-formula">${esc(c.formula)}</pre>
      ${c.note ? `<p class="cd-note">${esc(c.note)}</p>` : ''}
      <p class="cd-meta">${meta}</p>
      <p class="cd-example"><span>Example</span>${esc(c.example)}</p>
    </div>`;
}

function group(title, count, data, rows) {
  return `
    <div class="card cd-group">
      <div class="card-h cd-group-h">
        <h2>${esc(title)}</h2>
        <span class="cd-count">${count} checks</span>
      </div>
      <div class="cd-data">Data: ${esc(data)}</div>
      <div class="cd-list">${rows}</div>
    </div>`;
}

function spendLine(spend) {
  if (spend == null) return '';
  const total = typeof spend === 'number' ? spend : Number(spend.total ?? spend.usd ?? spend.cost);
  if (!Number.isFinite(total)) return '';
  const calls = typeof spend === 'object' && Number.isFinite(Number(spend.calls)) ? ` across ${Number(spend.calls)} lookups` : '';
  return `<p class="cd-spend">Live data spent so far: <b>$${esc(total.toFixed(4))}</b>${esc(calls)}.</p>`;
}

export function renderChecksDoc(container, { weights = {}, spend = null } = {}) {
  if (!container) return;
  const w = (id) => fmtW(weights?.[id] ?? 1);

  const billRows = BILL.map((c) => checkRow(c,
    `Source: ${esc(c.source)} · Cost: ${esc(c.cost)} · <b>Weight ${esc(w(c.id))}</b> (learned from your team)`)).join('');
  const emailRows = EMAIL.map((c) => checkRow(c, 'Source: headers Gmail adds to every message · Cost: Free')).join('');
  const docRows = DOC.map((c) => checkRow(c, 'Source: the PDF itself · Cost: Free')).join('');

  const steps = ['Read the bill', '14 checks', 'Score', 'Stamp', 'A person decides'];

  container.innerHTML = `
    <div class="cd-page">
      <header class="cd-intro">
        <h2>How the checks work</h2>
        <p>14 checks in three groups. Every one is plain code with a formula; no AI decides anything. The same bill always gets the same result.</p>
        <ol class="cd-pipe">${steps.map((s, i) => `<li class="${i === steps.length - 1 ? 'cd-pipe-last' : ''}"><span class="cd-pipe-n">${i + 1}</span>${esc(s)}</li>`).join('')}</ol>
        ${spendLine(spend)}
      </header>

      ${group('The bill', 8, 'your vendor records, the bill text, and live data via Glasser', billRows)}
      ${group('The email', 3, 'the headers Gmail adds to every message (free)', emailRows)}
      ${group('The document', 3, 'the PDF itself (free)', docRows)}

      <div class="card cd-group">
        <div class="card-h"><h2>How the score works</h2></div>
        <div class="card-b cd-prose">
          <p>Each failed bill check adds points, multiplied by that check’s learned weight. Combinations that match known scams add more. Risk is capped at 100.</p>
          <pre class="cd-formula">risk = min(100, Σ points × weight + combination bonuses)
points: 12 for a flag, 24 for high
confidence = checks that had data ÷ checks run</pre>
          <div class="cd-sub">Combination bonuses</div>
          <ul class="cd-bullets">
            <li><b>+25</b> Lookalike sender and new bank account: the classic invoice-redirect scam</li>
            <li><b>+10</b> New bank account and pressure tactics</li>
            <li><b>+10</b> Brand-new domain and an unusually large amount</li>
          </ul>
          <div class="cd-sub">Stamps</div>
          <div class="cd-stamps">
            <div class="cd-stamp cd-stop"><b>Stop</b><span>Risk 60 or more.</span></div>
            <div class="cd-stamp cd-hold"><b>Hold</b><span>Risk 25 to 59, a first payment to a new vendor, or confidence under 70%.</span></div>
            <div class="cd-stamp cd-clear"><b>Clear</b><span>Risk under 25.</span></div>
          </div>
          <p class="cd-callout">Email and document checks can only make a stamp stricter. A spoofed sender, a fake bank number, or a total that does not add up on an edited PDF forces Stop. Any other email or document problem forces at least Hold.</p>
        </div>
      </div>

      <div class="card cd-group">
        <div class="card-h"><h2>How it learns</h2></div>
        <div class="card-b cd-prose">
          <p>Weights start at 1.00 and move only when a person makes a decision.</p>
          <pre class="cd-formula">marked a false alarm:  weight × 0.85  (never below 0.30)
flagged bill rejected:  weight × 1.1 for each flagged check  (never above 2.00)</pre>
          <p class="cd-muted">Every change is written to the audit log with who caused it.</p>
        </div>
      </div>

      <div class="card cd-group">
        <div class="card-h"><h2>The rules people can’t skip</h2></div>
        <div class="card-b">
          <ul class="cd-rules">
            <li>A bill stamped Stop can’t be approved.</li>
            <li>Every decision needs a written reason.</li>
            <li>Bills of $10,000 or more need two different people to sign.</li>
            <li>Whoever uploaded a bill can’t approve it.</li>
            <li>Editing a bill clears its signatures.</li>
            <li>Countersign never pays anything. It only tells people what to look at.</li>
          </ul>
        </div>
      </div>
    </div>`;
}
