import { CHECKS, DEFAULT_WEIGHTS, POINTS, runChecks, score, learn } from './engine.js';
import { INVOICES, VENDORS, INTEL } from './data.js';
import { renderInvoice, brandMark, statusIcon, usd, esc, BAND_LABEL, BAND_SUB } from './ui.js';
import { initLive, intelFor, isLive } from './live.js';

document.querySelectorAll('[data-mark]').forEach((el) => (el.innerHTML = brandMark()));

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NAMES = Object.fromEntries(CHECKS.map((c) => [c.id, c.name]));

// ---- state (weights + log persist per browser; storage may be unavailable) ----
const store = {
  get(k, fallback) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch { return fallback; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* demo still works */ } },
};
let weights = { ...DEFAULT_WEIGHTS, ...store.get('cs.weights', {}) };
let log = store.get('cs.log', []);
const outcomes = store.get('cs.outcomes', {});

let current = null; // { inv, results, dismissed:Set, s, busy }

// ---- tray + records ----
function renderTray() {
  $('tray').innerHTML = INVOICES.map((inv) => {
    const o = outcomes[inv.id];
    const badge = o ? `<span class="result" style="color:var(--${o === 'paid' ? 'green' : o === 'rejected' ? 'red' : 'amber'})">${o.toUpperCase()}</span>` : '';
    return `<button class="bill ${o ? 'done' : ''} ${current?.inv.id === inv.id ? 'active' : ''}" draggable="true" data-id="${inv.id}">
      ${badge}
      <div class="v">${esc(inv.vendorName)}</div>
      <div class="a">${usd(inv.amount)}</div>
      <div class="m"><span>${esc(inv.number)}</span><span>due ${esc(inv.due)}</span></div>
      <div class="m"><span class="chip" style="font-size:10.5px;padding:2px 8px">${esc(inv.tag)}</span></div>
    </button>`;
  }).join('');
  $('tray').querySelectorAll('.bill').forEach((b) => {
    b.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', b.dataset.id));
    b.addEventListener('click', () => load(b.dataset.id));
  });
}

function renderRecords() {
  const rows = Object.values(VENDORS).map((v) => `
    <div style="padding:9px 10px;border-radius:10px;background:var(--paper)">
      <b style="color:var(--ink)">${esc(v.name)}</b> <span class="mono" style="font-size:11px">${esc(v.domain)}</span><br>
      pays to <span class="mono">••${esc(v.bankLast4)}</span> · usually ~${usd(v.history.reduce((a, b) => a + b, 0) / v.history.length).replace('.00', '')}
    </div>`).join('');
  $('records').innerHTML = rows + `<div class="muted" style="font-size:12px">Brightline Supply Co. isn't in your records yet: it's a new vendor.</div>`;
}

// ---- drop zone ----
const scanner = $('scanner');
scanner.addEventListener('dragover', (e) => { e.preventDefault(); scanner.classList.add('over'); });
scanner.addEventListener('dragleave', () => scanner.classList.remove('over'));
scanner.addEventListener('drop', (e) => { e.preventDefault(); scanner.classList.remove('over'); load(e.dataTransfer.getData('text/plain')); });

// ---- side panel rendering ----
function setMeters(risk, conf, band) {
  $('risk').textContent = risk;
  $('conf').textContent = conf + '%';
  const color = band === 'stop' ? 'var(--red)' : band === 'hold' ? 'var(--amber)' : band === 'clear' ? 'var(--green)' : 'var(--ink)';
  $('risk-bar').style.width = risk + '%';
  $('risk-bar').style.background = color;
  $('conf-bar').style.width = conf + '%';
}

function checkRow(r, dismissed) {
  const pts = r.status === 'flag' && !dismissed.has(r.id) ? `+${Math.round(POINTS[r.severity] * (weights[r.id] ?? 1))}` : r.status === 'unknown' ? 'n/a' : '0';
  const ev = r.evidence.map((e) => `<span class="chip">${esc(e.source)}: ${esc(e.value)}</span>`).join('');
  const fa = r.status === 'flag'
    ? `<label class="fa"><input type="checkbox" data-dismiss="${r.id}" ${dismissed.has(r.id) ? 'checked' : ''}> False alarm (I know why)</label>` : '';
  return `<div class="ck ${dismissed.has(r.id) ? 'dismissed' : ''}" data-ck="${r.id}">
    <div class="ck-top">${statusIcon(r)}<span class="ck-name">${esc(r.name)}</span><span class="pts">${pts}</span></div>
    <div class="finding">${esc(r.finding)}</div>
    <details><summary>Why · evidence</summary><div class="why">${esc(r.why)}</div><div class="ev">${ev}</div></details>
    ${fa}
  </div>`;
}

