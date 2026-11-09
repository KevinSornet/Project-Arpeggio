# Arpeggio — Vehicle Release Pipeline

A web app for dealer release pipelines. Everyone signs in; what they see depends on their role.

| Side | URL | Who | What |
|---|---|---|---|
| **Sales entry** | `/sales` | Dealer sales teams | Pick your dealer, add/edit release plans (target date, variant, unit, color, CS number, transaction, bank, client, GRM, status, remarks), change status inline, **filter and sort every column**, import CSV, export the filtered rows to CSV. |
| **Data references** | `/references` | Admin | Edit the lists behind every dropdown: dealers, variants, units (linked to a variant), colors, transactions, statuses, banks. Add (paste many at once), rename, reorder, delete. Renames update existing releases. |
| **Users** | `/users` | Admin | Create accounts: **Admin** (everything), **Manager** (all dealers), **Dealer staff** (own dealer only). |
| **Dashboard** | `/dashboard` | Everyone (dealer staff see their own dealer) | Every dealer compiled live: units sold, open pipeline, cancellation rate, financed share, sales by branch/variant/bank, GRM leaderboard, next‑8‑weeks pipeline, upcoming releases, and **sales forecasts**. |

## Where the data lives

* **Online: Google Sheets.** The sheet is the master copy, with **Releases**, **References** and **Users** tabs.
  See **[DEPLOY.md](DEPLOY.md)** for step-by-step setup with Google Sheets + Render hosting.
* **Local: a file.** With no Google settings, data goes to `arpeggio.db` on this computer (git-ignored),
  which is handy for trying things out.

## Run it locally

Local mode needs only Python 3.9+:

```bash
python3 server.py         # http://127.0.0.1:8000
```

The first start creates an `admin` account and prints its password in the terminal. Set
`ARPEGGIO_ADMIN_PASSWORD` beforehand to choose it yourself.

```bash
python3 seed_demo.py      # optional: ~13 months of fake demo data (--reset wipes releases first)
```

To test the Google Sheets sync without a Google account, set `ARPEGGIO_FAKE_SHEET=demo.sheet.json`.
That simulates the spreadsheet in a JSON file.

## Statuses

Statuses are editable on the Data references page. Each has a **category** that the dashboard uses:

| Category | Default statuses | Dashboard meaning |
|---|---|---|
| Open | For Bank Approval → w/ Bank Approval / Bank PO → w/ Payment → For Release | Still in the pipeline; counts toward forecasts |
| Sold | Sold | A completed sale |
| Cancelled | Cancelled | A lost deal (drives cancellation and close rates) |

Transactions marked **Needs bank** (FINANCING, BANK PO) require a bank and count as "financed".

## How the forecast works

* **Close rate** — for each transaction type (CASH, FINANCING, BANK PO, COMPANY PO), the share of closed deals that ended *Sold* rather than *Cancelled* (shrunk toward the overall rate when samples are small).
* **Booked pipeline** — every open-category release in a month × its close rate = expected units already in the pipeline.
* **Trend** — Holt's linear exponential smoothing (damped) on monthly units sold, nudged halfway toward last year's seasonality for that month once there's 12 months of history.
* **This month** = sold so far + expected from the remaining pipeline, blended with the trend (pipeline weight grows as the month goes on).
* **Next 3 months** = the larger of trend and booked pipeline, with a widening likely range.
* **By variant** — next month's forecast split by each variant's share of the last 3 months.

## Importing your existing sheet

Export the Google Sheet as CSV and use **Import CSV** on the Sales page. Headers are matched by name
(`BRANCH, TARGET RELEASE DATE, VARIANT, UNIT, COLOR, CS NUMBER, TRANSACTION, BANK, CLIENT, GRM, STATUS, REMARKS`);
a title row above the header is skipped, and rows without a branch go to the dealer currently selected. Values are matched to your reference lists ignoring case and `_` vs space (e.g. `URVAN_STANDARD` → `URVAN STANDARD`).

## API

`POST /api/login` · `POST /api/logout` · `GET /api/me` · `POST /api/me/password` · `GET/POST /api/users` · `PUT/DELETE /api/users/:id` · `GET /api/meta` · `GET/POST /api/refs` · `PUT/DELETE /api/refs/:id` · `POST /api/refs/reorder` · `GET/POST /api/releases` · `PUT/DELETE /api/releases/:id` · `GET /api/stats?from=&to=&branch=` ·
`GET /api/export.csv` · `POST /api/import?branch=`

## Security notes

* Passwords are stored hashed (PBKDF2-SHA256); sessions are signed, HttpOnly cookies that expire after 14 days
  and end immediately when a password changes or an account is disabled.
* 8 failed sign-ins from one address lock it out for 15 minutes.
* Dealer staff are restricted on the server, not just hidden in the UI: they can't read, change, import or
  export another dealer's releases.
