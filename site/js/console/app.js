import { CHECKS, POINTS, DEFAULT_WEIGHTS, score } from '../engine.js';
import { brandMark, esc, statusIcon, SIGNATURE_PATH } from '../ui.js';
import { readDocument, parseFields } from './extract.js';
import { applyEmail, analyzeEmail, SHORT } from './mailrules.js';
import { applyDocument, withoutDismissed } from './docrules.js';
import { renderChecksDoc } from './checksdoc.js';
import { applyCallback, callPlan, prettyPhone, CALL_LABEL } from './callback.js';
import { fastLane } from './fastlane.js';
import { mountSigs, setMood } from '../mascot.js';

const $ = (id) => document.getElementById(id);
const page = $('page');
const NAMES = Object.fromEntries(CHECKS.map((c) => [c.id, c.name]));
const STATUS = {
  needs_review: ['Needs review', 'blue'],
  awaiting_second: ['Awaiting 2nd signature', 'hold'],
  on_hold: ['On hold', 'hold'],
  approved: ['Approved · ready to pay', 'clear'],
  rejected: ['Rejected', 'stop'],
  dismissed: ['Not a bill', ''],
};
const BAND = { stop: 'STOP', hold: 'HOLD', clear: 'CLEAR' };
const money = (n, cur = 'USD') => (cur === 'USD' ? '$' : cur + ' ') + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const ago = (iso) => {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};
const initials = (n) => n.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
const personName = (id) => (id === 'system' ? 'Countersign (auto)' : state.users.find((u) => u.id === id)?.name ?? id);
// Fast lane is computed live from the shared rules, so it always reflects current vendor records.
// Sig, the mascot, with a mood and one plain sentence. Used sparingly: verdicts and empty states.
const sigNote = (mood, title, text, size = 92) => `<div class="sig-note"><span data-sig data-mood="${mood}" style="width:${size}px"></span><div><b>${title}</b><p>${text}</p></div></div>`;
const shortDate = (v) => { const t = Date.parse(v); return Number.isNaN(t) || !/\d{4}/.test(v) ? (v || '–') : new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); };
const laneOf = (c) => fastLane(c, state.vendors.find((v) => v.key === c.vendorKey));
const bandColor = (b) => (b === 'stop' ? 'var(--red)' : b === 'hold' ? 'var(--amber)' : 'var(--green)');

// ---------------------------------------------------------------------------
// API + state
// ---------------------------------------------------------------------------
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

const state = { users: [], me: null, cases: [], vendors: [], policy: null, tab: 'open', q: '' };
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* per-viewer convenience only */ } },
};

let toastT;
function toast(msg, err = false) {
  const t = $('toast');
  t.textContent = msg; t.className = `toast2 on ${err ? 'err' : ''}`;
  clearTimeout(toastT); toastT = setTimeout(() => (t.className = 'toast2'), err ? 5200 : 3200);
}

async function refreshHealth() {
  try {
    const h = await api('/api/health');
    $('spend').textContent = '$' + h.spending.spent.toFixed(3);
    $('balance').textContent = h.glasser?.available_usd != null ? '$' + Number(h.glasser.available_usd).toFixed(2) : '–';
  } catch { $('spend').textContent = 'offline'; }
}

async function loadAll() {
  const [u, c, v, p] = await Promise.all([api('/api/users'), api('/api/cases'), api('/api/vendors'), api('/api/policy')]);
  state.users = u.users; state.cases = c.cases; state.vendors = v.vendors; state.policy = p;
  if (!state.me) {
    const saved = store.get('cs.me');
    state.me = state.users.find((x) => x.id === saved)?.id ?? state.users[0]?.id;
  }
  const sel = $('me');
  sel.innerHTML = state.users.map((x) => `<option value="${x.id}" ${x.id === state.me ? 'selected' : ''}>${esc(x.name)} · ${esc(x.role)}</option>`).join('');
  $('me-initials').textContent = initials(state.users.find((x) => x.id === state.me)?.name ?? '?');
  const open = state.cases.filter((x) => ['needs_review', 'awaiting_second', 'on_hold'].includes(x.status)).length;
  $('nav-open').hidden = !open; $('nav-open').textContent = open;
}

$('me').addEventListener('change', (e) => {
  state.me = e.target.value; store.set('cs.me', state.me);
  $('me-initials').textContent = initials(state.users.find((x) => x.id === state.me)?.name ?? '?');
  toast(`Signed in as ${state.users.find((x) => x.id === state.me)?.name}`);
  route();
});
$('search').addEventListener('input', (e) => { state.q = e.target.value.toLowerCase(); if (!location.hash || location.hash === '#inbox') renderInbox(); });

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
function setHead(title, crumb = 'Accounts payable') {
  $('title').textContent = title; $('crumb').innerHTML = crumb;
  document.querySelectorAll('.side-nav a').forEach((a) => a.classList.toggle('on', location.hash.startsWith('#' + a.dataset.route) || (!location.hash && a.dataset.route === 'inbox') || (location.hash.startsWith('#case') && a.dataset.route === 'inbox')));
}

async function route() {
  const [name, arg] = location.hash.slice(1).split('/');
  try {
    await loadAll();
    if (name === 'case' && arg) return await renderCase(arg);
    if (name === 'mailbox') return await renderMailbox();
    if (name === 'vendors') return renderVendors();
    if (name === 'audit') return await renderAudit();
    if (name === 'policy') return renderPolicy();
    if (name === 'developers') return renderDevelopers();
    if (name === 'checks') return renderChecksDoc(page, { weights: state.policy?.weights ?? {} });
    return renderInbox();
  } catch (e) {
    page.innerHTML = `<div class="card"><div class="empty-state"><b>Can't reach the Countersign server</b>Start it with <code>node core/server.mjs</code> and open <code>http://localhost:4181/app.html</code>.<br><span class="note err">${esc(e.message)}</span></div></div>`;
  }
}
addEventListener('hashchange', route);

// ---------------------------------------------------------------------------
// Inbox
// ---------------------------------------------------------------------------
const TABS = [
  ['open', 'To review', (c) => ['needs_review', 'awaiting_second', 'on_hold'].includes(c.status)],
  ['approved', 'Approved', (c) => c.status === 'approved'],
  ['closed', 'Closed', (c) => ['rejected', 'dismissed'].includes(c.status)],
  ['all', 'All', () => true],
];

function required(c) { return Number(c.fields.amount) >= state.policy.dualApprovalOver ? 2 : 1; }

