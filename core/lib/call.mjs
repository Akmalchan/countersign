// AI callback: places a short verification call through Vapi and reads the answer back.
// The call asks one yes/no question and hangs up. The answer is classified by plain rules
// over the callee's own words (site/js/console/callback.js), not by the model.
//
// .env: VAPI_API_KEY, VAPI_PHONE_NUMBER_ID, and for the demo CALL_DEMO_TO (your own phone):
// when set, every call rings that number instead, and the case says so.

import { db, audit } from './store.mjs';
import { callPlan, classifyAnswer, normPhone, prettyPhone } from '../../site/js/console/callback.js';

const API = 'https://api.vapi.ai';
const POLL_MS = 3000, GIVE_UP_MS = 4 * 60 * 1000;

export const callConfig = () => ({
  ready: !!(process.env.VAPI_API_KEY && process.env.VAPI_PHONE_NUMBER_ID),
  demoRouted: !!normPhone(process.env.CALL_DEMO_TO),
  // Browser mode: the same agent, spoken through the laptop (no phone carrier needed).
  web: !!process.env.VAPI_PUBLIC_KEY,
  publicKey: process.env.VAPI_PUBLIC_KEY || null,
});

/** The assistant config for a case, used by both the phone call and the browser call. */
export function assistantFor(c, company) {
  const s = script(c, company);
  return {
    name: 'Countersign verification',
    firstMessage: s.first,
    model: { provider: 'openai', model: 'gpt-4o-mini', temperature: 0, messages: [{ role: 'system', content: s.system }] },
    endCallFunctionEnabled: true,
    endCallMessage: 'Thank you, goodbye.',
    maxDurationSeconds: 75,
  };
}

/** Browser call: record that it started, hand the browser the assistant to run. */
export async function startWebCallback(c, { userId, vendor, company = 'Blaze' }) {
  if (!process.env.VAPI_PUBLIC_KEY) throw Object.assign(new Error('Add VAPI_PUBLIC_KEY to core/.env and restart.'), { code: 400 });
  const plan = callPlan(c, vendor);
  const assistant = assistantFor(c, company);
  c.callback = {
    mode: 'web', status: 'in-progress', callId: null, startedAt: new Date().toISOString(), by: userId,
    trusted: plan.trusted ? prettyPhone(plan.trusted) : null, trustedSource: plan.source,
    onBill: plan.onBill.map(prettyPhone), mismatch: plan.mismatch,
    dialed: 'browser (live demo)', demoRouted: true, question: assistant.firstMessage, result: null, transcript: [],
  };
  await db.save('cases');
  await audit(userId, 'case.callback_started', c.id, { to: plan.trusted ? prettyPhone(plan.trusted) : 'the vendor', source: plan.source, demoRouted: true });
  return { case: c, assistant, publicKey: process.env.VAPI_PUBLIC_KEY };
}

/** The browser reports the finished call. With a private key we re-read it from Vapi. */
export async function finishWebCallback(c, { userId, callId, transcript = [], endedReason = '' }) {
  if (c.callback?.mode !== 'web' || c.callback.result) throw Object.assign(new Error('No browser call in progress for this bill.'), { code: 409 });
  let lines = (Array.isArray(transcript) ? transcript : []).slice(0, 40).map((m) => ({ who: m.who === 'Vendor' ? 'Vendor' : 'Countersign', text: String(m.text ?? '').slice(0, 500) })).filter((m) => m.text);
  if (callId && process.env.VAPI_API_KEY) {
    try {
      const call = await vapi(`/call/${encodeURIComponent(callId)}`);
      const msgs = (call.artifact?.messages ?? call.messages ?? []).filter((m) => ['user', 'bot', 'assistant'].includes(m.role));
      const fromVapi = msgs.map((m) => ({ who: m.role === 'user' ? 'Vendor' : 'Countersign', text: m.message ?? m.content ?? '' })).filter((m) => m.text);
      if (fromVapi.length) lines = fromVapi;
    } catch { /* keep what the browser heard */ }
  }
  await record(c, userId, lines, endedReason, callId);
  return c;
}

async function record(c, userId, transcript, reason, callId) {
  const userLines = transcript.filter((m) => m.who === 'Vendor').map((m) => m.text);
  const result = userLines.length ? classifyAnswer(userLines) : /error|failed/i.test(reason) ? 'failed' : 'no_answer';
  c.callback = { ...c.callback, callId: callId ?? c.callback.callId, status: 'ended', endedReason: reason, transcript, result, endedAt: new Date().toISOString() };
  const { checkCase } = await import('./cases.mjs');
  await checkCase(c);
  await db.save('cases');
  await audit(userId, 'case.callback_result', c.id, { result, stamp: c.check.score.band, said: userLines.join(' / ').slice(0, 200) });
}

const mask = (e164) => (e164 ? prettyPhone(e164).replace(/\d(?=\d{2})/g, '•') : '');
const spell = (s) => String(s ?? '').replace(/[^A-Za-z0-9]/g, ' ').split('').join(' ').replace(/\s+/g, ' ').trim();
const dollars = (n) => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 }) + ' dollars';