function renderVerdict(s) {
  const v = $('verdict');
  v.className = `verdict ${s.band}`;
  v.innerHTML = `<span class="tag">${BAND_LABEL[s.band].toUpperCase()}</span><span>${esc(s.reason)}</span>`;
  $('combos').innerHTML = s.combos.map((c) => `<div class="combo">⚡ ${esc(c.label)}<b>+${c.bonus}</b></div>`).join('');
}

function memoFor(inv, results, s) {
  const flags = results.filter((r) => r.status === 'flag' && !current.dismissed.has(r.id));
  const unknown = results.filter((r) => r.status === 'unknown');
  if (s.band === 'stop') return `This ${usd(inv.amount)} bill claims to be from ${esc(inv.vendorName)} but ${flags.slice(0, 3).map((f) => esc(f.finding.charAt(0).toLowerCase() + f.finding.slice(1))).join('; ')}. Don't pay it. Call ${esc(inv.vendorName)} on a number from your own records and ask whether they sent invoice ${esc(inv.number)}.`;
  if (s.band === 'hold') return `Nothing here looks fraudulent, but ${unknown.length} of 8 checks had no data because this is a first invoice. Before paying ${usd(inv.amount)}, confirm the bank account by phone using a number from the vendor's own website, then add them to your records.`;
  return `Everything matches your history with ${esc(inv.vendorName)}: same sender domain, same bank account, a normal amount. It's ready for your signature.`;
}

function rescore() {
  const s = score(current.results, weights, { dismissed: current.dismissed, isNewVendor: !VENDORS[current.inv.vendorKey] });
  current.s = s;
  setMeters(s.risk, s.confidence, s.band);
  renderVerdict(s);
  $('checklist').innerHTML = current.results.map((r) => checkRow(r, current.dismissed)).join('');
  $('checklist').querySelectorAll('.ck').forEach((el) => el.classList.add('on'));
  bindDismiss();
  const st = document.querySelector('#scanner .stamp');
  st.className = `stamp ${s.band} show`;
  st.innerHTML = `${BAND_LABEL[s.band]}<small>risk ${s.risk} · ${BAND_SUB[s.band]}</small>`;
  document.querySelectorAll('#scanner .hl').forEach((el) => el.classList.remove('bad'));
  for (const r of current.results) {
    if (r.status === 'flag' && !current.dismissed.has(r.id)) document.querySelectorAll(`#scanner [data-hl="${r.id}"]`).forEach((el) => el.classList.add('bad'));
  }
  $('memo').innerHTML = memoFor(current.inv, current.results, s);
  updateActions();
}

function bindDismiss() {
  $('checklist').querySelectorAll('[data-dismiss]').forEach((cb) => cb.addEventListener('change', () => {
    const id = cb.dataset.dismiss;
    cb.checked ? current.dismissed.add(id) : current.dismissed.delete(id);
    rescore();
  }));
}

function updateActions() {
  if (!current.s) {
    ['sign', 'reject', 'call'].forEach((id) => ($(id).disabled = true));
    $('act-note').textContent = 'Checking… nothing can be paid until the checks finish.';
    return;
  }
  const decided = !!outcomes[current.inv.id];
  const stop = current.s.band === 'stop';
  $('sign').disabled = decided || current.busy || stop;
  $('reject').disabled = decided || current.busy;
  $('call').disabled = decided || current.busy;
  $('act-note').textContent = decided ? `You already decided: ${outcomes[current.inv.id]}.`
    : stop ? 'Paying is locked while it says STOP. Resolve or mark false alarms if you know they are wrong.'
    : current.s.band === 'hold' ? 'You can pay, but call the vendor first. That is what HOLD means.'
    : 'Looks good. Your signature releases the payment.';
}

