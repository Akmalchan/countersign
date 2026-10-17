// Gmail connector over IMAP. Credentials come only from the environment
// (GMAIL_USER, GMAIL_APP_PASSWORD in core/.env, which is git-ignored); they are never
// logged, stored, or returned by the API.
//
// It fetches only messages matching a Gmail search (default: bills with attachments
// from the last 120 days), keeps PDF/image attachments under core/data/mail/, and
// records the headers that matter for fraud: From, Reply-To, Authentication-Results.

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { db } from './store.mjs';
import { parseAuthResults, analyzeEmail } from '../../site/js/console/mailrules.js';

export const MAIL_DIR = new URL('../data/mail/', import.meta.url).pathname;
export const DEFAULT_QUERY = 'has:attachment (invoice OR receipt OR "amount due") newer_than:120d -in:sent';
const KEEP = { 'application/pdf': '.pdf', 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };
const MAX_MESSAGES = 25;

export function mailboxConfig() {
  const user = process.env.GMAIL_USER?.trim();
  const pass = process.env.GMAIL_APP_PASSWORD?.replace(/\s+/g, '');
  return { configured: !!(user && pass), user, pass };
}

export const maskEmail = (e) => (e ? e.replace(/^(.{2}).*(@.*)$/, '$1•••$2') : null);

export async function syncMailbox({ query } = {}) {
  const cfg = mailboxConfig();
  if (!cfg.configured) throw Object.assign(new Error('Gmail is not connected. Add GMAIL_USER and GMAIL_APP_PASSWORD to core/.env and restart the server.'), { code: 400 });
  const q = (query || DEFAULT_QUERY).slice(0, 300);

  const client = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user: cfg.user, pass: cfg.pass }, logger: false });
  try { await client.connect(); }
  catch (e) {
    const auth = /auth|credential|invalid/i.test(String(e.responseText || e.message));
    throw Object.assign(new Error(auth ? 'Gmail rejected the login. Check the app password (and that IMAP is on).' : `Couldn't reach Gmail: ${e.message}`), { code: 502 });
  }

  const known = await db.get('mail');
  const seen = new Set(known.map((m) => m.messageId));
  const added = [];
  await mkdir(MAIL_DIR, { recursive: true });

  // Gmail localizes folder names ("[Gmail]/Вся почта" in Russian), so find All Mail by
  // its special-use flag instead of its name.
  const boxes = await client.list();
  const allMail = boxes.find((b) => b.specialUse === '\\All')?.path ?? 'INBOX';
  const lock = await client.getMailboxLock(allMail);
  try {
    const uids = (await client.search({ gmraw: q }, { uid: true })) || [];
    for (const uid of uids.slice(-MAX_MESSAGES).reverse()) {
      const msg = await client.fetchOne(String(uid), { source: true, size: true }, { uid: true });
      if (!msg?.source || msg.size > 15 * 1024 * 1024) continue;
      const parsed = await simpleParser(msg.source);
      const messageId = parsed.messageId || `uid-${uid}`;
      if (seen.has(messageId)) continue;
      const key = createHash('sha1').update(messageId).digest('hex').slice(0, 12);

      const files = [];
      for (const [i, a] of (parsed.attachments ?? []).entries()) {
        const ext = KEEP[a.contentType];
        if (!ext || !a.content || a.size > 12 * 1024 * 1024) continue;
        const stored = `${key}-${i}${ext}`;
        await writeFile(join(MAIL_DIR, stored), a.content);
        files.push({ name: a.filename || stored, mime: a.contentType, size: a.size, stored, caseId: null });
      }
      if (!files.length) continue;

      const from = parsed.from?.value?.[0] ?? {};
      const replyTo = parsed.replyTo?.value?.[0]?.address ?? null;
      const auth = parseAuthResults(parsed.headers.get('authentication-results'));
      const rec = {
        messageId, key, uid,
        date: (parsed.date ?? new Date()).toISOString(),
        subject: parsed.subject ?? '(no subject)',
        from: from.address?.toLowerCase() ?? '', fromName: from.name ?? '',
        replyTo, auth,
        analysis: analyzeEmail({ from: from.address, replyTo, auth }),
        snippet: (parsed.text ?? '').replace(/\s+/g, ' ').slice(0, 280),
        files,
        syncedAt: new Date().toISOString(),
      };
      known.unshift(rec); seen.add(messageId); added.push(rec);
    }
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
  await db.save('mail');
  await db.update('policy', (p) => { p.mailQuery = q; p.lastMailSync = new Date().toISOString(); });
  return { added, total: known.length, query: q };
}
