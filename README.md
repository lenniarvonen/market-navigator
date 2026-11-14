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

- `lib/cala.ts`: Cala API client. It handles caching and introspection, and only asks an entity for relationships it actually has.
- `lib/navigator.ts`: the pipeline: resolve, peers, enrich, capital share, moat, acquirers.
- `lib/summary.ts`: the "so what" summary (`claude-opus-5-5`, low effort, with a template fallback).
- `lib/demo.ts`: fictional demo data.
- `app/page.tsx`: the UI. `app/api/map/route.ts`: `GET /api/map?q=<company>`.

## Known assumptions to verify with a live key

The Cala docs don't specify these yet, so the code parses them loosely:

- Dot-notation field names: `total_funding`, `funding_rounds`, `patents.assignee`.
- Row keys returned by `knowledge/query`.
- Whether `CorporateEvent` names or descriptions say "acquisition".

## Validation-stage flow (current)

Input: a one-line idea (`?idea=`), plus an optional company name (`&company=`). The map answers five questions:
1. Who's already doing this? Companies similar to the idea (knowledge/search) plus companies in its industry (knowledge/query).
2. Is money flowing in? Dated funding rounds of those peers over the last 5 years, split into early and later rounds, with a trend and a crowding signal.
3. Who invests here early? Investors in the peers' pre-seed and seed rounds, if Cala's round data names them.
4. Where can you stand out? 3 gaps, written by Claude from the sourced peer facts (`lib/standout.ts`), with a data-only template fallback.
5. How do companies here end? Acquirers, ranked by evidence.