// ---- load + animate a bill ----
let fetching = false;
async function load(id) {
  const inv = INVOICES.find((i) => i.id === id);
  if (!inv || current?.busy || fetching) return;
  if (isLive()) {
    fetching = true;
    $('verdict').className = 'verdict';
    $('verdict').innerHTML = `<span class="muted">Looking up ${esc(inv.senderEmail.split('@')[1])} live via Glasser…</span>`;
  }
  const { intel } = await intelFor(inv, INTEL);
  fetching = false;
  current = { inv, results: runChecks(inv, VENDORS, intel), dismissed: new Set(), s: null, busy: true };
  renderTray();
  $('empty')?.remove();
  scanner.innerHTML = renderInvoice(inv, { idPrefix: 'desk-inv' });
  const el = scanner.querySelector('.invoice');
  $('memo-box').hidden = true;
  $('combos').innerHTML = '';
  $('verdict').className = 'verdict';
  $('verdict').innerHTML = '<span class="muted">Checking…</span>';
  setMeters(0, 0);
  $('checklist').innerHTML = current.results.map((r) => checkRow(r, current.dismissed)).join('');
  updateActions();

  await sleep(350);
  el.classList.add('scanning');
  let running = { risk: 0, known: 0 };
  for (let i = 0; i < current.results.length; i++) {
    await sleep(420);
    const r = current.results[i];
    $('checklist').querySelector(`[data-ck="${r.id}"]`).classList.add('on');
    if (r.status === 'flag') {
      el.querySelectorAll(`[data-hl="${r.id}"]`).forEach((h) => h.classList.add('bad'));
      running.risk += POINTS[r.severity] * (weights[r.id] ?? 1);
    }
    if (r.status !== 'unknown') running.known++;
    setMeters(Math.min(100, Math.round(running.risk)), Math.round((running.known / (i + 1)) * 100));
  }
  await sleep(300);
  el.classList.remove('scanning');
  current.busy = false;
  rescore();
  $('memo-box').hidden = false;
}

// ---- decisions ----
function record(decision) {
  const { inv, results, dismissed } = current;
  const label = { pay: 'paid', reject: 'rejected', call: 'on hold, calling vendor' }[decision];
  outcomes[inv.id] = decision === 'pay' ? 'paid' : decision === 'reject' ? 'rejected' : 'calling';
  const learned = learn(weights, results, decision === 'pay' ? 'approve' : decision, dismissed);
  weights = learned.weights;
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  log.unshift({ t: time, text: `You ${label} ${inv.vendorName} ${inv.number} (${usd(inv.amount)}) · stamp was ${current.s.band.toUpperCase()}` });
  for (const c of learned.changes) {
    log.unshift({ t: time, learnt: true, text: `Learned: “${NAMES[c.id]}” weight ${c.before.toFixed(2)} → ${c.after.toFixed(2)} ${c.after < c.before ? '(you called it a false alarm)' : '(you confirmed it mattered)'}` });
  }
  store.set('cs.weights', weights); store.set('cs.log', log); store.set('cs.outcomes', outcomes);
  renderJournal(); renderTray(); updateActions();
  return learned.changes.length;
}

$('sign').addEventListener('click', () => {
  document.querySelector('#scanner .signature')?.classList.add('draw');
  const n = record('pay');
  toast(`Signed. Payment released by you${n ? ` · Countersign learned from ${n} false alarm${n > 1 ? 's' : ''}` : ''}.`);
});
$('reject').addEventListener('click', () => {
  const n = record('reject');
  toast(`Rejected. Nothing was paid${n ? ` · ${n} check${n > 1 ? 's' : ''} will count a bit more next time` : ''}.`);
});
$('call').addEventListener('click', () => {
  record('call');
  toast(`Marked on hold. Call ${current.inv.vendorName} on a number from your own records.`);
});

function renderJournal() {
  $('journal').innerHTML = log.length
    ? log.map((j) => `<div class="j ${j.learnt ? 'learnt' : ''}"><div class="t">${esc(j.t)}</div>${esc(j.text)}</div>`).join('')
    : '<div class="empty-j">Your decisions and what Countersign learned from them show up here.</div>';
}

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3800);
}

$('reset').addEventListener('click', () => {
  try { ['cs.weights', 'cs.log', 'cs.outcomes'].forEach((k) => localStorage.removeItem(k)); } catch { /* ignore */ }
  location.reload();
});

renderTray();
renderRecords();
renderJournal();
initLive();