function renderInbox() {
  setHead('Inbox');
  const cs = state.cases;
  const mine = cs.filter((c) => c.status === 'awaiting_second' && !c.approvals.some((a) => a.userId === state.me)).length
    + cs.filter((c) => c.status === 'needs_review' && c.check?.score.band !== 'stop').length;
  const blocked = cs.filter((c) => c.check?.score.band === 'stop' && c.status !== 'approved').reduce((a, c) => a + Number(c.fields.amount || 0), 0);
  const cleared = cs.filter((c) => c.status === 'approved').reduce((a, c) => a + Number(c.fields.amount || 0), 0);
  const tab = TABS.find((t) => t[0] === state.tab) ?? TABS[0];
  const rows = cs.filter(tab[2]).filter((c) => !state.q || `${c.fields.vendorName} ${c.fields.number} ${c.fields.amount} ${c.fields.senderEmail}`.toLowerCase().includes(state.q));

  page.innerHTML = `
    <div class="kpis">
      <div class="kpi accent"><span class="lbl">Stopped before payment</span><b>${money(blocked)}</b><small>bills marked Stop, not paid</small></div>
      <div class="kpi"><span class="lbl">Waiting on you</span><b>${mine}</b><small>bills you can review or sign</small></div>
      <div class="kpi"><span class="lbl">Open bills</span><b>${cs.filter(TABS[0][2]).length}</b><small>of ${cs.length} received</small></div>
      <div class="kpi"><span class="lbl">Approved to pay</span><b>${money(cleared)}</b><small>each one signed by a person</small></div>
    </div>
    <div class="card">
      <div class="card-h"><div class="seg">${TABS.map((t) => `<button data-tab="${t[0]}" class="${t[0] === tab[0] ? 'on' : ''}">${t[1]} <span>${cs.filter(t[2]).length}</span></button>`).join('')}</div>
        <span class="note">Clear: safe to approve · Hold: needs a look · Stop: do not pay</span></div>
      ${rows.length ? `<div class="tbl-wrap"><table class="tbl inbox"><thead><tr>
        <th>Vendor</th><th>Invoice</th><th style="text-align:right">Amount</th><th>Due</th><th>Check</th><th>Status</th><th></th></tr></thead><tbody>
        ${rows.map((c) => {
          const s = c.check?.score; const [st, sc] = STATUS[c.status] ?? [c.status, ''];
          return `<tr data-case="${c.id}">
            <td class="bill"><b>${esc(c.fields.vendorName || 'Unknown vendor')}</b>${c.demo ? ' <span class="tag">sample</span>' : ''}<div class="sub">${c.billedVia ? `${esc(c.billedVia.merchant)} via ${esc(c.billedVia.platform)}` : esc(c.fields.senderEmail || '')} · ${c.email ? 'by email' : 'uploaded'} ${ago(c.createdAt)}</div></td>
            <td class="mono">${esc(c.fields.number || '–')}</td>
            <td class="num"><b>${money(c.fields.amount, c.fields.currency)}</b></td>
            <td>${esc(shortDate(c.fields.due))}</td>
            <td>${s ? `<span class="pill ${s.band}" title="Risk ${s.risk} of 100">${BAND[s.band][0] + BAND[s.band].slice(1).toLowerCase()} · ${s.risk}</span>` : '–'}</td>
            <td class="st"><span class="status ${sc}">${st}</span>${required(c) === 2 && c.status === 'needs_review' ? '<div class="sub">needs 2 signatures</div>' : ''}</td>
            <td class="act">${laneOf(c).ok && ['needs_review', 'awaiting_second'].includes(c.status) ? `<button class="btn sm green" data-fast="${c.id}" title="${esc(laneOf(c).reason)}">Approve</button>` : '<span class="open-link">Review</span>'}</td></tr>`;
        }).join('')}</tbody></table></div>`
      : `<div class="empty-state">${sigNote('wave', cs.length ? 'Nothing in this tab' : 'No bills yet', cs.length ? 'Try another tab.' : 'Connect Gmail in Mailbox, or upload a PDF or photo of a bill.')}${cs.length ? '' : '<div style="margin-top:14px"><button class="btn sm" data-open-upload>Upload bills</button></div>'}</div>`}
    </div>`;
  page.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => { state.tab = b.dataset.tab; renderInbox(); }));
  page.querySelectorAll('[data-case]').forEach((r) => r.addEventListener('click', () => (location.hash = `case/${r.dataset.case}`)));
  page.querySelector('[data-open-upload]')?.addEventListener('click', openDrawer);
  page.querySelectorAll('[data-fast]').forEach((b) => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    const c = state.cases.find((x) => x.id === b.dataset.fast);
    b.disabled = true; b.textContent = 'Signing…';
    try {
      const r = await api(`/api/cases/${c.id}/decision`, { method: 'POST', body: { userId: state.me, action: 'approve', reason: laneOf(c).reason } });
      toast(r.status === 'approved' ? `Approved ${c.fields.vendorName} (fast lane).` : 'Signed. A second person must countersign.');
      route();
    } catch (er) { toast(er.message, true); b.disabled = false; b.textContent = 'Approve'; }
  }));
  inboxKeys(rows);
  mountSigs(page);
}

// ---------------------------------------------------------------------------
// Upload → read → review → create case
// ---------------------------------------------------------------------------
const SAMPLES = [
  ['fraud-lookalike-google-cloud.pdf', 'application/pdf', 'Fake “Google Cloud” bill (PDF)'],
  ['vercel-october.pdf', 'application/pdf', 'Vercel, October (PDF)'],
  ['vercel-duplicate.pdf', 'application/pdf', 'Vercel, already paid (PDF)'],
  ['brightline-first-invoice.png', 'image/png', 'New vendor, photo (PNG, read with OCR)'],
];

function openDrawer() { $('drawer').classList.add('on'); $('scrim').classList.add('on'); }
function closeDrawer() { $('drawer').classList.remove('on'); $('scrim').classList.remove('on'); }
$('upload-btn').addEventListener('click', openDrawer);
$('drawer-close').addEventListener('click', closeDrawer);
$('scrim').addEventListener('click', closeDrawer);
$('samples').innerHTML = SAMPLES.map(([f, , label]) => `<button type="button" data-sample="${f}">${esc(label)}</button>`).join('');
$('samples').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-sample]'); if (!b) return;
  e.preventDefault();
  const [f, mime] = SAMPLES.find((s) => s[0] === b.dataset.sample);
  const blob = await fetch(`samples/${f}`).then((r) => r.blob());
  startJob(new File([blob], f, { type: mime }));
});
const dz = $('dropzone');
dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
dz.addEventListener('dragleave', () => dz.classList.remove('over'));
dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('over'); [...e.dataTransfer.files].forEach(startJob); });
$('file').addEventListener('change', (e) => { [...e.target.files].forEach(startJob); e.target.value = ''; });
// Dropping a file anywhere on the console opens the drawer.
addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); openDrawer(); } });
addEventListener('drop', (e) => { if (!dz.contains(e.target) && e.dataTransfer?.files?.length) { e.preventDefault(); [...e.dataTransfer.files].forEach(startJob); } });

const FIELD_FORM = [
  ['vendorName', 'Vendor name', ''], ['senderEmail', 'Sender email', ''], ['number', 'Invoice number', ''], ['amount', 'Total due', ''],
  ['issued', 'Issue date', ''], ['due', 'Due date', ''], ['bankLast4', 'Bank account (last 4)', ''], ['address', 'Vendor address', 'wide'],
];

function confBadge(meta, hasValue = true) {
  if (!meta) return '';
  if (meta.source === 'human') return '<span class="conf human">edited by a person</span>';
  const word = meta.confidence === 'high' ? 'read' : meta.confidence === 'medium' ? 'check' : hasValue ? 'guess' : 'missing';
  return `<span class="conf ${meta.confidence}" title="${esc(meta.rule ?? '')}">${word}</span>`;
}

async function renderPdfInto(container, src, { maxPages = 3, scale = 1.4, first = false, marks = [] } = {}) {
  const lib = await import('../../vendor/pdf.min.mjs');
  lib.GlobalWorkerOptions.workerSrc = new URL('../../vendor/pdf.worker.min.mjs', import.meta.url).href;
  // Stripe-style invoices use fonts that need pdf.js's character maps and standard font data.
  const PDFJS_CDN = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/';
  const opts = typeof src === 'string' ? { url: src } : { ...src };
  const doc = await lib.getDocument({ ...opts, cMapUrl: PDFJS_CDN + 'cmaps/', cMapPacked: true, standardFontDataUrl: PDFJS_CDN + 'standard_fonts/' }).promise;
  container.innerHTML = '';
  for (let p = 1; p <= Math.min(doc.numPages, first ? 1 : maxPages); p++) {
    const pg = await doc.getPage(p);
    const vp = pg.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = vp.width; canvas.height = vp.height;
    await pg.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
    if (!marks.length) { container.append(canvas); continue; }
    // Highlights: find each suspicious value in the page's text and box it.
    const wrap = document.createElement('div');
    wrap.className = 'pagewrap';
    wrap.append(canvas);
    const items = (await pg.getTextContent()).items;
    for (const it of items) {
      const text = (it.str || '').replace(/\u0000/g, '-').toLowerCase();
      if (!text.trim()) continue;
      const m = marks.find((mk) => mk.needles.some((n) => n && text.includes(n)));
      if (!m) continue;
      const t = lib.Util.transform(vp.transform, it.transform);
      const h = Math.hypot(t[2], t[3]);
      const box = document.createElement('div');
      box.className = `hlbox ${m.sev}`;
      box.title = m.label;
      Object.assign(box.style, {
        left: `${((t[4] - 2) / vp.width) * 100}%`, top: `${((t[5] - h * 1.05) / vp.height) * 100}%`,
        width: `${((it.width * scale + 4) / vp.width) * 100}%`, height: `${((h * 1.35) / vp.height) * 100}%`,
      });
      wrap.append(box);
    }
    container.append(wrap);
  }
}

