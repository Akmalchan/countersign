#!/usr/bin/env node
// countersign: check bills from the terminal, with the same engine and live data as the console.
//
//   countersign check <bill.pdf> [more.pdf…]   check one or more PDF bills
//   countersign scan <folder>                   check every PDF in a folder (e.g. before a payment run)
//   countersign inbox                           list open bills from a running console (localhost:4181)
//
// Options: --json (machine-readable) · --strict (HOLD also fails) · --fresh (skip the lookup cache)
// Exit codes: 0 = nothing to stop · 2 = at least one bill is STOP (or HOLD with --strict) · 1 = error.
// It never pays or approves anything; it only tells you what to look at.

import { readFile, readdir } from 'node:fs/promises';
import { join, basename, extname } from 'node:path';
import { pdfInfo } from '../lib/pdftext.mjs';
import { parseFields } from '../../site/js/console/extract.js';
import { checkCase } from '../lib/cases.mjs';
import { db } from '../lib/store.mjs';
import { spending } from '../lib/glasser.mjs';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const [cmd, ...rest] = args.filter((a) => !a.startsWith('--'));
const JSON_OUT = flags.has('--json'), STRICT = flags.has('--strict'), FRESH = flags.has('--fresh');

const tty = process.stdout.isTTY && !JSON_OUT;
const paint = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = paint('1'), dim = paint('2'), red = paint('31'), green = paint('32'), amber = paint('33'), blue = paint('34');
const BAND = { stop: red(bold('STOP ')), hold: amber(bold('HOLD ')), clear: green(bold('CLEAR')) };
const usd = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function help() {
  console.log(`${bold('countersign')}: every bill checked, a human signs

  ${bold('countersign check')} <bill.pdf> [more.pdf…]   check PDF bills
  ${bold('countersign scan')} <folder>                   check every PDF in a folder
  ${bold('countersign inbox')}                           open bills in the running console

  --json     machine-readable output
  --strict   treat HOLD as a failure too
  --fresh    skip the live-data cache

  Exit code 2 if any bill is STOP, so a payment script can refuse to run.`);
}

async function checkFile(path) {
  if (extname(path).toLowerCase() !== '.pdf') return { file: basename(path), error: 'only PDF files (use the console for photos)' };
  const { text, meta: docMeta } = await pdfInfo(await readFile(path));
  const policy = await db.get('policy');
  const { fields } = parseFields(text, { companyDomain: policy.companyDomain ?? '' });
  fields.amount = Number(String(fields.amount).replace(/[^0-9.]/g, '')) || 0;
  const c = await checkCase({ fields, text, docMeta, dismissed: [] }, { fresh: FRESH });
  const s = c.check.score;
  return {
    file: basename(path), vendor: fields.vendorName, invoice: fields.number, amount: fields.amount, sender: fields.senderEmail,
    stamp: s.band, risk: s.risk, confidence: s.confidence, reason: s.reason,
    problems: [...c.check.results, ...(c.check.doc?.checks ?? [])].filter((r) => r.status === 'flag').map((r) => ({ check: r.name, severity: r.severity, finding: r.finding })),
    patterns: s.combos.map((k) => k.label),
    billedVia: c.billedVia ?? null, cost: c.check.cost,
  };
}

function printResult(r) {
  if (r.error) { console.log(`${red('ERROR')}  ${r.file}  ${dim(r.error)}`); return; }
  console.log(`${BAND[r.stamp]}  ${bold(r.vendor || 'Unknown vendor')}  ${r.invoice || ''}  ${bold(usd(r.amount))}  ${dim(`risk ${r.risk} · ${r.file}`)}`);
  console.log(`       ${r.reason}`);
  for (const p of r.problems) console.log(`       ${p.severity === 'high' ? red('•') : amber('•')} ${p.check}: ${p.finding}`);
  for (const p of r.patterns) console.log(`       ${red('•')} pattern: ${p}`);
  if (r.billedVia) console.log(`       ${dim(`billed through ${r.billedVia.platform}; checked ${r.billedVia.merchant}`)}`);
  console.log('');
}

async function runChecks(paths) {
  const results = [];
  for (const p of paths) {
    try { results.push(await checkFile(p)); } catch (e) { results.push({ file: basename(p), error: e.message }); }
    if (!JSON_OUT) printResult(results[results.length - 1]);
  }
  const stops = results.filter((r) => r.stamp === 'stop').length;
  const holds = results.filter((r) => r.stamp === 'hold').length;
  const errors = results.filter((r) => r.error).length;
  if (JSON_OUT) console.log(JSON.stringify({ results, summary: { checked: results.length, stop: stops, hold: holds, errors }, spend: spending() }, null, 2));
  else console.log(`${bold(results.length)} checked · ${red(stops + ' stop')} · ${amber(holds + ' hold')} · ${green(results.length - stops - holds - errors + ' clear')}${errors ? ` · ${errors} error` : ''}  ${dim(`live data $${spending().spent.toFixed(4)}`)}`);
  const fail = stops > 0 || (STRICT && holds > 0);
  if (fail && !JSON_OUT) console.log(red(`\nDo not run this payment batch until a person reviews the ${STRICT ? 'STOP/HOLD' : 'STOP'} bills.`));
  return fail ? 2 : errors ? 1 : 0;
}

async function inbox() {
  const res = await fetch('http://localhost:4181/api/cases').catch(() => null);
  if (!res?.ok) { console.error('The console isn’t running. Start it with: cd core && npm start'); return 1; }
  const { cases } = await res.json();
  const open = cases.filter((c) => ['needs_review', 'awaiting_second', 'on_hold'].includes(c.status));
  if (JSON_OUT) { console.log(JSON.stringify(open, null, 2)); return 0; }
  for (const c of open) console.log(`${BAND[c.check.score.band]}  ${bold(c.fields.vendorName || 'Unknown')}  ${c.fields.number || ''}  ${bold(usd(c.fields.amount))}  ${dim(c.status.replace('_', ' '))}  ${blue(`http://localhost:4181/app.html#case/${c.id}`)}`);
  console.log(`\n${open.length} open bill${open.length === 1 ? '' : 's'}`);
  return 0;
}

let code = 0;
try {
  if (cmd === 'check' && rest.length) code = await runChecks(rest);
  else if (cmd === 'scan' && rest[0]) {
    const files = (await readdir(rest[0])).filter((f) => f.toLowerCase().endsWith('.pdf')).map((f) => join(rest[0], f));
    if (!files.length) { console.error(`No PDF files in ${rest[0]}`); code = 1; } else code = await runChecks(files);
  } else if (cmd === 'inbox') code = await inbox();
  else help();
} catch (e) { console.error(red('error: ') + e.message); code = 1; }
process.exit(code);
