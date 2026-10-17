import { CHECKS, DEFAULT_WEIGHTS, runChecks, score } from './engine.js';
import { INVOICES, VENDORS, INTEL, EXTRA_INVOICES, EXTRA_VENDORS, EXTRA_INTEL } from './data.js';
import { renderInvoice, brandMark, statusIcon, BAND_LABEL } from './ui.js';
import { mountSigs, setMood } from './mascot.js';

document.querySelectorAll('[data-mark]').forEach((el) => (el.innerHTML = brandMark()));
mountSigs();
const heroSig = document.getElementById('hero-sig');
const meetSig = document.getElementById('meet-sig');
let meetTimer;
document.querySelectorAll('[data-try]').forEach((b) => b.addEventListener('click', () => {
  setMood(meetSig, 'idle');
  requestAnimationFrame(() => setMood(meetSig, b.dataset.try));
  clearTimeout(meetTimer);
  meetTimer = setTimeout(() => setMood(meetSig, 'wave'), 4000);
}));

const nav = document.getElementById('nav');
addEventListener('scroll', () => nav.classList.toggle('scrolled', scrollY > 8), { passive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

// reveal on scroll
const io = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
}, { threshold: 0.12 });
document.querySelectorAll('.reveal').forEach((el) => io.observe(el));

// ---- checks grid ----
const FORMULAS = {
  lookalike: 'g00gle → google<br>edit_distance ≤ 2 · domain ≠ known',
  bank: 'account ≠ last_paid_account',
  amount: 'z = 0.6745 · (x − median) / MAD<br>z &gt; 3.5 → flag',
  footprint: 'domain_age &lt; 30 days → high',
  address: 'street(bill) = street(record)',
  pressure: 'Σ weights ≥ 2<br><span class="c">urgency 1 · secrecy 2 · bank change 2</span>',
  duplicate: 'number ∈ paid · or 1 edit away',
  reports: 'scam reports ≥ 1 → flag',
};
const EXAMPLES = {
  lookalike: 'g00gle-cloud-billing.co',
  bank: '••9021 → ••7730',
  amount: '14.6× usual · z = 485',
  footprint: 'registered 9 days ago',
  address: 'Jersey City ≠ Mountain View',
  pressure: 'urgent + "do not call" + new bank',
  duplicate: 'PC-0519 already paid',
  reports: '3 public reports',
};
const STARS = {
  lookalike: '"It sees the zero in g00gle that a busy person never does."',
  amount: '"A robust z-score, the outlier test statisticians use. Not a guess."',
};
document.getElementById('checks-grid').innerHTML = CHECKS.map((c, i) => `
  <div class="check-card reveal ${STARS[c.id] ? 'star' : ''}">
    <span class="n">0${i + 1}${STARS[c.id] ? ' <span class="wow" title="Key check"></span>' : ''}</span>
    <h3>${c.name}</h3>
    <p>${c.plain}</p>
    <span class="chip red" style="align-self:flex-start">${EXAMPLES[c.id]}</span>
    <div class="formula">${FORMULAS[c.id]}</div>
    ${STARS[c.id] ? `<p class="say">${STARS[c.id]}</p>` : ''}
  </div>`).join('');
document.querySelectorAll('#checks-grid .reveal').forEach((el, i) => { el.style.transitionDelay = `${(i % 4) * 70}ms`; io.observe(el); });

// ---- hero: a queue of bills, scanned one by one ----
const vendors = { ...VENDORS, ...EXTRA_VENDORS };
const intel = { ...INTEL, ...EXTRA_INTEL };
const byId = Object.fromEntries([...INVOICES, ...EXTRA_INVOICES].map((i) => [i.id, i]));
const SEQUENCE = ['vercel', 'gcloud', 'northwind', 'brightline', 'papercraft'].map((id) => byId[id]);

const queue = document.getElementById('queue');
const hcList = document.getElementById('hc-list');
const hcResult = document.getElementById('hc-result');
const hcVendor = document.getElementById('hc-vendor');
const tally = { clear: 0, hold: 0, stop: 0 };

hcList.innerHTML = CHECKS.map((c) => `<div class="hc" data-hc="${c.id}"><span class="ico unknown"></span><span>${c.name}</span></div>`).join('');