const toBase64 = (buf) => {
  const bytes = new Uint8Array(buf); let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

async function startJob(file, opts = {}) {
  openDrawer();
  const el = document.createElement('div');
  el.className = 'job';
  el.innerHTML = `<div class="job-h"><span class="name">${esc(file.name)}${opts.email ? ` <span class="note">from ${esc(opts.email.from)}</span>` : ''}</span><div class="steps">
      <span class="step" data-s="read">Read</span><span class="step" data-s="extract">Extract</span><span class="step" data-s="review">You confirm</span><span class="step" data-s="check">Live checks</span></div></div>
    <div class="job-b"><div class="thumb">…</div><div class="fgrid"><div class="note wide">Reading the document…</div></div></div>`;
  $('jobs').prepend(el);
  const step = (s, cls) => el.querySelector(`[data-s="${s}"]`).className = `step ${cls}`;
  const thumb = el.querySelector('.thumb');
  const form = el.querySelector('.fgrid');

  if (file.type === 'application/pdf') renderPdfInto(thumb, { data: new Uint8Array(await file.arrayBuffer()) }, { first: true, scale: .5 }).catch(() => (thumb.textContent = 'PDF'));
  else if (file.type.startsWith('image/')) thumb.innerHTML = `<img alt="" src="${URL.createObjectURL(file)}">`;

  let doc, parsed;
  try {
    step('read', 'on');
    doc = await readDocument(file, (msg) => (form.querySelector('.note').textContent = msg + '…'));
    step('read', 'done'); step('extract', 'on');
    parsed = parseFields(doc.text, { companyDomain: state.policy?.companyDomain ?? '' });
    step('extract', 'done'); step('review', 'on');
  } catch (e) {
    step('read', 'err'); form.innerHTML = `<div class="note err wide">${esc(e.message)}</div>`; return;
  }

  const meta = parsed.meta;
  if (opts.email?.from) {
    // The email's own From header beats any address printed inside the attachment.
    parsed.fields.senderEmail = opts.email.from;
    meta.senderEmail = { confidence: 'high', rule: 'From header of the email (verified by Gmail)' };
  }
  form.innerHTML = FIELD_FORM.map(([k, label, cls]) => `<div class="field ${cls}"><label>${label} <span data-conf="${k}">${confBadge(meta[k], !!parsed.fields[k])}</span></label>
    <input class="input" data-f="${k}" value="${esc(parsed.fields[k] ?? '')}"></div>`).join('');
  form.querySelectorAll('[data-f]').forEach((inp) => inp.addEventListener('input', () => {
    meta[inp.dataset.f] = { source: 'human', by: state.me };
    form.querySelector(`[data-conf="${inp.dataset.f}"]`).innerHTML = confBadge(meta[inp.dataset.f]);
  }));
  const missing = FIELD_FORM.filter(([k]) => !parsed.fields[k]).length;
  const foot = document.createElement('div');
  foot.className = 'job-f';
  foot.innerHTML = `<small>${esc(doc.method)} · ${missing ? `${missing} field${missing > 1 ? 's' : ''} need you` : 'all fields read'} · hover a badge to see the rule</small>
    <button class="btn sm">Confirm and check</button>`;
  el.append(foot);
  foot.querySelector('button').addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    const fields = { ...parsed.fields };
    form.querySelectorAll('[data-f]').forEach((i) => (fields[i.dataset.f] = i.value.trim()));
    if (!/@[a-z0-9.-]+\.[a-z]{2,}$/i.test(fields.senderEmail)) return toast('Sender email is needed. Check the bill and type it in.', true);
    if (!(Number(String(fields.amount).replace(/[^0-9.]/g, '')) > 0)) return toast('Total due is needed.', true);
    btn.disabled = true; btn.textContent = 'Checking live…';
    step('review', 'done'); step('check', 'on');
    try {
      const c = await api('/api/cases', { method: 'POST', body: { userId: state.me, file: { name: file.name, mime: file.type, dataBase64: toBase64(doc.buf) }, fields, fieldMeta: meta, text: doc.text, docMeta: doc.meta ?? null, mailRef: opts.mailRef } });
      step('check', 'done');
      const s = c.check.score;
      foot.innerHTML = `<small>Stamped <span class="pill ${s.band}">${BAND[s.band]}</span> risk ${s.risk} · confidence ${s.confidence}% · live data cost $${c.check.cost.toFixed(4)}</small><a class="btn sm" href="#case/${c.id}">Open case</a>`;
      foot.querySelector('a').addEventListener('click', closeDrawer);
      refreshHealth();
      if (!location.hash.startsWith('#case')) route();
    } catch (e) {
      step('check', 'err'); btn.disabled = false; btn.textContent = 'Retry'; toast(e.message, true);
    }
  });
}

// ---------------------------------------------------------------------------
// Case view
// ---------------------------------------------------------------------------
let caseState = null;

async function renderCase(id) {
  const c = await api(`/api/cases/${id}`);
  const auditAll = await api('/api/audit');
  caseState = { c, dismissed: new Set(c.dismissed ?? []), audit: auditAll.entries.filter((e) => e.caseId === id) };
  setHead(`${c.fields.vendorName || 'Bill'} · ${c.fields.number || ''}`, `<a href="#inbox">Inbox</a> / Case ${esc(c.id)}`);
  const [st, sc] = STATUS[c.status] ?? [c.status, ''];
  page.innerHTML = `
    <div class="case-head">
      <div>
        <h2>${esc(c.fields.vendorName || 'Unknown vendor')}</h2>
        <div class="meta"><span class="status ${sc}">${st}</span>
          <span class="facts">Invoice <b class="mono">${esc(c.fields.number || '–')}</b> · due ${esc(c.fields.due || 'unknown')} · from <span class="mono">${esc(c.fields.senderEmail || 'unknown')}</span></span></div>
        <div class="facts sub-facts">${[c.vendorKey ? 'Vendor you’ve paid before' : 'New vendor', c.billedVia ? `Billed through ${esc(c.billedVia.platform)}, so we checked ${esc(c.billedVia.merchant)}` : '', c.demo ? 'Sample email' : ''].filter(Boolean).join(' · ')}</div>
      </div>
      <div><div class="lbl" style="text-align:right">Total due</div><div class="amt">${money(c.fields.amount, c.fields.currency)}</div></div>
    </div>
    <div class="case-grid">
      <div class="card viewer"><div class="card-h"><h2>Document</h2><span class="note">${c.file ? esc(c.file.name) : 'no file'}${c.file ? ` · <a href="/files/${esc(c.file.stored)}" target="_blank" rel="noopener">Open original</a>` : ''}</span></div>
        <div class="card-b" id="viewer"><div class="nofile">${c.file ? 'Loading document…' : 'This case was created without a file.'}</div></div></div>
      <div class="side-stack">
        <section class="panel-v" id="stampbox"></section>
        <section class="panel-x" id="callpanel" hidden><h3>Call the vendor</h3><div id="callbox"></div></section>
        <section class="panel-x"><h3>Your decision</h3><div id="sigbox"></div></section>
        <section class="panel-x"><h3>What we checked</h3><div id="checks"></div></section>
        <details class="panel-x fold"><summary><h3>Evidence</h3><span class="note">where the data came from</span></summary><div id="evidence"></div>
          <div style="margin-top:12px"><button class="btn sm quiet" id="recheck">Check again with fresh data</button></div></details>
        <details class="panel-x fold"><summary><h3>Bill details</h3><span class="note">fix anything we read wrong</span></summary><div class="fgrid" id="fields"></div>
          <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:12px"><span class="note">Saving re-runs every check and clears signatures.</span><button class="btn sm quiet" id="save-fields">Save and check again</button></div></details>
        <details class="panel-x fold"><summary><h3>Activity</h3><span class="note" id="act-count"></span></summary><div class="timeline" id="timeline"></div><a class="note" href="#audit">Open the full audit log</a></details>
      </div>
    </div>`;

  // document, with the suspicious parts highlighted
  const viewer = $('viewer');
  const marks = docMarks(c);
  if (marks.length && c.file?.mime === 'application/pdf') {
    viewer.insertAdjacentHTML('beforebegin', `<div class="doc-legend"><span>Highlighted on the bill:</span>${marks.map((m) => `<span class="lg ${m.sev}">${esc(m.label)}</span>`).join('')}</div>`);
  }
  if (c.file?.mime === 'application/pdf') renderPdfInto(viewer, `/files/${c.file.stored}`, { scale: 1.5, marks }).catch((e) => (viewer.innerHTML = `<div class="nofile">Couldn't render the PDF: ${esc(e.message)}</div>`));
  else if (c.file) viewer.innerHTML = `<img alt="Uploaded bill" src="/files/${esc(c.file.stored)}">`;

  paintCase();
  // fields
  $('fields').innerHTML = FIELD_FORM.map(([k, label, cls]) => `<div class="field ${cls}"><label>${label} ${c.fieldMeta?.[k]?.confidence === 'high' && c.fieldMeta?.[k]?.source !== 'human' ? '' : confBadge(c.fieldMeta?.[k], !!c.fields[k])}</label><input class="input" data-f="${k}" value="${esc(c.fields[k] ?? '')}" ${['approved', 'rejected', 'dismissed'].includes(c.status) ? 'disabled' : ''}></div>`).join('');
  $('save-fields').disabled = ['approved', 'rejected', 'dismissed'].includes(c.status);
  $('save-fields').addEventListener('click', async () => {
    const fields = {}; document.querySelectorAll('#fields [data-f]').forEach((i) => (fields[i.dataset.f] = i.value.trim()));
    try { await api(`/api/cases/${c.id}/fields`, { method: 'POST', body: { userId: state.me, fields } }); toast('Saved. Every check ran again.'); renderCase(c.id); } catch (e) { toast(e.message, true); }
  });
  $('recheck').addEventListener('click', async (e) => {
    e.currentTarget.disabled = true; e.currentTarget.textContent = 'Checking…';
    try { await api(`/api/cases/${c.id}/recheck`, { method: 'POST', body: { userId: state.me } }); toast('Fresh live lookup done.'); refreshHealth(); renderCase(c.id); } catch (er) { toast(er.message, true); }
  });
  // timeline
  $('act-count').textContent = `${caseState.audit.length} event${caseState.audit.length === 1 ? '' : 's'}`;
  $('timeline').innerHTML = caseState.audit.length ? caseState.audit.map((e) => `<div class="tl"><i></i><div><b>${esc(personName(e.actor))}</b> ${esc(describe(e))}<div class="when">${new Date(e.at).toLocaleString()} · <span class="hash">#${e.seq} ${e.hash.slice(0, 10)}</span></div></div></div>`).join('') : '<div class="note">No activity yet.</div>';
}

