// Shared rendering helpers.

export const usd = (n) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const SIGNATURE_PATH =
  'M6 44 C 18 10, 30 10, 28 38 S 44 58, 52 30 S 64 8, 70 34 C 74 50, 82 50, 90 30 C 96 18, 104 22, 104 36 C 104 48, 116 46, 124 30 C 130 20, 140 24, 138 38 C 136 50, 152 46, 172 26';

export function renderInvoice(inv, { idPrefix = 'inv' } = {}) {
  const lines = inv.lines.map(([d, a]) => `<tr><td>${esc(d)}</td><td>${usd(a)}</td></tr>`).join('');
  return `
  <article class="invoice" id="${idPrefix}">
    <div class="scanline"></div>
    <div class="inv-top">
      <div>
        <div class="inv-vendor">${esc(inv.vendorName)}</div>
        <div class="inv-from"><span class="hl" data-hl="lookalike">${esc(inv.senderEmail)}</span></div>
      </div>
      <div style="text-align:right"><div class="inv-title">Invoice</div><span class="inv-sample">Sample</span></div>
    </div>
    <div class="inv-meta">
      <div><span>Number</span><b class="hl" data-hl="duplicate">${esc(inv.number)}</b></div>
      <div><span>Issued</span><b>${esc(inv.issued)}</b></div>
      <div><span>Due</span><b class="hl" data-hl="pressure">${esc(inv.due)}</b></div>
    </div>
    <table class="inv-lines">${lines}</table>
    <div class="inv-total"><span class="muted">Total due</span><b class="hl" data-hl="amount">${usd(inv.amount)}</b></div>
    <div class="inv-pay">Pay to: account <span class="hl" data-hl="bank">••${esc(inv.bankLast4)}</span> · <span class="hl" data-hl="address">${esc(inv.address)}</span></div>
    <div class="inv-note"><span class="hl" data-hl="pressure">${esc(inv.body)}</span></div>
    <div class="stamp" aria-hidden="true"></div>
    <svg class="signature" viewBox="0 0 180 60" aria-hidden="true"><path d="${SIGNATURE_PATH}"/></svg>
  </article>`;
}

// Logo: Sig's head peeking up from the bottom of a lime tile.
export const LOGO_SVG = `<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Countersign"><rect width="32" height="32" rx="8" fill="#d4f74a"/><path d="M8 32V21h11v11z" fill="#3340f2"/><path d="M7.5 11.5 7 7.6l3 2.2zM10.6 8.6l1-3.9 2 3.3zM14.4 7.6l2.1-3.3 1.2 3.6z" fill="#1b1f8f"/><path d="M5 19.5C5 11.8 11.4 7.6 18.6 8c6.2.4 10.4 4.2 10.4 9.4 0 4.8-3.8 7.1-9.4 7.1C11.7 24.5 5 24.3 5 19.5z" fill="#3340f2"/><circle cx="16.6" cy="14.6" r="3.4" fill="#fff"/><circle cx="17.5" cy="15" r="1.75" fill="#13123a"/><circle cx="16.6" cy="14.6" r="4.5" fill="none" stroke="#13123a" stroke-width="1.3"/><path d="M12.1 14.2 9.6 13.4" stroke="#13123a" stroke-width="1.3" stroke-linecap="round"/><ellipse cx="26.2" cy="13.6" rx=".7" ry="1" fill="#1b1f8f"/><path d="M19.6 20.4q3.8 2.2 7.6-.6" fill="none" stroke="#13123a" stroke-width="1.3" stroke-linecap="round"/></svg>`;

export function brandMark() {
  return LOGO_SVG;
}

export function statusIcon(r) {
  if (r.status === 'pass') return '<span class="ico pass">✓</span>';
  if (r.status === 'unknown') return '<span class="ico unknown">?</span>';
  return `<span class="ico ${r.severity === 'high' ? 'flag' : 'med'}">!</span>`;
}

export const BAND_LABEL = { stop: 'Stop', hold: 'Hold', clear: 'Clear' };
export const BAND_SUB = { stop: 'likely fraud', hold: 'needs a human', clear: 'awaiting signature' };
