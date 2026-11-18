# Price Intelligence OS

An always-on competitive pricing intelligence platform for FMCG brands. It collects price observations for your own
products and competitor products across retailers and markets, keeps every observation permanently, and turns the
history into monitoring, comparisons, promotion analysis, alerts and reports.

**The foundation is an append-only price ledger: an observation, once stored, is never overwritten or deleted.**

| Section | What it does |
| --- | --- |
| Overview | Headline figures, price movement, own vs competitor position, recent changes, promotions, markets |
| Live Price Monitor | Latest price, unit price, promotion, deal tags, availability and freshness of every listing |
| Deals | Listings on offer right now — tagged deals, promotions and prices below the regular price — with the context of their own history (30-day average, 90-day low, on deal since). Above the list, the comparison: how much of each range is on offer and how deep, own brands beside competitors, by brand, product range, retailer and market; brand × retailer and brand × kind of offer; the last 30 days |
| New Products | Listings that appeared at a retailer after its first load: possible launches, kept apart from known products that reached another retailer |
| Product Catalogue | Products, variants, brands, categories, CSV / Excel import, listing matching, competitor mappings |
| Brand Explorer | Brand by brand: the range, a price matrix across retailers and markets, the trend, and the brands it competes with |
| Competitor Intelligence | Own product vs mapped competitors: prices, price per 100 ml / 100 g, gaps, history |
| Historical Price Explorer | Any slice of the ledger by retailer, product, brand, market, date, price, promotion, availability; period comparisons |
| Promotion Intelligence | Promotions detected from observations: depth, duration, frequency, timeline |
| Market Intelligence | Ten initial markets (more can be added), cross-market comparison with explicit currency conversion |
| Alerts Centre | Rules, thresholds, notification preferences and alert history |
| Data Collection Centre | Source health, jobs, logs, retries, imports and manual entry |
| Reports | Six report types with CSV and Excel export |
| Administration | Users and roles, retailers and sources, markets, exchange rates, integrations, database / Excel, audit log |

An assistant ("Ask AI") answers questions in plain language — strictly from stored observations.

---

## Quick start

Requires **Node.js 22.18 or newer**. No database server is needed.

```bash
npm install
```

```bash
npm run build
```

```bash
npm start
```

Open <http://localhost:4000>.

On the first start of an empty database the server creates the schema, loads the reference data (currencies, ten
markets) and — unless `PIOS_SEED_DEMO=false` — loads the **DEMO dataset** so every screen has something to show.

**Signing in the first time**

- `npm start` runs in production mode. If `PIOS_ADMIN_EMAIL` and `PIOS_ADMIN_PASSWORD` are set, that administrator
  is created. Otherwise an administrator with a random one-time password is created and printed **once** in the
  server output; a new password must be chosen at first sign-in.
- In development (`npm run dev`) three demo accounts exist — `admin@priceintel.local`, `analyst@priceintel.local`,
  `viewer@priceintel.local`, password `PriceIntel-Demo-2026` — and the sign-in page offers them. They are created
  only outside production (or when `PIOS_DEMO_ACCOUNTS=true`); never enable them on a reachable server.
- Lost the administrator password? `npm run cli -- reset-password you@example.com`.

**Development**

```bash
npm run dev
```

Web app on <http://localhost:5173> (hot reload), API on <http://localhost:4000>.

**Docker**

```bash
docker compose up -d --build
```

Data lives in the `pios-data` volume (`/data` in the container). See `docker-compose.yml` for the settings.

---

## Demo data — and how to replace it

The demo dataset (31 products, 30 retailers in 10 markets, about four months of observations) uses real brand and
retailer names with **fictional prices**. It exists to show how the product works, not what any market looks like.

- Every demo record is flagged in the database and labelled **DEMO** wherever it appears: tables, charts, reports,
  exports, alerts and assistant answers. Demo listing links point at `demo.invalid`.
- Demo "collection" is produced by a simulated source. Its runs are shown as *simulated* and are **never counted as
  real collection**: success rates, "last successful collection" and source health keep real and simulated apart.
- Remove it in **Administration → Database (Excel)** or with `npm run db:purge-demo`. Only demo records are removed; anything
  you entered, imported or collected stays. `npm run db:seed-demo` loads it again.
- Start without it: `PIOS_SEED_DEMO=false`.

---

## Getting real prices in

There are three ways, and each observation records which one produced it.

**1. Manual entry** — *Live Price Monitor → Add observation* (or the Data Collection Centre). Optionally attach a
screenshot or link as evidence. Labelled *Manual entry*.