let seqIndex = 0;
function makeCard(inv) {
  const el = document.createElement('div');
  el.className = 'qcard';
  el.dataset.pos = '3';
  el.innerHTML = renderInvoice(inv, { idPrefix: `q-${inv.id}-${seqIndex}` });
  return el;
}
function nextInvoice() { return SEQUENCE[seqIndex++ % SEQUENCE.length]; }

function evaluate(inv) {
  const results = runChecks(inv, vendors, intel);
  const s = score(results, DEFAULT_WEIGHTS, { isNewVendor: !vendors[inv.vendorKey] });
  return { results, s };
}

async function heroQueue() {
  const cards = [];
  for (let i = 0; i < 4; i++) {
    const inv = nextInvoice();
    const el = makeCard(inv);
    el.inv = inv;
    queue.appendChild(el);
    cards.push(el);
  }
  await sleep(50);
  cards.forEach((c, i) => (c.dataset.pos = String(i)));

  for (;;) {
    const front = cards[0];
    const inv = front.inv;
    const { results, s } = evaluate(inv);
    const invEl = front.querySelector('.invoice');

    hcVendor.textContent = inv.vendorName;
    hcResult.className = 'hc-result';
    hcResult.textContent = 'SCANNING…';
    hcList.querySelectorAll('.hc').forEach((row) => {
      row.classList.remove('on');
      row.querySelector('.ico').outerHTML = '<span class="ico unknown"></span>';
    });

    setMood(heroSig, 'idle');
    await sleep(500);
    invEl.classList.add('scanning');
    setMood(heroSig, 'scan');
    for (const r of results) {
      await sleep(reduced ? 60 : 300);
      const row = hcList.querySelector(`[data-hc="${r.id}"]`);
      row.querySelector('.ico').outerHTML = statusIcon(r);
      row.classList.add('on');
      if (r.status === 'flag') invEl.querySelectorAll(`[data-hl="${r.id}"]`).forEach((el) => el.classList.add('bad'));
    }
    await sleep(350);
    invEl.classList.remove('scanning');

    const st = invEl.querySelector('.stamp');
    st.className = `stamp ${s.band} show`;
    st.innerHTML = `${BAND_LABEL[s.band]}<small>risk ${s.risk}</small>`;
    setMood(heroSig, s.band);
    hcResult.className = `hc-result ${s.band}`;
    hcResult.textContent = s.band === 'stop' ? 'STOP · DO NOT PAY' : s.band === 'hold' ? 'HOLD · CALL VENDOR' : 'CLEAR · AWAITING SIGNATURE';
    tally[s.band]++;
    document.getElementById(`t-${s.band}`).textContent = tally[s.band];

    await sleep(s.band === 'stop' ? 2600 : 1800);

    // send the front bill away, move the rest forward, add a new one at the back
    front.dataset.pos = `out-${s.band}`;
    cards.shift();
    cards.forEach((c, i) => (c.dataset.pos = String(i)));
    const inv2 = nextInvoice();
    const fresh = makeCard(inv2);
    fresh.inv = inv2;
    queue.appendChild(fresh);
    cards.push(fresh);
    requestAnimationFrame(() => requestAnimationFrame(() => (fresh.dataset.pos = '3')));
    setTimeout(() => front.remove(), 900);
    await sleep(900);
  }
}
heroQueue();

