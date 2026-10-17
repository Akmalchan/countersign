// Countersign server: serves the site and the API.
//
// Live checks (stateless)
//   GET  /api/health                      spend so far + Glasser balance (free)
//   POST /api/intel   {domain}            live vendor intel for one email domain
//   POST /api/check   {invoice, ...}      live intel + the 8 checks + score
// Console (persisted in core/data/)
//   GET  /api/cases                       inbox
//   POST /api/cases   {userId, file, fields, fieldMeta, text}   upload → case → live check
//   GET  /api/cases/:id
//   POST /api/cases/:id/fields   {userId, fields}             human edits → re-check
//   POST /api/cases/:id/recheck  {userId}                     fresh live lookup
//   POST /api/cases/:id/decision {userId, action, reason, dismissed}
//   GET  /api/vendors · POST /api/vendors {userId, vendor}
//   GET  /api/users · GET /api/policy · POST /api/policy {userId, patch}
//   GET  /api/audit                       hash-chained log + verification
//   GET  /files/:stored                   the uploaded document

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, basename } from 'node:path';
import { runChecks, score, DEFAULT_WEIGHTS } from '../site/js/engine.js';
import { VENDORS } from '../site/js/data.js';
import { buildIntel } from './lib/intel.mjs';
import { glasserBalance, spending } from './lib/glasser.mjs';
import { db, audit, verifyAudit, newId, UPLOADS } from './lib/store.mjs';
import { createCase, editFields, decide, checkCase } from './lib/cases.mjs';
import { syncMailbox, mailboxConfig, maskEmail, DEFAULT_QUERY, MAIL_DIR } from './lib/mailbox.mjs';
import { ingestPending } from './lib/ingest.mjs';
import { loadDemoEmails } from './lib/demo.mjs';
import { startCallback, startWebCallback, finishWebCallback, callConfig } from './lib/call.mjs';

const AUTO_SYNC_MS = 2 * 60 * 1000;
let lastAuto = null;

const PORT = Number(process.env.PORT ?? 4181);
const SITE = new URL('../site/', import.meta.url).pathname;
const DOMAIN_RE = /^(?!-)(?:[a-z0-9-]+\.)+[a-z]{2,}$/;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.pdf': 'application/pdf', '.ico': 'image/x-icon' };

const send = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

async function readJson(req, limit = 64 * 1024) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > limit) throw Object.assign(new Error('body too large'), { code: 413 }); chunks.push(c); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

const senderDomain = (email) => String(email ?? '').split('@')[1]?.toLowerCase().trim() ?? '';

function validInvoice(inv) {
  const need = ['vendorName', 'senderEmail', 'number', 'amount', 'bankLast4', 'address', 'body'];
  const missing = need.filter((k) => inv?.[k] === undefined || inv[k] === '');
  if (missing.length) return `missing fields: ${missing.join(', ')}`;
  if (!DOMAIN_RE.test(senderDomain(inv.senderEmail))) return 'senderEmail must look like name@domain.tld';
  if (!(Number(inv.amount) > 0)) return 'amount must be a positive number';
  return null;
}

async function requireUser(userId) {
  const users = await db.get('users');
  const u = users.find((x) => x.id === userId);
  if (!u) throw Object.assign(new Error('unknown user'), { code: 400 });
  return u;
}

