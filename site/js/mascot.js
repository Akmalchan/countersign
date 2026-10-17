// Sig: Countersign's mascot. A small blue T-rex with reading glasses.
// Tiny arms, so he can never reach the pay button. Moods: idle, scan, stop, hold, clear, wave.

export function sigSVG() {
  return `
<svg class="sig-svg" viewBox="0 0 170 170" aria-hidden="true">
  <g class="sig-bubble">
    <circle cx="148" cy="22" r="17"/>
    <path d="M136 34 L131 44 L143 37 Z"/>
    <text x="148" y="29" text-anchor="middle">!</text>
  </g>
  <g class="sig-all">
    <g class="sig-tail"><path d="M62 118 C 40 120, 20 112, 6 96 C 14 120, 38 134, 66 132 Z"/></g>
    <ellipse class="sig-leg" cx="66" cy="152" rx="12" ry="9"/>
    <ellipse class="sig-leg" cx="96" cy="152" rx="12" ry="9"/>
    <g class="sig-body">
      <path class="sig-spike" d="M44 104 L46 92 L54 100 Z M50 92 L56 81 L62 91 Z M60 84 L68 74 L72 86 Z"/>
      <ellipse class="sig-skin" cx="80" cy="120" rx="35" ry="32"/>
      <ellipse class="sig-belly" cx="88" cy="126" rx="20" ry="22"/>
      <path class="sig-belly-line" d="M76 116 Q 88 120 100 116 M75 127 Q 88 131 101 127 M78 138 Q 88 141 98 138"/>
      <g class="sig-arm sig-arm-back"><path d="M100 110 q 10 -2 12 6 q -6 4 -12 1 z"/></g>
      <g class="sig-arm sig-arm-front"><path d="M104 118 q 11 -3 14 5 q -2 3 -5 2 q -5 2 -9 -1 z"/></g>
    </g>
    <g class="sig-head">
      <path class="sig-spike" d="M66 52 L64 38 L76 46 Z M76 42 L78 28 L88 39 Z M90 36 L96 24 L102 36 Z"/>
      <path class="sig-skin" d="M62 66 C 60 42, 82 32, 104 34 C 124 36, 150 46, 152 66 C 154 86, 136 96, 112 96 C 84 96, 64 90, 62 66 Z"/>
      <ellipse class="sig-cheek" cx="128" cy="80" rx="8" ry="5"/>
      <ellipse class="sig-nostril" cx="142" cy="60" rx="2.2" ry="3"/>
      <path class="sig-mouth sig-smile" d="M112 84 Q 128 92 146 80"/>
      <path class="sig-mouth sig-frown" d="M114 88 Q 130 80 146 86"/>
      <g class="sig-eyes">
        <g class="sig-eye"><circle class="sig-white" cx="92" cy="60" r="10"/><g class="sig-pupil"><circle cx="94" cy="61" r="5.2"/><circle class="sig-glint" cx="96" cy="59" r="1.6"/></g></g>
        <g class="sig-eye"><circle class="sig-white" cx="117" cy="58" r="11"/><g class="sig-pupil"><circle cx="119" cy="59" r="5.6"/><circle class="sig-glint" cx="121" cy="57" r="1.7"/></g></g>
        <path class="sig-happy" d="M84 61 Q 92 53 100 61 M108 59 Q 117 50 126 59"/>
      </g>
      <g class="sig-glasses"><circle cx="92" cy="60" r="13"/><circle cx="117" cy="58" r="14"/><path d="M105 59 Q 104 55 103 58"/><path d="M79 59 L 70 56"/></g>
      <path class="sig-brow" d="M80 44 L 101 50 M108 47 L 129 40"/>
      <path class="sig-sweat" d="M70 52 C 66 60, 64 64, 68 67 C 72 70, 76 66, 74 60 Z"/>
    </g>
  </g>
</svg>`;
}

const BUBBLE = { stop: '!', hold: '?', clear: '✓', scan: '…', idle: '', wave: 'hi', busy: '$$' };

export function setMood(el, mood) {
  if (!el) return;
  el.dataset.mood = mood;
  const t = el.querySelector('.sig-bubble text');
  if (t) t.textContent = BUBBLE[mood] ?? '';
}

export function mountSigs(root = document) {
  root.querySelectorAll('[data-sig]').forEach((host) => {
    if (host.querySelector('.sig-svg')) return;
    host.classList.add('sig');
    host.insertAdjacentHTML('afterbegin', sigSVG());
    setMood(host, host.dataset.mood || 'idle');
  });
}