**2. CSV / Excel import** — *Data Collection Centre → Import price history*. Upload a `.csv` or `.xlsx`, map the
columns, review the row-by-row validation, then commit. Rows keep their original dates, are labelled *Imported
history*, and the file is kept as evidence. Templates can be downloaded on the same screen. Products can be
imported the same way from the Product Catalogue.

**3. Automated sources** — configured per retailer in *Administration → Retailers & listings*, scheduled every 6 hours, 12
hours, daily, weekly, or run manually. Nothing is pre-connected: a source shows **Not configured** until it has
what it needs, and **Failing** when a run did not succeed.

| Method | What you must provide |
| --- | --- |
| Official API | The retailer's API endpoint, the credential they issued to you, and a field mapping (price, identifier, availability) |
| Product feed | The feed URL (JSON, XML or CSV) with the retailer's permission, and a field mapping |
| Permitted website extraction | A product-page URL on each listing and an administrator's attestation that the site's terms permit this access. Reads schema.org data, price meta tags, or a CSS selector / pattern you supply |
| Third-party data integration | Your own account and token with a data provider, its delivery endpoint and a field mapping |

Credentials are stored encrypted and never shown again. "Test connection" performs a real request and reports what
actually happened.

**Deal tags and signals.** What a retailer shows next to a price is kept with the observation, historically, like
the price itself: the deal tag ("Limited time deal", "Yellow Friday Deal", "Lowest price in 30 days", coupons,
multi-buy offers), badges (best seller, the retailer's choice, selling fast), the rating and number of reviews, the
sales rank and the seller. The retailer's own wording is stored alongside the tag. A plain "Save 30 %" is a price
cut, not a tag. Tags arrive through every route: a *Tags* column in imports, the manual-entry form, and the field
mapping of feeds and provider snapshots.

**Provider snapshots (third-party data integration).** A data provider collects on its own schedule and delivers a
snapshot; this system reads the latest one. The mapping understands what such snapshots look like:

| Mapping option | Meaning |
| --- | --- |
| `sale_price \|\| price` | Alternatives: the first field that has a value is used |
| Tag / badge fields | Fields holding the tags shown with the price — one text, a list of texts or a list of objects with a text. "#3 in Shampoos" is read as the sales rank |
| Yes/no fields that mean a badge | e.g. `is_bestseller` → "Best seller" |
| Rating, reviews, sales rank, seller | Stored with the observation |
| Observation time: the item's own timestamp | Each price is dated when the provider saw it, so reading an unchanged snapshot twice adds nothing |

A list price below the selling price, or more than ten times above it, is not stored as the regular price (the
observation says so). For Apify, schedule a *task* per retailer site in your own Apify account, store your API token
as the source credential and point the source at
`https://api.apify.com/v2/actor-tasks/<TASK_ID>/runs/last/dataset/items?status=SUCCEEDED&clean=true&format=json`;
a ready-made template is offered when you configure a third-party source.

**First load of a large catalogue.** Thousands of products cannot be created by hand. `load-catalogue` (see
*Maintenance commands*) reads one prepared JSON file — retailers, products, the listings that belong to them, the
basis of every match, and optionally the observed price of each listing with its tags — and loads it through the
same ledger rules as everything else. It is idempotent, never creates demo data, keeps the raw files you name as
evidence, records why each listing was matched to its product, and raises no alerts for the first observation of a
listing. `--dry-run` reports what would happen and stores nothing. The file format is documented at the top of
`server/services/catalogue-load.ts`.

**New products.** A feed, API or provider source with *Add unknown items as unmatched listings* switched on
stores the items it does not know as unmatched listings. *New Products* lists what was first seen in the last 7, 30
or 90 days. A listing counts as new only if it was first seen more than 48 hours after the first listing of its
retailer and, where its brand is known, of that brand at that retailer: a first load is a baseline, not a launch.
*New product* means nothing says the product was on sale anywhere before; *new at a retailer* means it was already
listed elsewhere. The brand of an unmatched listing is recognised from the retailer's title or page address — a
guess that is not stored and matches nothing. Nothing is matched or created automatically; review happens in
*Product Catalogue → Matching*.

**Adding a platform.** *Administration → Retailers & listings → Check a site* answers the first question about a
new retailer: can its product pages be read directly, at no cost? It reads the site's `robots.txt`, requests one
product page only if that allows it, and reports what it found — readable directly, opens but shows no readable
price, does not answer automated visits, or ruled out by the site's own rules. It never tries to get past a
verification page, and it says what is technically possible, not what the retailer's terms permit. Then *Add
retailer*, choose how prices arrive, and switch on discovery so its range is found.

**Planning what collection costs.** *Data Collection Centre → Cost planner* multiplies each platform's number of
products by how often they are checked and by the provider price entered for it, and shows the plan beside what
daily collection of everything would cost. Existing platforms come with their real number of listings and current
schedule; planned platforms can be added to see what growing would cost. Enter what a provider charges per 1,000
items once in the source's settings ("Provider price per 1,000 items") and the planner starts from it. It is a
calculator: this system neither pays nor measures provider charges, and the plan is kept in the browser only.

**Collection rules built in**

- `robots.txt` is fetched and obeyed on every website-extraction run; disallowed pages are skipped and logged.
- Website extraction refuses to run without the permission attestation.
- Requests are rate-limited per retailer and identify themselves with `PIOS_USER_AGENT`.
- Pages are fetched as plain HTML. Prices rendered only by JavaScript in the browser cannot be read; use an API,
  feed or third-party integration for such sites.
- A failed run is recorded as failed, with its error, and retried according to the retry setting. It never
  produces observations.

You remain responsible for having the right to collect from each source.

---

## Your database as an Excel file

The system of record is a relational database (Excel cannot guarantee that history is never overwritten, nor take
writes from scheduled collection). On top of it:

- **Download everything as one workbook** — *Administration → Database (Excel)*, or
  `npm run db:export-excel`. One sheet per entity (price observations, products, retailers, listings, promotions,
  price changes, exchange rates, alerts, …) plus a README sheet and a data dictionary.
- **An always-current Excel copy on disk** — `<data dir>/exports/price-intelligence-database.xlsx`, rewritten
  automatically (hourly by default) whenever data has changed. Point Excel or Power BI at this file.
  `PIOS_EXCEL_MIRROR=off` disables it; `PIOS_EXCEL_MIRROR_MINUTES` sets the interval.
- **Excel in** — price history and products can be imported from `.xlsx` as well as `.csv`.
- **Filtered exports** — any selection in the Historical Price Explorer exports to CSV or Excel; every report
  exports to both.

Editing the Excel copy does not change the database. To add or correct data, import a file or use the screens.

---

## How history is protected

- `price_observations` is append-only. Database triggers reject every `UPDATE` and every `DELETE` of a real
  observation, including indirect ones (`INSERT OR REPLACE`).
- Re-submitting the same observation (same listing, time and values) is recognised and skipped, whichever channel
  it arrives through.
- A correction does not overwrite: the newer observation *supersedes* the older one, which stays in the ledger
  marked void, with who and why. An administrator can void or restore an observation; both are audited.
- Each observation stores: retailer, listing, market, currency, regular / selling / promotional price, discount,
  promotion type and text, availability, product URL, when it was observed (UTC, and the market-local date), when
  it was collected, the collection method, the job or import batch, evidence, a confidence score and whether it is
  demo data.
- Price changes, promotion episodes and "latest price" are derived from the ledger and can be rebuilt from it.
- Timestamps are stored in UTC and shown in each market's local time.

---

## Comparisons and currencies

- A competitor comparison uses mappings you approve in the Product Catalogue. A mapping is either *equivalent* or
  *non-equivalent*; non-equivalent pairs are labelled as such and compared on price per 100 ml / 100 g only.
  Products measured in different units (ml vs g) are never given a gap.
- Identical names are not assumed to be identical products: a retailer listing is matched to a catalogue product
  explicitly (suggested matches must be approved).
- Prices are never compared across currencies without conversion. Every converted figure carries the exchange
  rate, its timestamp and its source. If a rate is missing, the figure is not shown and the missing currency is
  named. Rates are entered manually or fetched from a provider in *Administration → Exchange rates*; the demo
  dataset's rates are illustrative and labelled DEMO.

---

## Alerts and notifications

Rules (competitor price drop, own brand dearer than a mapped competitor, competitor promotion, product
unavailable, price change, unexpected increase, repeated collection failure, no fresh observation) are evaluated
against stored observations as they arrive. Thresholds and scope are editable; an alert raised by a price or
availability change links to the observation that caused it.

In-app notifications need nothing. E-mail needs an SMTP server and a webhook needs a URL — both are set, and can
be tested for real, in *Administration → Integrations*. Until then they are shown as not configured.

*New product found at a retailer* — one alert per collection run that found new listings (count, recognised
brands, first titles), never for a first load or a demo source. Scope it by market, retailer or brand and set a
minimum number of listings per run. Existing installations receive the default rule with migration 003.

---

## The assistant

- Questions are turned into a structured query; **the answer and every number in it are computed from the
  database**. Each answer states how many stored observations it rests on, their origin and date range, and links
  to the same records in the Historical Price Explorer.
- If the product, retailer or market is not monitored, or nothing was observed in the period, it says the data is
  unavailable. It does not estimate, forecast or fill gaps.
- By default questions are interpreted by a built-in engine (no external service). With an Anthropic API key
  (*Administration → Integrations*, or `ANTHROPIC_API_KEY`) Claude interprets free-form phrasing instead; it
  receives the question and the names in your catalogue, not your prices, and its output is validated before
  anything is queried. If the call fails the built-in engine answers and the reason is shown.
- The Claude path uses Anthropic's server-side refusal fallback (beta) so that a declined request is answered by a
  fallback model rather than failing.

---

## A read-only snapshot you can open from a link

`npm run build:snapshot` turns the app and a copy of the database into a static website (in `dist/pages`) that
needs no server: put it on GitHub Pages or any static host and everyone with the link sees the app with the data
as it stood when the snapshot was taken.

```bash
npm run build:snapshot
```

```bash
npm run build:snapshot -- --db data/backups/some-backup.db
```

How it works: the page downloads the database copy (a few MB) and opens it with SQLite compiled to WebAssembly.
The app's own routes and services — the same code the server runs — answer the screens from that copy, inside a
background worker in the visitor's browser. Nothing is sent anywhere.

What a snapshot is, and is not:

- **Read-only.** Every visitor is the built-in *Snapshot viewer* (the Viewer role). Changes are refused; on-screen
  reports, report CSV files and the assistant's built-in engine work because they are computed from the stored
  records. Price collection, imports, Excel/CSV exports, evidence files and the administration area are not part of
  a snapshot.
- **A moment in time.** "Now" inside the snapshot starts at the moment it was taken, so freshness, ages and current
  offers read exactly as they did then, however much later the link is opened. A banner states the real date.
- **Public if the host is public.** There is no sign-in on a static page: anyone who has the link (or finds the
  files) can read everything in it. The page asks search engines not to index it, which is a request, not a lock.
- **Cleaned before it leaves.** The copy contains no password hashes, sessions, stored credentials, audit trail,
  saved assistant questions or report runs; account names and addresses are replaced; ids and links of third-party
  provider datasets are withheld. Price observations are copied untouched. The original database is only read.

To publish on GitHub Pages: push the contents of `dist/pages` to a branch (conventionally `gh-pages`) and choose
that branch under *Settings → Pages*. To take it down, switch Pages off there (and delete the branch).

---

## Roles and security

| Role | Can |
| --- | --- |
| Administrator | Everything, including users, sources and credentials, integrations, voiding observations, demo data |
| Analyst | Catalogue, observations, imports, running collection, alert rules, reports, database export |
| Viewer | Read everything, generate reports, use the assistant |

Passwords are hashed with scrypt; sessions are HttpOnly, SameSite cookies with idle and absolute expiry; repeated
failed sign-ins lock the account temporarily; writes are checked for cross-site origin; every write without an
explicit permission is administrator-only; changes are recorded in an append-only audit log. Outbound collection
requests cannot reach private network addresses in production unless `PIOS_ALLOW_PRIVATE_NETWORK=true`, and the
app refuses to be shown inside another site's frame in production unless `PIOS_ALLOW_EMBEDDING=true`.

Run it behind HTTPS (a reverse proxy with `PIOS_TRUST_PROXY=true`) on anything other than a local machine.

---

## Configuration

All settings are environment variables; `.env` is read automatically by `npm start`, `npm run dev` and the
maintenance commands. See [`.env.example`](.env.example) for the full annotated list. The most important:

| Variable | Purpose | Default |
| --- | --- | --- |
| `PORT` | HTTP port | `4000` |
| `PIOS_DATA_DIR` | Database, evidence, imports, Excel copy, secret key | `./data` |
| `PIOS_ADMIN_EMAIL`, `PIOS_ADMIN_PASSWORD` | First administrator | generated |
| `PIOS_SEED_DEMO` | Load the demo dataset into an empty database | `true` |
| `PIOS_SCHEDULER` | Scheduled collection. `off` leaves manual runs, the Excel copy, alerts and rate refresh working | `on` |
| `PIOS_TRUST_PROXY` | Behind a TLS-terminating proxy | `false` |
| `PIOS_SECRET_KEY` | Key for encrypting stored credentials | generated in the data dir |
| `ANTHROPIC_API_KEY` | Optional, for the assistant | — |

## Maintenance commands

```bash
npm run db:status
```

| Command | Effect |
| --- | --- |
| `npm run db:migrate` | Create or upgrade the schema |
| `npm run db:status` | Row counts, split into real and demo |
| `npm run db:seed-demo` / `npm run db:purge-demo` | Load / remove the demo dataset |
| `npm run db:export-excel` | Write the whole database as an Excel workbook |
| `npm run db:backup` | Write a consistent copy of the database file |
| `npm run cli -- load-catalogue <file.json> [--dry-run] [--update-products]` | Load a prepared catalogue file: retailers, products, listings and the price observed for each listing. `--update-products` also brings products that are already on record in line with the file |
| `npm run cli -- suggest-mappings [--min-retailers N]` | Propose competitor pairings for own products (never approved automatically); with `N`, only for own products listed at N retailers or more |
| `npm run cli -- fetch-rates` | Fetch the latest exchange rates from the configured provider |
| `npm run cli -- create-admin <email> [name]` | Create an administrator with a one-time password |
| `npm run cli -- reset-password <email>` | Reset a password and sign the user out everywhere |

**Backups:** back up the whole data directory (database, evidence files and `secret.key` — without the key, stored
credentials cannot be decrypted). `npm run db:backup` can run while the server is up.

---

## Architecture

```
client/   React + TypeScript web app (Vite, Tailwind)        → built to dist/client, served by the API server
server/   Fastify HTTP API, run directly from TypeScript
  db/         schema migrations (SQL) and the SQLite adapter
  services/   ingestion (the ledger), derived state, analytics, collection engine, alerts, reports, assistant
  routes/     one file per API area, registered automatically
  seed/       reference data and the demo dataset
shared/   Types and constants used by both sides
snapshot/ The read-only static edition: runs server/routes + services in the browser on SQLite-WebAssembly
tests/    API and service tests (node:test)
```

- **Database:** SQLite through Node's built-in driver — one file, no server to operate, write-ahead logging, and
  the append-only rules enforced inside the database itself. It comfortably holds millions of observations on one
  node. All SQL sits behind a small adapter and plain-SQL migrations, so moving to PostgreSQL for multi-node use is
  a port of that adapter and the migration file rather than a redesign.
- **Collection engine:** connectors implement one interface; the scheduler picks due sources, runs them with
  timeouts, retries and per-retailer rate limits, and writes through the same ingestion path as imports and manual
  entry. New connectors are added in `server/services/collection/`.
- **No build step for the server.** Node 22 runs the TypeScript sources directly.

## Tests

```bash
npm test
```

```bash
npm run typecheck
```

The suite covers the ledger guarantees, ingestion and de-duplication, catalogue and matching, imports and exports,
the collection engine (against local fixture servers), provider snapshots with tags, the bulk catalogue load, deal
tags and the Deals and Brand Explorer figures, alerts, administration, analytics against hand-computed figures,
reports, the assistant, access control and security headers, the demo dataset's labelling and removal, and the
clean-up of the database copy that a public snapshot ships with, new-product detection (baseline rule, brand
recognition, the alert of a collection run) and the site check.

## Known limits

- Website extraction does not execute JavaScript (see above).
- Brands have no alternative spellings yet: a title that names a brand only in Arabic is recognised from the page
  address where it contains the name, otherwise not at all.
- A platform has one collection schedule. Checking its key products more often than the rest (two speeds within
  one platform) is not built; the cost planner therefore plans one pace per platform.
- No retailer integration is pre-configured; each needs the access and credentials described above.
- Price context on the Deals page (30-day average, 90-day low) and its 30-day trend need history: they fill in as
  days are collected. Shares in the comparison are measured against the listings that were observed with a fresh
  price, so a retailer that was not collected recently drops out of them instead of counting as "no offers".
- Listings are matched to the same product on a barcode, on the retailer's own item id across its country sites, or
  on brand, product type, pack size and identical name words. Products that retailers describe differently stay
  separate until a person matches them.
- The Claude-backed interpretation of assistant questions is implemented and unit-tested with a stand-in, but has
  not been exercised against the live API in this repository's test run (it needs your key).
- Single-node by design (SQLite). Run one server process per data directory.
- Reports export to CSV and Excel; PDF is available through the browser's print dialog.
