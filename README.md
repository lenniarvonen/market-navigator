# Market Navigator

A founder types their company name and gets a **sourced market map** built from Cala's knowledge graph:

- **Competitors**: same-industry companies (`OPERATES_IN_INDUSTRY` + structured query) plus direct competitors named in a sourced `knowledge/search` answer.
- **Capital share**: each company's share of the capital raised across the peer set. Revenue isn't public for private companies, so this is the proxy.
- **Moat compared with peers**: capital, headcount and patents against the peer median, plus founder background with citations.
- **Likely acquirers**, ranked by evidence: companies that already own a peer (parent and subsidiary links, weight 3), counterparties in peers' acquisition or merger events (`PARTICIPATES_IN_CORPORATE_EVENT`, weight 2), and acquirers Cala cites for the sector (weight 1).
- **So what**: a short founder-facing summary. Claude writes it when `ANTHROPIC_API_KEY` is set, and a template is used otherwise.

Every number has a source chip. Data gaps are listed rather than filled with guesses. TAM is left out on purpose because Cala has no sourced market-size data.

## Run

```bash
npm install
cp .env.example .env.local   # add CALA_API_KEY (console.cala.ai), optionally ANTHROPIC_API_KEY
npm run dev                  # http://localhost:3000
```

Without `CALA_API_KEY` the app runs in **demo mode** with fictional companies, so the UI can be shown before a key is available.

## Check coverage first

```bash
CALA_API_KEY=... npm run probe -- "Aiven" "Wolt" "Oura"
```

For each company this prints the relationships Cala exposes, its corporate events and its funding rows. Run it before tuning the query strings in `lib/navigator.ts`.

## Code map

- `lib/cala.ts`: Cala API client: global rate-limit queue, 429 retry, timeout, and memory and disk cache.
- `lib/navigator.ts`: the pipeline: resolve, peers, enrich, capital share, moat, acquirers.
- `lib/summary.ts`: the "so what" summary (`claude-opus-5-5`, low effort, with a template fallback).
- `lib/demo.ts`: fictional demo data.
- `app/page.tsx`: the UI. `app/api/map/route.ts`: `GET /api/map?idea=<idea>[&company=<name>][&stage=peers]`.
- `scripts/prewarm.ts`: fills the disk cache for demo ideas.

## What the live Cala API returns (checked 14 Nov 2026)

- `knowledge/search` answers list startups as bold bullets (`- **Greenly** (Paris) — ...`). The peer list is taken from those names, because `entities` mixes startups (often typed `Organization`) with banks and funds (often typed `Company`).
- `knowledge/query` accepts a free-text industry: `companies.industry=carbon accounting for SMEs.founded_year>=2014 return(name, total_funding, last_funding_round, employee_count, founded_year)`. Cala's own industry codes (`SOFTWARE_AND_SERVICES`) are too coarse for this.
- Funding rounds come from the graph: `PARTICIPATES_IN_FUNDING_ROUND` → FundingRound entities with `round_label`, `transaction_value`, `transaction_value_units` and `announcement_date`. Investors take part with role `INVESTOR`. Peers without graph rounds get one batched query: `companies.name=(A, B).funding_rounds return(company, round_type, amount, date)`.
- Investors also come from `INVESTED_IN` on each peer.
- Corporate events are named by type (`MNA_COMPLETED`, `FINANCING_RAISED_OR_FACILITY_ENTERED`), and the peer's side carries `role` (ACQUIRER/TARGET) and `event_date`. Only MNA events where the peer was the target are looked up for the acquirer.
- Speed: entity reads take ~0.1 s. `knowledge/*` calls take 20–75 s, and Cala runs them one at a time per key. Bursts get 429 with no Retry-After. `lib/cala.ts` queues every call (1.5 s gap for knowledge calls, 0.4 s for entity reads) and retries 429s after 2, 4 and 8 s.

## Caching and demo prep

Every successful Cala response is cached on disk in `.cache/cala/` (gitignored), and so is every complete map. A mapped idea reloads in milliseconds and costs no Cala calls. Set `CALA_DISK_CACHE=0` to turn the cache off.

```bash
npm run dev
BASE_URL=http://localhost:3000 npm run prewarm   # the 3 example ideas plus 2 more; or pass your own ideas
```

`CALA_DEEP=1` turns on the slower extras: founder-background searches (for Claude's "stand out" gaps) and a sector-acquirer search. Each adds about 30–75 s on a cold run.

## Validation-stage flow (current)

Input: a one-line idea (`?idea=`), plus an optional company name (`&company=`). The map answers five questions:
1. Who's already doing this? Up to 8 startups named in a knowledge/search answer, topped up with a knowledge/query on the idea. `GET /api/map?idea=...&stage=peers` returns only this step, so the UI shows it first.
2. Is money flowing in? Dated funding rounds of those peers over the last 5 years, split into early and later rounds, with a trend and a crowding signal.
3. Who invests here? Investors in the peers, from `INVESTED_IN`.
4. Where can you stand out? 3 gaps, written by Claude from the sourced peer facts (`lib/standout.ts`), with a data-only template fallback.
5. How do companies here end? Acquirers, ranked by evidence.
