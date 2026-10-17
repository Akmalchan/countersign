# Countersign

**Every bill gets checked. A human signs.**

Fake invoices are the most common way businesses lose money to email fraud: a bill that
looks like it's from a vendor you already pay, one changed bank account, a little panic.
Countersign reads every bill before money leaves, runs 14 deterministic checks (the bill, the email, the document) against
your own records and live company data, shows the proof, and **never pays on its own**.

> AI can read a bill. It can't be accountable for paying it.

Built at *Build Something AI Cannot Do Alone* @ Cal, October 2026.

---

## What it does

| | |
|---|---|
| **Bills ingest themselves** | Connect Gmail and new bills become checked cases every 2 minutes, with no clicks. Receipts, refunds, tickets and duplicates are skipped. Or drop in a PDF or photo. |
| **Reads real documents** | PDF text layer (pdf.js) or OCR for photos (tesseract.js), then rules that pull out vendor, invoice #, total, dates, bank account and address, each with a confidence badge. People confirm before anything runs. |
| **8 checks + email evidence** | Lookalike sender · bank details changed · amount anomaly · vendor footprint · address · pressure language · duplicate · scam reports. Bills that arrive by email also get Gmail's own SPF / DKIM / DMARC verdicts and a Reply-To check. |
| **A stamp with proof** | STOP / HOLD / CLEAR, a risk score, a confidence score, and for every flag: the formula, the evidence, and the source. |
| **People decide** | A STOP can't be approved. Every decision needs a reason. Bills ≥ $10K need two different people. Whoever uploaded a bill can't approve it. Editing a bill clears its signatures. |
| **Fast lane** | Routine bills (known vendor, normal amount, all checks pass, verified sender) get a pre-written reason, so it's one click. They're never auto-approved. |
| **Learns from people** | A "false alarm" makes that check quieter; a rejection makes its flags louder. Every change is logged. |
| **Tamper-evident audit log** | Every event is hash-chained to the one before it; editing history breaks the chain and the console shows it. |

## How it works

```
Gmail (IMAP) ─┐
Upload PDF ───┼─► Read (pdf.js / OCR) ─► fields ─► 8 deterministic checks ─► score + combos ─► stamp ─► humans sign
Photo / scan ─┘                                     ▲               ▲
                                     your vendor records    live data: Glasser (Hunter, Serper) + RDAP
                                                                  email: Gmail SPF/DKIM/DMARC, Reply-To
```

- **No LLM decides anything.** The score is plain code (`site/js/engine.js`), the same file in the browser and on the server, so the same bill always gets the same stamp.
- **Unknown stays unknown.** Missing data lowers confidence and holds the bill; it's never guessed.
- **Combinations weigh more than single flags:** lookalike sender + new bank account = +25, the classic invoice-redirect pattern.
- **Email evidence only makes a stamp stricter:** DMARC fail → STOP; Reply-To on another domain → at least HOLD.

## Live data via Glasser

| Signal | Endpoint | Cost |
|---|---|---|
| Is the vendor a real company? founded, headcount | Glasser → Hunter `/v2/companies/find` | $0.0049 (free when no record) |
| Public scam reports naming the domain | Glasser → Serper `/search` | $0.0011 |
| Domain registration date (or "not registered") | public RDAP | free |

About **$0.006 per new vendor domain**, cached afterwards. Guard rails: an endpoint allow-list with max price per call, and a $1 spend cap per server run.
Bills sent through Stripe and similar platforms check the **merchant** named on the bill (e.g. render.com), not the platform.
Scam-search hits only count when they're on a complaint site, name the exact domain and use scam language; big established companies get their hits discounted (they're impersonated, not the scammers).

## Run it

```bash
cd core
npm install
cp .env.example .env      # optional: GMAIL_USER + a Google app password for the mailbox
npm start                 # → http://localhost:4181
```

- `/` product site · `/desk.html` interactive demo · **`/app.html` the console**
- Needs Node 22.12+ and a signed-in Glasser CLI (`glasser login`) for live checks.
- Some networks block email ports (993); if Gmail sync fails, try another network.

## Honest limitations

- Bill reading is rules + OCR, not AI: great on normal digital invoices, weaker on unusual layouts, so people confirm fields.
- Check weights are hand-tuned, then nudged by your team's decisions.
- Traffic, company and scam data cover established businesses well; brand-new small vendors mostly come back "unknown" (by design, that means HOLD).
- Single-tenant local server; users are a demo switcher, not real login.
- Sample bills and sample emails are fictional (made-up vendors on reserved `.example` domains) and are never sent through real email.

## Credits

Ideas and patterns from other hackathon projects, credited with thanks:
- **Reva** (tokens& Cyberdefense, Semgrep 1st place, MIT): deterministic gate first, "only speak when you can prove it", honest README.
- **Beagle Brigade**: combinations of signals carry the weight; lookalike-name detection.
- **Provenance** (Company Brain 1st): every number has a history → every flag has its evidence.
- **Marketing Brain**: learn from each rejection. **Enterprise Brain**: only people approve.

Libraries: pdf.js, tesseract.js, imapflow, mailparser. Data: Glasser, RDAP.
