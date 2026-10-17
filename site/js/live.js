// Live mode for the desk: pulls real vendor data through the Countersign core server
// (core/server.mjs → Glasser + RDAP). Falls back to the sample INTEL when the core
// server isn't running, so the static demo keeps working on its own.

import { esc } from './ui.js';

let live = false;
let available = false;
let modeEl = null;
let toggleEl = null;
let sourcesBox = null;

const label = () => (live ? 'Live mode · real data via Glasser' : 'Demo mode · sample vendor data');

function paint() {
  if (modeEl) modeEl.innerHTML = `<i style="background:${live ? 'var(--blue)' : 'var(--green)'}"></i>${label()}`;
  if (toggleEl) {
    toggleEl.textContent = live ? '● Live: on' : '○ Live: off';
    toggleEl.disabled = !available;
    toggleEl.title = available ? 'Switch between sample data and live Glasser lookups'
      : 'Start the core server (node core/server.mjs) and open http://localhost:4181/desk.html';
    toggleEl.style.opacity = available ? '1' : '.5';
  }
  if (sourcesBox && !live) sourcesBox.hidden = true;
}

export async function initLive() {
  modeEl = document.querySelector('.desk-head .mode');
  toggleEl = document.createElement('button');
  toggleEl.className = 'mode';
  toggleEl.style.cursor = 'pointer';
  modeEl?.after(toggleEl);
  toggleEl.addEventListener('click', () => { live = !live; paint(); });

  sourcesBox = document.createElement('div');
  sourcesBox.className = 'box';
  sourcesBox.hidden = true;
  document.getElementById('verdict')?.closest('.box')?.after(sourcesBox);

  try {
    const res = await fetch('/api/health', { signal: AbortSignal.timeout(4000) });
    available = res.ok;
  } catch { available = false; }
  paint();
}

export const isLive = () => live;

/** Intel map for one invoice: live lookup for its sender domain, or the sample data. */
export async function intelFor(inv, sampleIntel) {
  if (!live) return { intel: sampleIntel, sources: null, cost: 0 };
  const domain = inv.senderEmail.split('@')[1].toLowerCase();
  try {
    const res = await fetch('/api/intel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ domain }),
      signal: AbortSignal.timeout(60000),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    const intel = { ...sampleIntel };
    if (data.intel) intel[domain] = data.intel; else delete intel[domain];
    showSources(domain, data.sources, data.cost);
    return { intel, sources: data.sources, cost: data.cost };
  } catch (e) {
    showSources(domain, [{ source: 'Live lookup failed', ok: false, value: e.message, charge: 0 }], 0);
    const intel = { ...sampleIntel };
    delete intel[domain]; // unknown, never guessed
    return { intel, sources: null, cost: 0 };
  }
}

function showSources(domain, sources, cost) {
  if (!sourcesBox) return;
  const rows = sources.map((s) => `
    <div style="padding:9px 10px;border-radius:10px;background:var(--paper);font-size:12.5px">
      <div style="display:flex;justify-content:space-between;gap:8px">
        <b>${s.ok ? '✓' : '–'} ${esc(s.source)}</b>
        <span class="mono muted">${s.cached ? 'cached' : s.charge ? '$' + s.charge.toFixed(4) : 'free'}</span>
      </div>
      <div style="color:var(--ink-2);margin-top:3px">${esc(s.value)}</div>
      ${s.runUrl ? `<a href="${esc(s.runUrl)}" target="_blank" rel="noopener" style="font-size:11.5px;color:var(--blue)">open source ↗</a>` : ''}
    </div>`).join('');
  sourcesBox.innerHTML = `<h2>Live sources · ${esc(domain)}</h2>
    <div style="display:grid;gap:8px">${rows}</div>
    <p class="act-note">This lookup cost $${(cost ?? 0).toFixed(4)}. Repeat lookups are cached and free.</p>`;
  sourcesBox.hidden = false;
}
