# Countersign core (live mode)

Serves the site and checks real bills against live vendor data.

```
node core/server.mjs        # → http://localhost:4181  (desk: /desk.html, flip "Live: on")
```

Needs Node 22.12+ and a signed-in Glasser CLI (`glasser login`). The Key stays in the
CLI's own store; nothing in this repo reads or stores it.

## API
| Route | Body | Returns |
|---|---|---|
| `GET /api/health` | – | spend so far, Glasser balance (free) |
| `POST /api/intel` | `{ "domain": "vercel.com" }` | engine-ready intel record + every source with its Run link and charge |
| `POST /api/check` | `{ "invoice": {...}, "vendors"?, "weights"?, "dismissed"? }` | intel + all 8 check results + score/stamp |

## Where the data comes from
| Signal | Source | Cost |
|---|---|---|
| Company exists, founded, headcount | Glasser → Hunter `/v2/companies/find` | $0.0049 (free when no record) |
| Scam reports naming the domain | Glasser → Serper `/search` | $0.0011 |
| Domain registration date | public RDAP (rdap.org) | free |

About **$0.006 per new domain**; repeats come from `core/cache/` for free.

## Guard rails
- Only allow-listed Endpoints, each with a max price per call (`lib/glasser.mjs`).
- Spend cap per server process: `$1` by default (`COUNTERSIGN_BUDGET_USD`).
- Missing data stays **unknown**; it's never guessed.
- Scam search hits only count when they're on a complaint/forum site, name the exact
  domain, and use scam language. Long-established companies (5+ years, 200+ people) get
  their hits discounted: those are criminals impersonating the brand, not reports
  against it. (A naive count flags vercel.com because of "phishing on Vercel" articles.)

The scoring is `site/js/engine.js`, the same file the browser runs, so live and demo
mode can't disagree.
