# Countersign: demo kit

## Before you present (5 min)
- [ ] `cd core && npm start`, then open http://localhost:4181/app.html
- [ ] Mailbox → **Sync now** works on this network (if not: phone hotspot)
- [ ] Inbox has: your real Vercel bills (⚡ fast lane), the Render bills (HOLD, "via stripe.com"), and the two sample Northwind emails. If not: Mailbox → **✉ Load sample emails**
- [ ] Clean up: open the H&M "Customer" case and the duplicate Vercel XCIOXBLS-0003, then click **Not a bill**
- [ ] Signed in as **Andrii (AP Specialist)**, top right
- [ ] Second tab: the audit log

## Expo table (60 seconds)
1. **"This is my real Gmail."** Mailbox: real Vercel and Render bills, every one verified by Gmail (green SPF / DKIM / DMARC). "Countersign pulled these in by itself. Nobody uploaded anything."
2. **The boring 90%:** Inbox → a real Vercel bill → **⚡ Approve**. One click, with the reason pre-written from evidence.
3. **The scam:** open **Northwind NW-1219** (sample). "Same vendor name, but it's n0rthwind with a zero. New bank account, 9× the usual amount, DMARC failed, Reply-To goes to another domain." **STOP, risk 100.** Try Sign → locked.
4. **The point:** "AI can read the bill. It can't be accountable for paying it. Countersign makes the human fast, never optional."

## Top-5 pitch (2 minutes)
- **Hook (15 s):** "Fake bills took about $3 billion from US businesses last year (FBI IC3). They don't hack anything; they just wait for one busy person to click pay."
- **Live (60 s):** steps 1–3 above. Then switch to Akmal and show **segregation of duties** ("you uploaded it, you can't approve it") and the **two-person rule** on a bill over $10K.
- **How (25 s):** "Eight checks in plain code, the same in the browser and on the server, so it's reproducible. Live company data and scam reports through Glasser. Gmail's own sender verification. The LLM-free score means every flag has a formula and a source."
- **Proof (10 s):** audit log, "chain verified ✓".
- **Close (10 s):** credits slide → "Countersign: every bill checked, a human signs."

## Likely questions
- **"Why not let an LLM decide?"** Ask twice, get two answers, and no audit trail. Ours is deterministic, explainable, and a named person signs.
- **"What does Glasser add?"** Whether the sender is a real company (Hunter), whether the domain has scam reports (Serper), at about $0.006 per vendor. Bills through Stripe check the actual merchant.
- **"Isn't this Bill.com / Ramp?"** They pay bills. This is the fraud gate before payment, and it plugs into them by API.
- **"What if the bill is a photo?"** OCR, and people confirm low-confidence fields.
- **Was it pre-built?** Say honestly what was built before and during, plus the credits.

## Glasser track post (LinkedIn / X), tag @Glasserai
> Fake invoices cost US businesses ~$3B last year. We built **Countersign** at the Cal "Build Something AI Cannot Do Alone" hackathon: it reads every bill straight from Gmail, runs 8 deterministic fraud checks, and stamps it STOP / HOLD / CLEAR with proof. A human always signs.
>
> @Glasserai powers the "is this vendor real?" checks: company profiles via Hunter and scam-report search via Serper, about half a cent per vendor, with one key. Bills sent through Stripe get the actual merchant checked, not Stripe.
>
> AI can read a bill. It can't be accountable for paying it. 🖊️
>
> [30-second screen recording: real Gmail → auto-ingested bill → ⚡ one-click approve → scam bill → STOP, locked]

## 30-second recording script
1. (0–6 s) Mailbox: "real bills from my Gmail, verified by Gmail"
2. (6–12 s) Inbox: ⚡ Approve on a real Vercel bill
3. (12–24 s) Northwind NW-1219: STOP, scroll the flags, try Sign → locked
4. (24–30 s) Audit log → "chain verified ✓"