// Callback verification: an AI voice call to the number we trust, never the one on the bill.
let callTimer = null;
async function paintCall(c, band, closed) {
  const box = $('callbox'), panel = $('callpanel');
  if (!box) return;
  const cb = c.callback;
  panel.hidden = !cb && (band === 'clear' || closed);
  if (panel.hidden) return;
  const plan = callPlan(c, state.vendors.find((v) => v.key === c.vendorKey));
  const live = cb && !cb.result;
  const numbers = `<dl class="kv">
      <dt>We call</dt><dd>${plan.trusted ? `<span class="mono">${esc(prettyPhone(plan.trusted))}</span> <span class="sub">from ${esc(plan.source)}</span>` : '<span class="sub">no trusted number on file</span>'}</dd>
      <dt>On the bill</dt><dd>${plan.onBill.length ? plan.onBill.map((p) => `<span class="mono">${esc(prettyPhone(p))}</span>`).join(', ') : '<span class="sub">none printed</span>'}${plan.mismatch ? ' <span class="status stop">not the company’s number</span>' : ''}</dd></dl>`;
  if (!cb) {
    state.calling ??= (await api('/api/health').catch(() => ({}))).calling ?? { ready: false };
    box.innerHTML = `${numbers}
      <p class="note">An AI voice asks one question, "Did you send this bill?", waits for a yes or no, and hangs up. A no stops the bill; a yes clears a HOLD (it never unlocks a STOP). We never dial the number printed on the bill: a scammer prints their own.</p>
      <div style="display:flex;gap:10px;align-items:center;margin-top:10px"><button class="btn sm" id="call-go" ${state.calling.ready || state.calling.web ? '' : 'disabled'}>Verify with an AI call</button>
      ${state.calling.ready ? (state.calling.demoRouted ? '<span class="note">Demo: the call rings the demo phone instead.</span>' : '') : state.calling.web ? '<span class="note">Live demo: the agent talks through this laptop. Answer out loud.</span>' : '<span class="note">Calling isn’t set up (add the Vapi keys to core/.env).</span>'}</div>`;
    if (!state.calling.ready && state.calling.web) { $('call-go')?.addEventListener('click', () => startWebCall(c)); return; }
    $('call-go')?.addEventListener('click', async () => {
      $('call-go').disabled = true; $('call-go').textContent = 'Calling…';
      try { caseState.c = await api(`/api/cases/${c.id}/call`, { method: 'POST', body: { userId: state.me } }); paintCase(); }
      catch (e) { toast(e.message, true); $('call-go').disabled = false; $('call-go').textContent = 'Verify with an AI call'; }
    });
    return;
  }
  const STATUS = { calling: 'Placing the call…', queued: 'Placing the call…', ringing: 'Ringing…', 'in-progress': 'On the call…', forwarding: 'On the call…', ended: 'Call ended' };
  const res = cb.result;
  box.innerHTML = `${numbers}
    <div class="call-state ${res ?? 'live'}">
      <b>${res ? esc(CALL_LABEL[res] ?? res) : esc(STATUS[cb.status] ?? 'Calling…')}</b>
      <span class="note">Dialed ${esc(cb.dialed)}${cb.demoRouted ? ' (demo phone)' : ''} · ${ago(cb.startedAt)}</span>
    </div>
    ${cb.transcript?.length ? `<div class="call-tx">${cb.transcript.map((m) => `<p><b>${esc(m.who)}:</b> ${esc(m.text)}</p>`).join('')}</div>` : live ? `<p class="note">“${esc(cb.question)}”</p>` : ''}
    ${res && !closed ? '<div style="margin-top:10px"><button class="btn sm quiet" id="call-again">Call again</button></div>' : ''}`;
  $('call-again')?.addEventListener('click', async () => {
    if (cb.mode === 'web') return startWebCall(c);
    try { caseState.c = await api(`/api/cases/${c.id}/call`, { method: 'POST', body: { userId: state.me, again: true } }); paintCase(); } catch (e) { toast(e.message, true); }
  });
  clearTimeout(callTimer);
  if (cb.mode === 'web' && live) {
    box.querySelector('.call-tx')?.remove();
    box.insertAdjacentHTML('beforeend', `<div class="call-tx" id="call-live">${webCall.lines.map((m) => `<p><b>${esc(m.who)}:</b> ${esc(m.text)}</p>`).join('') || `<p class="note">“${esc(cb.question)}”</p>`}</div>
      <div style="margin-top:10px"><button class="btn sm quiet" id="call-hang">Hang up</button></div>`);
    $('call-hang').addEventListener('click', () => (webCall.vapi ? webCall.vapi.stop() : finishWebCall(c.id, 'hung up before connecting')));
    return;
  }
  if (live) callTimer = setTimeout(async () => {
    if (!location.hash.includes(c.id)) return;
    try { caseState.c = await api(`/api/cases/${c.id}`); paintCase(); } catch {}
  }, 2500);
}

// Browser mode: the same agent, through the laptop's speaker and mic (Vapi web SDK).
const webCall = { vapi: null, lines: [], callId: null, caseId: null, done: false };
async function startWebCall(c) {
  if (webCall.vapi) return;
  let start;
  try { start = await api(`/api/cases/${c.id}/webcall`, { method: 'POST', body: { userId: state.me } }); }
  catch (e) { return toast(e.message, true); }
  Object.assign(webCall, { lines: [], callId: null, caseId: c.id, done: false });
  caseState.c = start.case; paintCase();
  try {
    const { default: Vapi } = await import('https://cdn.jsdelivr.net/npm/@vapi-ai/web@2.5.2/+esm');
    const vapi = new (Vapi.default ?? Vapi)(start.publicKey);
    webCall.vapi = vapi;
    vapi.on('message', (m) => {
      if (m?.type !== 'transcript' || m.transcriptType !== 'final' || !m.transcript) return;
      webCall.lines.push({ who: m.role === 'user' ? 'Vendor' : 'Countersign', text: m.transcript });
      const box = $('call-live'); if (box) box.innerHTML = webCall.lines.map((x) => `<p><b>${esc(x.who)}:</b> ${esc(x.text)}</p>`).join('');
    });
    vapi.on('call-end', () => finishWebCall(c.id, 'call ended'));
    vapi.on('error', (e) => { console.warn('vapi', e); if (!webCall.lines.length) finishWebCall(c.id, 'error: ' + (e?.error?.message ?? e?.message ?? 'call failed')); });
    const call = await vapi.start(start.assistant);
    webCall.callId = call?.id ?? null;
  } catch (e) { toast('Couldn’t start the call: ' + e.message, true); finishWebCall(c.id, 'error: ' + e.message); }
}
async function finishWebCall(caseId, reason) {
  if (webCall.done || webCall.caseId !== caseId) return;
  webCall.done = true;
  try { webCall.vapi?.stop(); } catch {}
  webCall.vapi = null;
  try {
    const c = await api(`/api/cases/${caseId}/webcall`, { method: 'POST', body: { userId: state.me, done: true, callId: webCall.callId, transcript: webCall.lines, endedReason: reason } });
    if (caseState?.c?.id === caseId) { caseState.c = c; paintCase(); }
    toast(CALL_LABEL[c.callback?.result] ?? 'Call ended');
  } catch (e) { toast(e.message, true); }
}

