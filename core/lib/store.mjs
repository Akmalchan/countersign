// Tiny JSON-file store for the console: cases, vendors, users, policy, and an
// append-only audit log where every entry carries the hash of the previous one,
// so editing or deleting a past entry breaks the chain and is detectable.

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { VENDORS } from '../../site/js/data.js';

const DIR = new URL('../data/', import.meta.url).pathname;
export const UPLOADS = join(DIR, 'uploads');

const DEFAULTS = {
  cases: [],
  vendors: Object.entries(VENDORS).map(([key, v]) => ({ key, ...v, createdAt: '2026-01-05T09:00:00Z' })),
  users: [
    { id: 'u-akmal', name: 'Akmal Shovkatov', role: 'Controller' },
    { id: 'u-dias', name: 'Dias Almat', role: 'CFO' },
    { id: 'u-andrii', name: 'Andrii Drok', role: 'AP Specialist' },
  ],
  policy: {
    companyDomain: 'acme-robotics.com',
    dualApprovalOver: 10000,
    weights: {},
  },
  audit: [],
  mail: [],
};

const cache = {};
let queue = Promise.resolve();

async function load(name) {
  if (cache[name]) return cache[name];
  try { cache[name] = JSON.parse(await readFile(join(DIR, `${name}.json`), 'utf8')); }
  catch { cache[name] = structuredClone(DEFAULTS[name]); }
  return cache[name];
}

function save(name) {
  // Serialize writes and write atomically (tmp file + rename).
  queue = queue.then(async () => {
    await mkdir(DIR, { recursive: true });
    const tmp = join(DIR, `${name}.json.tmp`);
    await writeFile(tmp, JSON.stringify(cache[name], null, 2));
    await rename(tmp, join(DIR, `${name}.json`));
  });
  return queue;
}

export const db = {
  get: load,
  save,
  async update(name, fn) { const v = await load(name); const r = await fn(v); await save(name); return r; },
};

export const newId = (prefix) => `${prefix}-${randomUUID().slice(0, 8)}`;

const hashEntry = (e) => createHash('sha256').update(JSON.stringify([e.prev, e.at, e.actor, e.action, e.caseId, e.detail])).digest('hex');

export async function audit(actor, action, caseId, detail) {
  return db.update('audit', (log) => {
    const prev = log.length ? log[log.length - 1].hash : 'genesis';
    const entry = { seq: log.length + 1, at: new Date().toISOString(), actor, action, caseId: caseId ?? null, detail: detail ?? null, prev };
    entry.hash = hashEntry(entry);
    log.push(entry);
    return entry;
  });
}

export async function verifyAudit() {
  const log = await load('audit');
  let prev = 'genesis';
  for (const e of log) {
    if (e.prev !== prev || hashEntry(e) !== e.hash) return { ok: false, brokenAt: e.seq, total: log.length };
    prev = e.hash;
  }
  return { ok: true, total: log.length, head: prev };
}