async function api(req, res, path) {
  const m = req.method;
  const seg = path.split('/').filter(Boolean); // ['api', ...]

  if (path === '/api/health' && m === 'GET') return send(res, 200, { ok: true, spending: spending(), calling: callConfig(), glasser: await glasserBalance() });

  if (path === '/api/intel' && m === 'POST') {
    const body = await readJson(req);
    const domain = String(body.domain ?? '').toLowerCase().trim();
    if (!DOMAIN_RE.test(domain)) return send(res, 400, { error: 'domain must look like example.com' });
    return send(res, 200, { ...(await buildIntel(domain, { fresh: !!body.fresh })), spending: spending() });
  }

  if (path === '/api/check' && m === 'POST') {
    const body = await readJson(req);
    const inv = { vendorKey: body.invoice?.vendorKey ?? null, lines: [], ...body.invoice };
    const problem = validInvoice(inv);
    if (problem) return send(res, 400, { error: problem });
    inv.amount = Number(inv.amount);
    const vendors = body.vendors && typeof body.vendors === 'object' ? body.vendors : VENDORS;
    const domain = senderDomain(inv.senderEmail);
    const live = await buildIntel(domain, { fresh: !!body.fresh });
    const results = runChecks(inv, vendors, live.intel ? { [domain]: live.intel } : {});
    const s = score(results, { ...DEFAULT_WEIGHTS, ...(body.weights ?? {}) }, { dismissed: new Set(body.dismissed ?? []), isNewVendor: !vendors[inv.vendorKey] });
    return send(res, 200, { domain, intel: live.intel, sources: live.sources, cost: live.cost, results, score: s, spending: spending() });
  }

  // ---- console ----
  if (seg[1] === 'cases') {
    const id = seg[2];
    if (!id && m === 'GET') return send(res, 200, { cases: (await db.get('cases')).map(({ text, ...c }) => c) });
    if (!id && m === 'POST') {
      const body = await readJson(req, 18 * 1024 * 1024);
      await requireUser(body.userId);
      return send(res, 201, await createCase(body));
    }
    const cases = await db.get('cases');
    const c = cases.find((x) => x.id === id);
    if (!c) return send(res, 404, { error: 'case not found' });
    if (!seg[3] && m === 'GET') return send(res, 200, c);
    const body = await readJson(req);
    await requireUser(body.userId);
    if (seg[3] === 'fields' && m === 'POST') return send(res, 200, await editFields(id, body.userId, body.fields ?? {}));
    if (seg[3] === 'decision' && m === 'POST') return send(res, 200, await decide(id, body));
    if (seg[3] === 'webcall' && m === 'POST') {
      await requireUser(body.userId);
      try {
        if (body.done) return send(res, 200, await finishWebCallback(c, body));
        if (c.check?.score?.band === 'clear' && !c.callback) return send(res, 400, { error: 'This bill is clear; calls are for HOLD and STOP bills.' });
        const vendor = (await db.get('vendors')).find((v) => v.key === c.vendorKey);
        return send(res, 200, await startWebCallback(c, { userId: body.userId, vendor, company: process.env.COMPANY_NAME || 'Blaze' }));
      } catch (e) { return send(res, e.code ?? 502, { error: e.message }); }
    }
    if (seg[3] === 'call' && m === 'POST') {
      await requireUser(body.userId);
      if (c.check?.score?.band === 'clear' && !c.callback) return send(res, 400, { error: 'This bill is clear; calls are for HOLD and STOP bills.' });
      const vendor = (await db.get('vendors')).find((v) => v.key === c.vendorKey);
      try { return send(res, 200, await startCallback(c, { userId: body.userId, vendor, company: process.env.COMPANY_NAME || 'Blaze' })); }
      catch (e) { return send(res, e.code ?? 502, { error: e.message }); }
    }
    if (seg[3] === 'recheck' && m === 'POST') {
      await checkCase(c, { fresh: true });
      await db.save('cases');
      await audit(body.userId, 'case.rechecked', id, { stamp: c.check.score.band, risk: c.check.score.risk, cost: c.check.cost });
      return send(res, 200, c);
    }
  }

  // ---- Gmail mailbox ----
  if (path === '/api/mailbox' && m === 'GET') {
    const cfg = mailboxConfig();
    const policy = await db.get('policy');
    return send(res, 200, { configured: cfg.configured, account: maskEmail(cfg.user), query: policy.mailQuery ?? DEFAULT_QUERY, lastSync: policy.lastMailSync ?? null, autoIngest: policy.autoIngest !== false, everyMinutes: AUTO_SYNC_MS / 60000, lastAuto, messages: await db.get('mail') });
  }
  if (path === '/api/mailbox/sync' && m === 'POST') {
    const body = await readJson(req);
    const user = await requireUser(body.userId);
    const r = await syncMailbox({ query: body.query });
    await audit(body.userId, 'mailbox.synced', null, { by: user.name, newMessages: r.added.length, newFiles: r.added.reduce((a, x) => a + x.files.length, 0), query: r.query });
    const ing = (await db.get('policy')).autoIngest !== false ? await ingestPending() : { created: 0, skipped: 0 };
    return send(res, 200, { added: r.added.length, total: r.total, query: r.query, created: ing.created, skipped: ing.skipped });
  }
  if (path === '/api/mailbox/demo' && m === 'POST') {
    const body = await readJson(req);
    const user = await requireUser(body.userId);
    const added = await loadDemoEmails();
    await audit(body.userId, 'mailbox.samples_loaded', null, { by: user.name, emails: added.length });
    const ing = await ingestPending();
    return send(res, 200, { added: added.length, created: ing.created });
  }

  if (path === '/api/vendors' && m === 'GET') return send(res, 200, { vendors: await db.get('vendors') });
  if (path === '/api/vendors' && m === 'POST') {
    const body = await readJson(req);
    const user = await requireUser(body.userId);
    const v = body.vendor ?? {};
    const domain = String(v.domain ?? '').toLowerCase().trim();
    if (!v.name || !DOMAIN_RE.test(domain)) return send(res, 400, { error: 'vendor needs a name and a domain like example.com' });
    if (!/^\d{4}$/.test(String(v.bankLast4 ?? ''))) return send(res, 400, { error: 'bankLast4 must be 4 digits' });
    const saved = await db.update('vendors', (vendors) => {
      let x = vendors.find((y) => y.key === v.key);
      const before = x ? { ...x } : null;
      if (!x) { x = { key: newId('v'), history: [], paidInvoices: [], createdAt: new Date().toISOString() }; vendors.push(x); }
      Object.assign(x, { name: v.name, domain, bankLast4: String(v.bankLast4), address: v.address ?? '' });
      if (Array.isArray(v.history)) x.history = v.history.map(Number).filter((n) => n > 0).slice(-12);
      return { x, before };
    });
    await audit(body.userId, saved.before ? 'vendor.updated' : 'vendor.created', null, {
      vendor: saved.x.name, by: user.name,
      ...(saved.before && saved.before.bankLast4 !== saved.x.bankLast4 ? { bankChanged: `••${saved.before.bankLast4} → ••${saved.x.bankLast4}` } : {}),
    });
    return send(res, 200, saved.x);
  }

  if (path === '/api/users' && m === 'GET') return send(res, 200, { users: await db.get('users') });
  if (path === '/api/policy' && m === 'GET') return send(res, 200, await db.get('policy'));
  if (path === '/api/policy' && m === 'POST') {
    const body = await readJson(req);
    await requireUser(body.userId);
    const p = body.patch ?? {};
    const policy = await db.update('policy', (pol) => {
      if (p.dualApprovalOver !== undefined) pol.dualApprovalOver = Math.max(0, Number(p.dualApprovalOver) || 0);
      if (p.companyDomain !== undefined) pol.companyDomain = String(p.companyDomain).toLowerCase().trim();
      if (p.resetWeights) pol.weights = {};
      if (p.autoIngest !== undefined) pol.autoIngest = !!p.autoIngest;
      return pol;
    });
    await audit(body.userId, 'policy.updated', null, p);
    return send(res, 200, policy);
  }

  if (path === '/api/audit' && m === 'GET') return send(res, 200, { entries: [...(await db.get('audit'))].reverse(), verify: await verifyAudit() });

  return send(res, 404, { error: 'unknown endpoint' });
}