// What to highlight on the document: one entry per failed check, with the text to look for.
function docMarks(c) {
  const flagged = Object.fromEntries((c.check?.results ?? []).filter((r) => r.status === 'flag' && !(c.dismissed ?? []).includes(r.id)).map((r) => [r.id, r]));
  const sev = (id) => (flagged[id]?.severity === 'high' ? 'high' : 'med');
  const f = c.fields, out = [];
  const dom = String(f.senderEmail ?? '').split('@')[1]?.toLowerCase();
  if ((flagged.lookalike || flagged.footprint || flagged.reports) && dom) out.push({ label: flagged.lookalike ? 'Lookalike sender' : 'Unknown sender domain', sev: flagged.lookalike ? sev('lookalike') : sev('footprint'), needles: [dom] });
  if (flagged.bank && f.bankLast4) out.push({ label: 'New bank account', sev: sev('bank'), needles: [String(f.bankLast4)] });
  if (flagged.amount && f.amount) {
    const a = Number(f.amount);
    out.push({ label: 'Unusual amount', sev: sev('amount'), needles: [a.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }), a.toLocaleString('en-US')] });
  }
  if (flagged.address && f.address) out.push({ label: 'Address doesn’t match', sev: sev('address'), needles: [f.address.split(',')[0].toLowerCase()] });
  if (flagged.duplicate && f.number) out.push({ label: 'Already paid', sev: sev('duplicate'), needles: [String(f.number).toLowerCase()] });
  for (const d of (c.check?.doc?.checks ?? []).filter((x) => x.status === 'flag' && !(c.dismissed ?? []).includes(x.id))) {
    const sv = d.severity === 'high' ? 'high' : 'med';
    if (d.id === 'banknum') { const n = String(d.finding).match(/\d{6,}|[A-Z]{2}\d{2}[A-Z0-9]{8,}/); if (n) out.push({ label: 'Fake bank number', sev: sv, needles: [n[0].toLowerCase()] }); }
    if (d.id === 'arith') { const n = [...String(d.finding).matchAll(/\$([\d,]+\.\d{2})/g)].pop(); if (n) out.push({ label: 'Total doesn’t add up', sev: sv, needles: [n[1]] }); }
  }
  if (flagged.pressure) {
    const words = [...String(flagged.pressure.evidence?.[0]?.value ?? '').matchAll(/"([^"]+)"/g)].map((m) => m[1].toLowerCase());
    if (words.length) out.push({ label: 'Pressure to pay fast', sev: sev('pressure'), needles: words });
  }
  return out;
}

function describe(e) {
  const d = e.detail ?? {};
  switch (e.action) {
    case 'case.created': return `${d.via && d.via !== 'upload' ? `received the bill (${d.via})` : 'uploaded the bill'}. Stamped ${BAND[d.stamp] ?? d.stamp}, risk ${d.risk}.`;
    case 'case.fields_edited': return `edited ${Object.keys(d.changes ?? {}).join(', ')}. Re-stamped ${BAND[d.stamp] ?? ''}.`;
    case 'case.rechecked': return `ran a fresh live check. ${BAND[d.stamp] ?? ''}, risk ${d.risk}.`;
    case 'case.signed': return `signed (${d.signatures}). “${d.reason}”`;
    case 'case.approved': return `gave the final signature. Approved to pay. “${d.reason}”`;
    case 'case.rejected': return `rejected the bill. “${d.reason}”`;
    case 'case.held': return `put the bill on hold. “${d.reason}”`;
    case 'case.dismissed': return `marked it “not a bill”. “${d.reason}”`;
    case 'policy.weights_learned': return `learned from ${d.from}: ${(d.changes ?? []).map((c) => `${NAMES[c.id]} ${c.before} to ${c.after}`).join(', ')}`;
    case 'case.callback_started': return `started an AI verification call to ${d.to}${d.source ? ` (${d.source})` : ''}${d.demoRouted ? ', routed to the demo phone' : ''}.`;
    case 'case.callback_result': return `${({ confirmed: 'The vendor confirmed the bill by phone', denied: 'The vendor said they did not send this bill', unclear: 'The call ended without a clear answer', no_answer: 'Nobody answered the call', failed: 'The call failed' })[d.result] ?? d.result}${d.said ? `: “${d.said}”` : ''}. Re-stamped ${BAND[d.stamp] ?? d.stamp}.`;
    case 'vendor.created': return `added vendor ${d.vendor} (${d.domain ?? ''}).`;
    case 'mailbox.samples_loaded': return `loaded ${d.emails} sample emails (never sent through real email).`;
    case 'mailbox.auto_ingested': return `pulled ${d.newMessages} new email${d.newMessages === 1 ? '' : 's'} from Gmail and opened ${d.created} case${d.created === 1 ? '' : 's'} automatically.`;
    case 'mailbox.synced': return `synced Gmail: ${d.newMessages} new email${d.newMessages === 1 ? '' : 's'}, ${d.newFiles} bill file${d.newFiles === 1 ? '' : 's'}.`;
    default: return e.action;
  }
}