function script(c, company) {
  const f = c.fields;
  const acct = f.bankLast4 ? `, to be paid to a bank account ending ${spell(f.bankLast4)}` : '';
  const vendor = f.vendorName || 'your company';
  return {
    first: `Hi, this is Countersign, an automated check calling for ${company} accounts payable. We received invoice ${spell(f.number)} from ${vendor} for ${dollars(f.amount)}${acct}. Did your company send this bill? Please just say yes or no.`,
    system: `You are Countersign's automated bill-verification line, calling on behalf of ${company} accounts payable. You have already asked whether the company sent the bill. Wait for the answer. As soon as the person clearly says yes or no, say only "Thank you, goodbye." and end the call. If the answer is unclear, ask once: "Sorry, just yes or no: did you send this bill?" Then say "Thank you, goodbye." and end the call. Never ask for or share bank details, passwords, or payment information. Never discuss anything else.`,
  };
}

async function vapi(path, init = {}) {
  const res = await fetch(API + path, { ...init, headers: { authorization: `Bearer ${process.env.VAPI_API_KEY}`, 'content-type': 'application/json', ...(init.headers ?? {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Vapi ${res.status}: ${body.message ? [].concat(body.message).join('; ') : res.statusText}`);
  return body;
}

/** Start the call for a case. Mutates and saves the case; resolves once the call is placed. */
export async function startCallback(c, { userId, vendor, company = 'Blaze' }) {
  const cfg = callConfig();
  if (!cfg.ready) throw Object.assign(new Error('Calling isn’t set up: add VAPI_API_KEY and VAPI_PHONE_NUMBER_ID to core/.env and restart.'), { code: 400 });
  if (['calling', 'ringing', 'in-progress', 'queued'].includes(c.callback?.status)) throw Object.assign(new Error('A call is already in progress for this bill.'), { code: 409 });
  const plan = callPlan(c, vendor);
  const demoTo = normPhone(process.env.CALL_DEMO_TO);
  if (!plan.trusted && !demoTo) throw Object.assign(new Error('No trusted phone number for this vendor. Add one to the vendor record (never use the number printed on the bill).'), { code: 400 });
  const to = demoTo || plan.trusted;
  const s = script(c, company);
  const call = await vapi('/call', {
    method: 'POST',
    body: JSON.stringify({
      phoneNumberId: process.env.VAPI_PHONE_NUMBER_ID,
      customer: { number: to },
      assistant: {
        name: 'Countersign verification',
        firstMessage: s.first,
        model: { provider: 'openai', model: 'gpt-4o-mini', temperature: 0, messages: [{ role: 'system', content: s.system }] },
        endCallFunctionEnabled: true,
        endCallMessage: 'Thank you, goodbye.',
        maxDurationSeconds: 75,
      },
    }),
  });
  c.callback = {
    status: 'calling', callId: call.id, startedAt: new Date().toISOString(), by: userId,
    trusted: plan.trusted ? prettyPhone(plan.trusted) : null, trustedSource: plan.source,
    onBill: plan.onBill.map(prettyPhone), mismatch: plan.mismatch,
    dialed: mask(to), demoRouted: !!demoTo, question: s.first, result: null, transcript: [],
  };
  await db.save('cases');
  await audit(userId, 'case.callback_started', c.id, { to: plan.trusted ? prettyPhone(plan.trusted) : 'demo phone', source: plan.source, demoRouted: !!demoTo });
  poll(c.id, Date.now(), userId);
  return c;
}

function poll(caseId, t0, userId) {
  setTimeout(async () => {
    const cases = await db.get('cases');
    const c = cases.find((x) => x.id === caseId);
    if (!c?.callback?.callId || c.callback.result) return;
    let call;
    try { call = await vapi(`/call/${c.callback.callId}`); }
    catch (e) { if (Date.now() - t0 < GIVE_UP_MS) return poll(caseId, t0, userId); call = { status: 'ended', endedReason: e.message }; }
    if (call.status !== 'ended') {
      if (c.callback.status !== call.status) { c.callback.status = call.status; await db.save('cases'); }
      if (Date.now() - t0 < GIVE_UP_MS) return poll(caseId, t0, userId);
    }
    const msgs = (call.artifact?.messages ?? call.messages ?? []).filter((m) => m.role === 'user' || m.role === 'bot' || m.role === 'assistant');
    const transcript = msgs.map((m) => ({ who: m.role === 'user' ? 'Vendor' : 'Countersign', text: m.message ?? m.content ?? '' })).filter((m) => m.text);
    const userLines = transcript.filter((m) => m.who === 'Vendor').map((m) => m.text);
    const reason = String(call.endedReason ?? '');
    let result = userLines.length ? classifyAnswer(userLines) : /did-not-answer|no-answer|busy|voicemail/i.test(reason) ? 'no_answer' : /error|failed|Vapi/i.test(reason) ? 'failed' : 'no_answer';
    c.callback = { ...c.callback, status: 'ended', endedReason: reason, transcript, result, endedAt: new Date().toISOString() };
    // Re-stamp with the answer (checkCase applies the callback on top of everything else).
    const { checkCase } = await import('./cases.mjs');
    await checkCase(c);
    await db.save('cases');
    await audit(userId, 'case.callback_result', caseId, { result, stamp: c.check.score.band, said: userLines.join(' / ').slice(0, 200) });
  }, POLL_MS);
}