// ---- problem chart: BEC losses by year (single series, US $B) ----
const BEC = [
  { y: '2019', v: 1.777 }, { y: '2020', v: 1.867 }, { y: '2021', v: 2.396 }, { y: '2022', v: 2.742 },
  { y: '2023', v: 2.946 }, { y: '2024', v: 2.770 }, { y: '2025', v: 3.047 },
];
function renderChart() {
  const host = document.getElementById('bec-chart');
  const W = 640, H = 250, m = { t: 26, r: 8, b: 28, l: 38 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b, max = 3.5;
  const band = iw / BEC.length, bw = Math.min(24, band * 0.5);
  const y = (v) => m.t + ih - (v / max) * ih;
  const ticks = [0, 1, 2, 3];
  const grid = ticks.map((t) => `<line x1="${m.l}" x2="${W - m.r}" y1="${y(t)}" y2="${y(t)}"/>`).join('');
  const yl = ticks.map((t) => `<text x="${m.l - 8}" y="${y(t) + 4}" text-anchor="end">${t === 0 ? '0' : '$' + t + 'B'}</text>`).join('');
  const bars = BEC.map((d, i) => {
    const cx = m.l + band * i + band / 2, x = cx - bw / 2, top = y(d.v), h = m.t + ih - top, r = 4;
    const path = `M${x},${m.t + ih} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${m.t + ih} Z`;
    const last = i === BEC.length - 1;
    return `<path class="bar ${last ? '' : 'dim'}" d="${path}"/>
      ${last || i === 0 ? `<text class="val" x="${cx}" y="${top - 8}" text-anchor="middle">$${d.v.toFixed(2)}B</text>` : ''}
      <rect class="hit" x="${m.l + band * i}" y="${m.t}" width="${band}" height="${ih}" data-i="${i}"/>
      <text x="${cx}" y="${H - 8}" text-anchor="middle">${d.y}</text>`;
  }).join('');
  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Business email compromise losses rose from $1.78B in 2019 to $3.05B in 2025">
    <g class="grid">${grid}</g><g class="axis">${yl}${bars}</g></svg><div class="tip"></div>`;
  const tip = host.querySelector('.tip');
  host.querySelectorAll('.hit').forEach((h) => {
    h.addEventListener('mouseenter', () => {
      const d = BEC[+h.dataset.i];
      const box = host.getBoundingClientRect(), r = h.getBoundingClientRect();
      tip.innerHTML = `${d.y} · <b>$${d.v.toFixed(2)}B</b>`;
      tip.style.left = `${r.left - box.left + r.width / 2}px`;
      tip.style.top = `${(y(d.v) / H) * box.height}px`;
      tip.style.opacity = 1;
    });
    h.addEventListener('mouseleave', () => (tip.style.opacity = 0));
  });
  document.getElementById('bec-table').innerHTML = BEC.map((d) => `<tr><td>${d.y}</td><td>$${d.v.toFixed(2)}B</td></tr>`).join('');
}
renderChart();

// ---- learning demo: fixed rows, read-only gauge ----
const learn = document.getElementById('learn-demo');
const steps = [
  { w: 0.85, dir: 'down', log: 'Oct 3 · You marked it a false alarm on an annual software prepay. 1.00 → 0.85' },
  { w: 0.72, dir: 'down', log: 'Oct 9 · False alarm again (a one-off conference booking). 0.85 → 0.72' },
  { w: 0.79, dir: 'up', log: 'Oct 15 · You rejected a fake bill it flagged. 0.72 → 0.79' },
];
const pos = (w) => `${((w - 0.3) / 1.7) * 100}%`;
const logEl = document.getElementById('learn-log');
logEl.innerHTML = steps.map((s) => `<div><span class="ico ${s.dir === 'up' ? 'flag' : 'pass'}">${s.dir === 'up' ? '↑' : '↓'}</span><span>${s.log}</span></div>`).join('');
const rows = [...logEl.children];
const needle = document.getElementById('learn-needle'), lbl = document.getElementById('learn-lbl');
const setW = (w) => { needle.style.left = pos(w); lbl.style.left = pos(w); lbl.textContent = w.toFixed(2); };
setW(1);
let started = false;
new IntersectionObserver(async ([e]) => {
  if (!e.isIntersecting || started) return;
  started = true;
  for (;;) {
    rows.forEach((r) => r.classList.remove('on', 'now'));
    setW(1);
    await sleep(1600);
    for (let i = 0; i < steps.length; i++) {
      rows.forEach((r) => r.classList.remove('now'));
      rows[i].classList.add('on', 'now');
      setW(steps[i].w);
      await sleep(2000);
    }
    await sleep(2400);
  }
}, { threshold: 0.4 }).observe(learn);

// ---- how it works: data pulses along every edge of the architecture ----
document.querySelectorAll('.arch .edge').forEach((e, i) => {
  const pulse = e.cloneNode();
  pulse.removeAttribute('marker-end');
  pulse.setAttribute('class', 'pulse');
  pulse.style.animationDelay = `${(i % 9) * -0.35}s`;
  e.after(pulse);
});