function paintCase() {
  const { c, dismissed } = caseState;
  const results = c.check.results;
  const weights = { ...DEFAULT_WEIGHTS, ...(state.policy.weights ?? {}) };
  if (c.email) c.check.email = analyzeEmail(c.email);
  const s = applyCallback(applyDocument(applyEmail(score(results, weights, { dismissed, isNewVendor: !c.vendorKey }), c.check.email), withoutDismissed(c.check.doc, dismissed)), c.callback);
  const closed = ['approved', 'rejected', 'dismissed'].includes(c.status);
  const HEAD = { stop: 'Do not pay this bill', hold: 'Take a closer look', clear: 'Looks right' };
  $('stampbox').className = `panel-v ${s.band}`;
  $('stampbox').innerHTML = `
    <div class="verdict">
      <span data-sig data-mood="${s.band}" style="width:88px"></span>
      <div>
        <span class="v-label">${BAND[s.band][0] + BAND[s.band].slice(1).toLowerCase()}</span>
        <h3 class="v-head">${HEAD[s.band]}</h3>
        <p class="v-text">${esc(s.reason)}</p>
        <p class="v-nums">Risk ${s.risk} of 100 · ${s.confidence}% of checks had data${dismissed.size ? ' · preview with your false alarms' : ''}</p>
      </div>
    </div>
    ${s.combos.length ? `<ul class="v-patterns">${s.combos.map((k) => `<li>${esc(k.label)}</li>`).join('')}</ul>` : ''}`;
  mountSigs($('stampbox'));
  paintCall(c, s.band, closed);

  const emailRows = (c.check.email?.checks ?? []).map((r) => ({ ...r, group: 'Email', evidence: [], why: r.finding }));
  const docRows = (c.check.doc?.checks ?? []).map((r) => ({ ...r, group: 'Document', evidence: [] }));
  const all = [...results.map((r) => ({ ...r, group: 'Bill' })), ...emailRows, ...docRows];
  const problems = all.filter((r) => r.status === 'flag' && !dismissed.has(r.id));
  const dismissedRows = all.filter((r) => dismissed.has(r.id));
  const passed = all.filter((r) => r.status === 'pass').length;
  const nodata = all.filter((r) => r.status === 'unknown').length;
  const row = (r, open) => {
    const isD = dismissed.has(r.id);
    return `<div class="crow ${r.status === 'flag' && !isD ? 'bad ' + (r.severity === 'high' ? 'high' : 'med') : r.status} ${isD ? 'dismissed' : ''}">
      <span class="cdot"></span>
      <div class="cbody"><div class="cname">${esc(r.name)}${r.group !== 'Bill' ? ` <span class="tag">${r.group.toLowerCase()}</span>` : ''}</div><div class="cfind">${esc(r.finding)}</div>
        ${open && r.why && r.why !== r.finding ? `<div class="cwhy">${esc(r.why)}</div>` : ''}
        ${r.status === 'flag' && !closed && r.group !== 'Email' ? `<label class="fa"><input type="checkbox" data-dis="${r.id}" ${isD ? 'checked' : ''}> This is a false alarm, I know why</label>` : ''}</div></div>`;
  };
  $('checks').innerHTML = `
    <p class="csum">${all.length} checks: <b class="ok">${passed} passed</b> · <b class="${problems.length ? 'bad' : ''}">${problems.length} problem${problems.length === 1 ? '' : 's'}</b> · ${nodata} without data</p>
    ${problems.length ? problems.map((r) => row(r, true)).join('') : '<p class="cnone">Nothing suspicious found.</p>'}
    ${dismissedRows.map((r) => row(r, false)).join('')}
    <details class="call"><summary>Show all ${all.length} checks</summary>${all.filter((r) => !(r.status === 'flag' && !dismissed.has(r.id)) && !dismissed.has(r.id)).map((r) => row(r, false)).join('')}</details>`;
  $('checks').querySelectorAll('[data-dis]').forEach((cb) => cb.addEventListener('change', () => { cb.checked ? dismissed.add(cb.dataset.dis) : dismissed.delete(cb.dataset.dis); paintCase(); }));

  // evidence: email headers + live sources, plain rows
  const e = c.email;
  $('evidence').innerHTML = `
    ${e ? `<div class="ev-block"><div class="ev-title">The email</div>
      <dl class="kv"><dt>From</dt><dd>${esc(e.fromName ? e.fromName + ' · ' : '')}<span class="mono">${esc(e.from)}</span></dd>
      ${e.replyTo ? `<dt>Replies go to</dt><dd class="mono">${esc(e.replyTo)}</dd>` : ''}
      <dt>Subject</dt><dd>${esc(e.subject)}</dd><dt>Received</dt><dd>${new Date(e.date).toLocaleString()}</dd>
      <dt>Gmail's check</dt><dd>SPF ${esc(e.auth?.spf ?? 'none')} · DKIM ${esc(e.auth?.dkim ?? 'none')} · DMARC ${esc(e.auth?.dmarc ?? 'none')}</dd></dl></div>` : ''}
    <div class="ev-block"><div class="ev-title">Live data</div>
      ${(c.check.sources ?? []).map((x) => `<div class="ev-row"><div><b>${esc(x.source.replace(/^Glasser · /, ''))}</b><span class="sub">${x.source.startsWith('Glasser') ? 'via Glasser' : ''}${x.cached ? ' · cached' : x.charge ? ` · $${x.charge.toFixed(4)}` : ''}</span></div>
        <div class="ev-val">${esc(x.value)}${x.runUrl ? ` <a href="${esc(x.runUrl)}" target="_blank" rel="noopener">source</a>` : ''}</div></div>`).join('')}
      <p class="note">Checked ${ago(c.check.checkedAt)}. This lookup cost $${(c.check.cost ?? 0).toFixed(4)}.</p></div>`;

  // signatures + decision
  const need = required(c);
  const slots = Array.from({ length: need }, (_, i) => c.approvals[i]);
  const iSigned = c.approvals.some((a) => a.userId === state.me);
  const iUploaded = c.createdBy === state.me;
  const fast = laneOf(c).ok && !iSigned && !iUploaded;
  const me = state.users.find((u) => u.id === state.me);
  const sigsHtml = (need > 1 || c.approvals.length) ? `<p class="note" style="margin:0 0 8px">${need === 2 ? `Bills of ${money(state.policy.dualApprovalOver)} or more need two different people.` : 'One signature needed.'}</p><div class="sigs">${slots.map((a, i) => a
      ? `<div class="sigline"><span class="avatar-i">${initials(a.name)}</span><div><b>${esc(a.name)}</b> <span class="note">${esc(a.role)} · ${new Date(a.at).toLocaleString()}</span><div class="note">“${esc(a.reason)}”</div></div><svg viewBox="0 0 180 60"><path d="${SIGNATURE_PATH}"/></svg></div>`
      : `<div class="sigline empty">Signature ${i + 1}: ${i === 0 ? 'anyone who can approve' : 'a different person'}</div>`).join('')}</div>` : '';
  $('sigbox').innerHTML = `${sigsHtml}
    ${closed ? `<p class="note" style="margin-top:12px">This ${c.status === 'dismissed' ? 'document was marked “not a bill”' : `bill is ${c.status === 'approved' ? 'approved and ready to pay' : 'rejected'}`}. Closed cases can't be changed.</p>` : `
    <div class="decide">
      ${fast ? '<div class="hint">Routine bill. We wrote the reason from the evidence; read it, then approve.</div>' : ''}
      <label class="field"><span class="flabel">Reason (saved in the audit log)</span><textarea class="textarea" id="reason" placeholder="e.g. Called the vendor on the number in our records and confirmed the bill.">${fast ? esc(laneOf(c).reason) : ''}</textarea></label>
      <div class="row">
        <button class="btn green" id="d-approve" ${s.band === 'stop' || iSigned || iUploaded ? 'disabled' : ''}>${c.approvals.length && need > c.approvals.length ? 'Countersign' : 'Approve'}</button>
        <button class="btn quiet" id="d-hold">Hold</button>
        <button class="btn danger" id="d-reject">Reject</button>
      </div>
      <button class="linkbtn" id="d-dismiss" style="justify-self:start">This isn’t a bill (receipt, duplicate, ticket)</button>
      <p class="note ${s.band === 'stop' ? 'err' : ''}">${s.band === 'stop' ? 'Approve is locked because this bill is marked Stop.'
        : iUploaded ? 'You uploaded this bill, so someone else has to approve it (switch person at the top right).'
        : iSigned ? 'You already signed. A different person needs to countersign.'
        : `Signing as ${esc(me?.name ?? '')}, ${esc(me?.role ?? '')}.`}</p>
    </div>`}`;
  if (!closed) {
    const go = (action) => async () => {
      const reason = $('reason').value.trim();
      if (reason.length < 3) return toast('Write a short reason first. It goes in the audit log.', true);
      try {
        const res = await api(`/api/cases/${c.id}/decision`, { method: 'POST', body: { userId: state.me, action, reason, dismissed: [...dismissed] } });
        toast(res.status === 'awaiting_second' ? 'Signed. A second person must countersign.' : res.status === 'approved' ? 'Approved. Signed by people, ready to pay.' : res.status === 'rejected' ? 'Rejected. Nothing will be paid.' : res.status === 'dismissed' ? 'Marked as not a bill.' : 'On hold.');
        renderCase(c.id);
      } catch (e) { toast(e.message, true); }
    };
    $('d-approve').addEventListener('click', go('approve'));
    $('d-hold').addEventListener('click', go('hold'));
    $('d-reject').addEventListener('click', go('reject'));
    $('d-dismiss').addEventListener('click', () => { if (!$('reason').value.trim()) $('reason').value = 'Not a bill to pay.'; go('dismiss')(); });
  }
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts (finance teams clear queues from the keyboard)
// ---------------------------------------------------------------------------
let keyCtx = { rows: [], sel: -1 };
const typing = () => /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '');
function inboxKeys(rows) { keyCtx = { rows: rows.map((c) => c.id), sel: -1 }; }
function openList() {
  const tab = TABS.find((t) => t[0] === state.tab) ?? TABS[0];
  return state.cases.filter(tab[2]).map((c) => c.id);
}
addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const [name, arg] = location.hash.slice(1).split('/');
  if (e.key === 'Escape') { if (name === 'case') location.hash = 'inbox'; else closeDrawer(); return; }
  if (typing()) return;
  const k = e.key.toLowerCase();
  if (name === 'case' && arg) {
    const list = openList(); const i = list.indexOf(arg);
    if (k === 'j' && list[i + 1]) location.hash = `case/${list[i + 1]}`;
    else if (k === 'k' && i > 0) location.hash = `case/${list[i - 1]}`;
    else if (k === 'a') $('d-approve')?.click();
    else if (k === 'h') $('d-hold')?.click();
    else if (k === 'r') $('reason')?.value.trim() ? $('d-reject')?.click() : $('reason')?.focus();
    return;
  }
  if (!name || name === 'inbox') {
    const trs = [...page.querySelectorAll('tr[data-case]')];
    if (!trs.length) return;
    if (k === 'j' || k === 'k') {
      keyCtx.sel = Math.max(0, Math.min(trs.length - 1, keyCtx.sel + (k === 'j' ? 1 : -1)));
      trs.forEach((t, i) => (t.style.background = i === keyCtx.sel ? 'var(--blue-soft)' : ''));
      trs[keyCtx.sel].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && keyCtx.sel >= 0) location.hash = `case/${trs[keyCtx.sel].dataset.case}`;
  }
});

// ---------------------------------------------------------------------------
// Mailbox (Gmail)
// ---------------------------------------------------------------------------
async function renderMailbox() {
  setHead('Mailbox', 'Connections');
  const mb = await api('/api/mailbox');
  const newFiles = mb.messages.flatMap((m) => m.files.filter((f) => !f.caseId && !f.skipped).map((f) => ({ m, f })));
  $('nav-mail').hidden = !newFiles.length; $('nav-mail').textContent = newFiles.length;

  if (!mb.configured) {
    page.innerHTML = `
      <div class="card"><div class="card-h"><h2>Connect Gmail</h2><span class="pill">not connected</span></div><div class="card-b" style="display:grid;gap:14px;font-size:14.5px">
        <p style="margin:0">Countersign reads bills straight from your inbox. It only fetches emails that match a search (bills with attachments), keeps them on this machine, and checks each email's real sender with Gmail's own SPF/DKIM/DMARC results.</p>
        <ol style="margin:0;padding-left:20px;display:grid;gap:8px">
          <li>Turn on 2-Step Verification for your Google account (needed for app passwords).</li>
          <li>Create an app password named “Countersign” at <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noopener">myaccount.google.com/apppasswords</a>.</li>
          <li>Copy <code>core/.env.example</code> to <code>core/.env</code> and fill in <code>GMAIL_USER</code> and <code>GMAIL_APP_PASSWORD</code>. Type it into the file yourself; never paste it into a chat.</li>
          <li>Restart the server with <code>npm start</code> in <code>core/</code>, then come back here.</li>
        </ol>
        <p class="note" style="margin:0">The password stays in that git-ignored file. The server never logs it or sends it to the browser. Revoke it anytime in your Google account.</p>
      </div></div>
      <div class="card"><div class="card-b" style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap"><span class="note">No Gmail handy? Load two sample emails from a made-up vendor. They're never sent through real email.</span><button class="btn sm quiet" id="demo">Load sample emails</button></div></div>`;
    $('demo').addEventListener('click', loadSamples);
    return;
  }

  page.innerHTML = `
    <div class="card"><div class="card-h"><h2>Gmail · ${esc(mb.account)}</h2><span class="pill clear">connected</span></div><div class="card-b">
      <div class="form-row" style="grid-template-columns:1fr auto auto">
        <div class="field"><label>Which emails to read (Gmail search)</label><input class="input mono" id="mq" value="${esc(mb.query)}"></div>
        <button class="btn sm" id="sync">Sync now</button>
        <button class="btn sm quiet" id="import-all" ${newFiles.length ? '' : 'disabled'}>Import ${newFiles.length || ''} new bill${newFiles.length === 1 ? '' : 's'}</button>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-top:12px">
        <label class="note" style="display:inline-flex;gap:8px;align-items:center;cursor:pointer"><input type="checkbox" id="auto" ${mb.autoIngest ? 'checked' : ''}>
          <b style="color:var(--ink)">Auto-ingest</b> every ${mb.everyMinutes} min: new bills become checked cases with no clicks${mb.lastAuto ? ` · last run ${ago(mb.lastAuto.at)}${mb.lastAuto.error ? ` (error: ${esc(mb.lastAuto.error)})` : `, ${mb.lastAuto.created} new case${mb.lastAuto.created === 1 ? '' : 's'}`}` : ''}</label>
        <button class="btn sm quiet" id="demo">Load sample emails</button>
      </div>
      <p class="note" style="margin:10px 0 0">${mb.lastSync ? `Last synced ${ago(mb.lastSync)}.` : 'Not synced yet.'} Only matching messages with a PDF or image attachment are fetched. Receipts and refunds for things already paid are skipped automatically.</p></div></div>
    <div class="card">${mb.messages.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>From</th><th>Email</th><th>Sender</th><th>Bill</th><th>Received</th></tr></thead><tbody>
      ${mb.messages.map((m) => `<tr style="cursor:default">
        <td class="from"><b>${esc(m.fromName || m.from)}</b>${m.demo ? ' <span class="tag">sample</span>' : ''}<div class="sub mono">${esc(m.from)}</div></td>
        <td class="subj"><div class="clamp1">${esc(m.subject)}</div><div class="sub clamp1">${esc(m.snippet)}</div></td>
        <td>${(() => {
          const failed = analyzeEmail(m).checks.filter((c) => c.status === 'flag');
          const verified = m.auth?.dmarc === 'pass';
          return failed.length ? `<span class="status stop" title="${esc(failed.map((c) => c.finding).join(' · '))}">${failed.length === 1 ? esc(SHORT[failed[0].id]) : failed.length + ' sender problems'}</span>`
            : verified ? '<span class="status clear" title="SPF, DKIM and DMARC passed">Sender verified</span>' : '<span class="status">Not verified</span>';
        })()}</td>
        <td class="files">${(() => {
          const open = m.files.filter((f) => f.caseId), fresh = m.files.filter((f) => !f.caseId && !f.skipped), skipped = m.files.filter((f) => f.skipped);
          return [
            ...open.map((f) => `<a class="open-link" href="#case/${f.caseId}" title="${esc(f.name)}">Open case</a>`),
            ...fresh.map((f) => `<button class="btn sm quiet" data-imp="${esc(m.messageId)}|${esc(f.stored)}" title="${esc(f.name)}">Import</button>`),
            ...(skipped.length && !open.length && !fresh.length ? [`<span class="sub" title="${esc(skipped.map((f) => `${f.name}: ${f.skipped}`).join('\n'))}">Not a bill</span> <button class="linkbtn" data-imp="${esc(m.messageId)}|${esc(skipped[0].stored)}">Import anyway</button>`] : []),
          ].join(' ');
        })()}</td>
        <td class="sub" style="white-space:nowrap">${ago(m.date)}</td></tr>`).join('')}
    </tbody></table></div>` : `<div class="empty-state">${sigNote('idle', 'Nothing fetched yet', 'Press Sync now to look for bills in your inbox.')}</div>`}</div>`;
  mountSigs(page);

  $('sync').addEventListener('click', async (e) => {
    const b = e.currentTarget; b.disabled = true; b.textContent = 'Syncing…';
    try { const r = await api('/api/mailbox/sync', { method: 'POST', body: { userId: state.me, query: $('mq').value.trim() } }); toast(`Found ${r.added} new email${r.added === 1 ? '' : 's'}${r.created ? `, opened ${r.created} case${r.created === 1 ? '' : 's'} automatically` : ''}.`); renderMailbox(); }
    catch (er) { toast(er.message, true); b.disabled = false; b.textContent = 'Sync now'; }
  });
  const importOne = async (messageId, stored) => {
    const rec = mb.messages.find((m) => m.messageId === messageId);
    const f = rec.files.find((x) => x.stored === stored);
    const blob = await fetch(`/files/mail/${encodeURIComponent(stored)}`).then((r) => r.blob());
    startJob(new File([blob], f.name, { type: f.mime }), { email: rec, mailRef: { messageId, stored } });
  };
  page.querySelectorAll('[data-imp]').forEach((b) => b.addEventListener('click', () => { const [id, st] = b.dataset.imp.split('|'); importOne(id, st); }));
  $('import-all').addEventListener('click', () => newFiles.forEach(({ m, f }) => importOne(m.messageId, f.stored)));
  $('demo').addEventListener('click', loadSamples);
  $('auto').addEventListener('change', async (e) => {
    try { await api('/api/policy', { method: 'POST', body: { userId: state.me, patch: { autoIngest: e.target.checked } } }); toast(e.target.checked ? 'Auto-ingest on.' : 'Auto-ingest off. Use Sync and Import by hand.'); } catch (er) { toast(er.message, true); }
  });
}

async function loadSamples(e) {
  const b = e.currentTarget; b.disabled = true; b.textContent = 'Loading…';
  try {
    const r = await api('/api/mailbox/demo', { method: 'POST', body: { userId: state.me } });
    toast(`Loaded ${r.added} sample emails; ${r.created} case${r.created === 1 ? '' : 's'} opened automatically. Check the inbox.`);
    route();
  } catch (er) { toast(er.message, true); b.disabled = false; b.textContent = 'Load sample emails'; }
}

// ---------------------------------------------------------------------------
// Vendors
// ---------------------------------------------------------------------------
function renderVendors() {
  setHead('Vendors', 'Records');
  const med = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : 0; };
  page.innerHTML = `
    <div class="card"><div class="card-h"><h2 id="vf-title">Add a vendor</h2><span class="note">Bank-account changes are written to the audit log</span></div>
      <div class="card-b"><div class="form-row">
        <div class="field"><label>Name</label><input class="input" id="vf-name" placeholder="Vercel"></div>
        <div class="field"><label>Domain</label><input class="input" id="vf-domain" placeholder="vercel.com"></div>
        <div class="field"><label>Bank account (last 4)</label><input class="input" id="vf-bank" placeholder="4417" maxlength="4"></div>
        <div class="field"><label>Address</label><input class="input" id="vf-addr" placeholder="440 N Barranca Ave…"></div>
        <button class="btn sm" id="vf-save">Save vendor</button></div><input type="hidden" id="vf-key"></div></div>
    <div class="card"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Vendor</th><th>Domain</th><th>Pays to</th><th style="text-align:right">Typical bill</th><th>Paid invoices</th><th>Address</th></tr></thead><tbody>
      ${state.vendors.map((v) => `<tr data-v="${v.key}"><td><b>${esc(v.name)}</b></td><td class="mono">${esc(v.domain)}</td><td class="mono">••${esc(v.bankLast4)}</td>
        <td class="num">${v.history?.length ? money(med(v.history)) : '–'}</td><td>${v.paidInvoices?.length ?? 0}</td><td class="sub">${esc(v.address ?? '')}</td></tr>`).join('')}
    </tbody></table></div></div>`;
  page.querySelectorAll('[data-v]').forEach((r) => r.addEventListener('click', () => {
    const v = state.vendors.find((x) => x.key === r.dataset.v);
    $('vf-title').textContent = `Edit ${v.name}`; $('vf-key').value = v.key; $('vf-name').value = v.name; $('vf-domain').value = v.domain; $('vf-bank').value = v.bankLast4; $('vf-addr').value = v.address ?? '';
    scrollTo({ top: 0, behavior: 'smooth' });
  }));
  $('vf-save').addEventListener('click', async () => {
    try {
      await api('/api/vendors', { method: 'POST', body: { userId: state.me, vendor: { key: $('vf-key').value || undefined, name: $('vf-name').value.trim(), domain: $('vf-domain').value.trim(), bankLast4: $('vf-bank').value.trim(), address: $('vf-addr').value.trim() } } });
      toast('Vendor saved.'); route();
    } catch (e) { toast(e.message, true); }
  });
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------
async function renderAudit() {
  setHead('Audit log', 'Compliance');
  const { entries, verify } = await api('/api/audit');
  page.innerHTML = `
    <div class="chain ${verify.ok ? 'ok' : 'bad'}"><b>${verify.ok ? 'Chain verified' : 'Chain broken'}</b>
      <span>${verify.ok ? `${verify.total} entries. Each one carries the hash of the one before it, so editing or deleting any past entry is detectable.` : `Tampering detected at entry #${verify.brokenAt}.`}</span>
      ${verify.head ? `<code>head ${verify.head.slice(0, 16)}…</code>` : ''}</div>
    <div class="card">${entries.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>#</th><th>When</th><th>Who</th><th>What</th><th>Case</th><th>Hash</th></tr></thead><tbody>
      ${entries.map((e) => `<tr ${e.caseId ? `data-case="${e.caseId}"` : ''}><td class="mono">${e.seq}</td><td class="sub" style="white-space:nowrap">${new Date(e.at).toLocaleString()}</td>
        <td><b>${esc(personName(e.actor))}</b></td><td>${esc(describe(e))}</td><td class="mono sub">${esc(e.caseId ?? '–')}</td><td class="hash">${e.hash.slice(0, 12)}</td></tr>`).join('')}
    </tbody></table></div>` : '<div class="empty-state"><b>No events yet</b>Upload a bill and every step will be recorded here.</div>'}</div>`;
  page.querySelectorAll('[data-case]').forEach((r) => r.addEventListener('click', () => (location.hash = `case/${r.dataset.case}`)));
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------
function renderPolicy() {
  setHead('Policy', 'Controls');
  const p = state.policy;
  const w = { ...DEFAULT_WEIGHTS, ...(p.weights ?? {}) };
  page.innerHTML = `
    <div class="card"><div class="card-h"><h2>Approval rules</h2></div><div class="card-b"><div class="form-row" style="grid-template-columns:1fr 1fr auto">
      <div class="field"><label>Bills at or above this need two different people</label><input class="input" id="p-dual" type="number" min="0" step="100" value="${p.dualApprovalOver}"></div>
      <div class="field"><label>Your company's email domain (ignored as a sender)</label><input class="input" id="p-dom" value="${esc(p.companyDomain)}"></div>
      <button class="btn sm" id="p-save">Save rules</button></div>
      <p class="note" style="margin-top:12px">Always on: a STOP bill can't be approved; every decision needs a reason; editing a bill clears its signatures; nobody can sign the same bill twice.</p></div></div>
    <div class="card"><div class="card-h"><h2>What Countersign learned from your team</h2><button class="btn sm quiet" id="p-reset">Reset to defaults</button></div><div class="card-b">
      <table class="tbl"><thead><tr><th>Check</th><th>Weight</th><th></th></tr></thead><tbody>
      ${CHECKS.map((c) => `<tr><td><b>${esc(c.name)}</b><div class="sub">${esc(c.plain)}</div></td><td class="mono">${w[c.id].toFixed(2)}</td>
        <td style="width:45%"><span class="riskbar" style="width:100%"><i style="width:${((w[c.id] - 0.3) / 1.7) * 100}%;background:${w[c.id] < 1 ? 'var(--green)' : w[c.id] > 1 ? 'var(--red)' : 'var(--blue)'}"></i></span></td></tr>`).join('')}
      </tbody></table><p class="note">Marking a flag “false alarm” makes that check quieter (×0.85, floor 0.3). Rejecting a flagged bill makes its flags louder (×1.1, cap 2.0). Every change is in the audit log.</p></div></div>`;
  $('p-save').addEventListener('click', async () => {
    try { await api('/api/policy', { method: 'POST', body: { userId: state.me, patch: { dualApprovalOver: $('p-dual').value, companyDomain: $('p-dom').value } } }); toast('Rules saved.'); route(); } catch (e) { toast(e.message, true); }
  });
  $('p-reset').addEventListener('click', async () => {
    try { await api('/api/policy', { method: 'POST', body: { userId: state.me, patch: { resetWeights: true } } }); toast('Weights reset.'); route(); } catch (e) { toast(e.message, true); }
  });
}

// ---------------------------------------------------------------------------
// Developers
// ---------------------------------------------------------------------------
function renderDevelopers() {
  setHead('API & CLI', 'Developers');
  const host = location.origin;
  const endpoints = [
    ['POST', '/api/check', 'Check one bill (fields in, stamp and reasons out). Nothing is saved.'],
    ['POST', '/api/intel', 'Look up a vendor domain: company profile, scam reports, domain age.'],
    ['GET', '/api/cases', 'List every bill in the inbox with its stamp and status.'],
    ['POST', '/api/cases', 'Add a bill (file + fields). It is checked and lands in the inbox.'],
    ['POST', '/api/cases/:id/decision', 'Record a person’s decision: approve, hold, reject or not a bill.'],
    ['GET', '/api/audit', 'The audit log, with the hash-chain verification result.'],
  ];
  page.innerHTML = `
    <div class="doc-intro">
      <h2>Use Countersign from your own tools</h2>
      <p>The console, the command line and the API all run the same checks. None of them can pay a bill; they only tell people what to look at.</p>
      <div class="doc-tiles">
        <a href="#cli" class="doc-tile"><b>Command line</b><span>Check PDFs or a whole folder before a payment run.</span></a>
        <a href="#rest" class="doc-tile"><b>REST API</b><span>Call it from your bill-pay or accounting tool.</span></a>
        <a href="#mailbox" class="doc-tile" data-nav><b>Gmail</b><span>New bills are checked automatically every 2 minutes.</span></a>
      </div>
    </div>

    <section class="card doc" id="cli">
      <div class="card-h"><h2>Command line</h2><span class="note">core/bin/countersign.mjs</span></div>
      <div class="card-b doc-b">
        <div class="doc-step"><span class="n">1</span><div><b>Check a bill</b><div class="codeblk">node core/bin/countersign.mjs check invoice.pdf</div></div></div>
        <div class="doc-step"><span class="n">2</span><div><b>Check a folder before paying it</b><p class="note">Exits with code 2 if any bill is Stop, so a payment script can refuse to run. Add <code>--strict</code> to also fail on Hold.</p><div class="codeblk">node core/bin/countersign.mjs scan ./this-weeks-bills</div></div></div>
        <div class="doc-step"><span class="n">3</span><div><b>See what’s open in the console</b><div class="codeblk">node core/bin/countersign.mjs inbox</div></div></div>
        <details class="doc-more"><summary>Example output</summary><div class="codeblk">STOP   Northwind Logistics  NW-1219  $48,900.00  risk 100
       Likely fraud. Do not pay until you verify by phone.
       • Bank details changed: Account changed: ••3310 → ••9944
       • Amount anomaly: 9.4× the usual amount
       • pattern: Lookalike sender + new bank account

CLEAR  Vercel Inc.  VC-2541  $1,240.00  risk 0

2 checked · 1 stop · 0 hold · 1 clear
Do not run this payment batch until a person reviews the STOP bills.</div></details>
        <p class="note">Add <code>--json</code> for machine-readable output.</p>
      </div>
    </section>

    <section class="card doc" id="rest">
      <div class="card-h"><h2>REST API</h2><span class="note">${esc(host)}</span></div>
      <div class="card-b doc-b">
        <table class="tbl api"><thead><tr><th>Method</th><th>Path</th><th>What it does</th></tr></thead><tbody>
          ${endpoints.map(([m, path, what]) => `<tr><td><span class="method ${m.toLowerCase()}">${m}</span></td><td class="mono">${path}</td><td>${what}</td></tr>`).join('')}
        </tbody></table>
        <details class="doc-more"><summary>Example: check a bill</summary><div class="codeblk">curl ${esc(host)}/api/check -H 'content-type: application/json' -d '{
  "invoice": {
    "vendorName": "Northwind Logistics", "senderEmail": "billing@n0rthwind-logistics.example",
    "number": "NW-1219", "amount": 48900, "bankLast4": "9944",
    "address": "14 Commerce Plaza, Newark, NJ", "body": "URGENT: we changed our bank, wire today"
  }
}'

→ { "score": { "band": "stop", "risk": 100, "reason": "Likely fraud…" },
    "results": [ { "name": "Bank details changed", "status": "flag", "finding": "…" }, … ],
    "sources": [ { "source": "Glasser · Hunter company profile", "value": "…" }, … ] }</div></details>
      </div>
    </section>`;
  page.querySelectorAll('a[href="#cli"], a[href="#rest"]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); $(a.getAttribute('href').slice(1)).scrollIntoView({ behavior: 'smooth' }); }));
}

// ---------------------------------------------------------------------------
document.querySelectorAll('[data-mark]').forEach((el) => (el.innerHTML = brandMark()));
refreshHealth();
route();
