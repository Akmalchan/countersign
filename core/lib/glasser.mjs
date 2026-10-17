// Thin Glasser client. Runs Endpoints through the signed-in `glasser` CLI, so the Key
// stays in the CLI's own store and never touches this codebase.
// Every Run is cached on disk by (provider, endpoint, input) — repeat lookups are free
// and the demo keeps working offline.

import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const CACHE_DIR = new URL('../cache/', import.meta.url).pathname;

// Only these Endpoints may be run, at no more than this price per call (USD).
// Anything else is refused, so a bug can't quietly spend the balance.
export const ALLOWED = {
  'hunter /v2/companies/find': { version: 1, maxPrice: 0.01 },
  'serper /search': { version: 2, maxPrice: 0.002 },
};

// Hard ceiling on what one server process may spend.
const BUDGET_USD = Number(process.env.COUNTERSIGN_BUDGET_USD ?? 1.0);
let spent = 0;
export const spending = () => ({ spent: +spent.toFixed(4), budget: BUDGET_USD });

const keyFor = (provider, endpoint, input) =>
  createHash('sha256').update(JSON.stringify([provider, endpoint, input])).digest('hex').slice(0, 32);

function cli(args, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    execFile('glasser', args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      let body = null;
      try { body = JSON.parse(stdout); } catch { /* not JSON */ }
      if (err && !body) return reject(new Error((stderr || err.message).trim().slice(0, 300)));
      resolve(body);
    });
  });
}

/**
 * Run one Glasser Endpoint.
 * @returns {{ok:boolean, output:any, runUrl:string|null, charge:number, cached:boolean, status:string, error?:string}}
 */
export async function glasserRun(provider, endpoint, input, { fresh = false } = {}) {
  const rule = ALLOWED[`${provider} ${endpoint}`];
  if (!rule) throw new Error(`Endpoint not on the allow-list: ${provider} ${endpoint}`);

  const key = keyFor(provider, endpoint, input);
  const file = join(CACHE_DIR, `${key}.json`);
  if (!fresh) {
    try {
      const hit = JSON.parse(await readFile(file, 'utf8'));
      return { ...hit, charge: 0, cached: true };
    } catch { /* miss */ }
  }

  if (spent + rule.maxPrice > BUDGET_USD) {
    return { ok: false, output: null, runUrl: null, charge: 0, cached: false, status: 'BUDGET', error: `Budget of $${BUDGET_USD} reached` };
  }

  const args = ['run', '-p', provider, '-e', endpoint, '-i', JSON.stringify(input),
    '--endpoint-version', String(rule.version), '-j', '--idempotency-key', randomUUID()];
  if (process.env.GLASSER_TASK) args.push('--task', process.env.GLASSER_TASK);

  let run;
  try { run = await cli(args); } catch (e) {
    return { ok: false, output: null, runUrl: null, charge: 0, cached: false, status: 'CLI_ERROR', error: e.message };
  }
  if (run?.error) {
    return { ok: false, output: null, runUrl: null, charge: 0, cached: false, status: 'ERROR', error: run.error.message ?? String(run.error.code) };
  }

  const charge = Number(run.charge_usd ?? 0);
  spent += charge;
  const http = run.provider_response?.http_status;
  const result = {
    ok: run.status === 'COMPLETED' && (!http || http < 400),
    output: run.output ?? null,
    runUrl: run.run_url ?? null,
    status: run.status,
    provider, endpoint,
  };
  // Cache completed answers, including clean "no result" ones.
  if (run.status === 'COMPLETED' || run.status === 'NO_RESULT') {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(file, JSON.stringify(result));
  }
  return { ...result, charge, cached: false };
}

export async function glasserBalance() {
  try {
    const out = await cli(['balance', '-j'], 15000);
    return out;
  } catch (e) {
    return { error: e.message };
  }
}