async function serveFile(res, file, root) {
  if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
  try {
    const data = await readFile(file);
    // no-cache: browsers revalidate, so a code change shows up on the next reload.
    res.writeHead(200, { 'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  } catch { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); }
}

createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  try {
    if (pathname.startsWith('/api/')) return await api(req, res, pathname);
    if (pathname.startsWith('/files/mail/')) return await serveFile(res, join(MAIL_DIR, basename(decodeURIComponent(pathname))), MAIL_DIR);
    if (pathname.startsWith('/files/')) return await serveFile(res, join(UPLOADS, basename(decodeURIComponent(pathname))), UPLOADS);
    const rel = normalize(decodeURIComponent(pathname === '/' ? '/index.html' : pathname)).replace(/^(\.\.[/\\])+/, '');
    return await serveFile(res, join(SITE, rel), SITE);
  } catch (e) {
    const code = e.code && Number.isInteger(e.code) ? e.code : e instanceof SyntaxError ? 400 : 500;
    if (code === 500) console.error(e);
    send(res, code, { error: code === 500 ? 'internal error' : e.message });
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Countersign → http://localhost:${PORT}  (console: /app.html, spend cap $${spending().budget})`);
});

// Auto-ingest: every 2 minutes, pull new bills from Gmail and turn them into checked cases.
async function autoTick() {
  if (!mailboxConfig().configured || (await db.get('policy')).autoIngest === false) return;
  let added = 0, error = null;
  // A flaky network shouldn't block bills that are already downloaded.
  try { added = (await syncMailbox()).added.length; } catch (e) { error = e.message; }
  try {
    const ing = await ingestPending();
    lastAuto = { at: new Date().toISOString(), newMessages: added, created: ing.created, ...(error ? { error } : {}) };
    if (added || ing.created) await audit('system', 'mailbox.auto_ingested', null, { newMessages: added, created: ing.created, skipped: ing.skipped });
  } catch (e) {
    lastAuto = { at: new Date().toISOString(), error: e.message };
  }
}
setTimeout(autoTick, 5000);
setInterval(autoTick, AUTO_SYNC_MS);
