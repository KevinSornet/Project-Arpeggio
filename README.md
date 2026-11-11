# SVC Sales Tracker — Vehicle Release Pipeline

A web app for dealer release pipelines. Everyone signs in; what they see depends on their role.

| Page | File | Who | What |
|---|---|---|---|
| **Sales entry** | `sales.html` | Dealer sales teams | Pick your dealer, add/edit release plans (target date, variant, unit, color, CS number, transaction, bank, client, GRM, status, remarks), change status inline, **filter and sort every column**, import CSV, export the filtered rows to CSV. |
| **Data references** | `references.html` | Admin | Edit the lists behind every dropdown: dealers, GRMs (linked to a dealer), variants, units (linked to a variant), colors, transactions, statuses, banks. Add (paste many at once), rename, reorder, delete. Renames update existing releases. |
| **Users** | `users.html` | Admin | Create accounts: **Admin** (everything), **Manager** (all dealers), **Dealer staff** (own dealer only). |
| **Dashboard** | `dashboard.html` | Everyone (dealer staff see their own dealer) | Every dealer compiled live: units sold, open pipeline, cancellation rate, financed share, sales by branch/variant/bank, GRM leaderboard, next‑8‑weeks pipeline, upcoming releases, and **sales forecasts**. |

## How it's hosted

```
Browser ──► GitHub Pages (public/: the website)
   └──────► Google Apps Script (apps-script/Code.gs + core.js: logins & roles) ──► Google Sheet (the data)
```

* **Website:** static files in [`public/`](public/), published to GitHub Pages by
  [`.github/workflows/pages.yml`](.github/workflows/pages.yml) on every push to `main`.
* **Server:** a Google Apps Script web app attached to the Google Sheet. [`public/core.js`](public/core.js)
  holds all the rules (validation, roles, permissions). It's pasted into Apps Script as `Core.gs`.
  [`apps-script/Code.gs`](apps-script/Code.gs) connects it to the sheet.
* **Data:** the Google Sheet, with **Releases**, **References** and **Users** tabs.

Setup steps: **[DEPLOY.md](DEPLOY.md)**.

### Demo mode

With no `apiUrl` in [`public/config.js`](public/config.js), the site runs the same `core.js` in the browser,
on fake data saved in that browser only. Sign in with the demo accounts shown on the login page.
To try it locally:

```bash
python3 -m http.server 8000 --directory public
```

Then open http://localhost:8000.

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

The website sends `POST` requests to the Apps Script URL with a JSON body `{ action, token, ...params }`.
Actions: `login`, `me`, `changePassword`, `meta`, `releases`, `createRelease`, `updateRelease`, `deleteRelease`,
`importReleases`, `refs`, `addRefs`, `updateRef`, `deleteRef`, `reorderRefs`, `users`, `createUser`, `updateUser`,
`deleteUser`. Errors come back as `{ error, status }`.

## Security notes

* Every permission check happens in Apps Script, not just in the page. Dealer staff can't read, change, import or
  export another dealer's releases, even by calling the script directly.
* Passwords are stored salted and hashed (iterated SHA-256). Sign-in tokens are signed with a secret kept in the
  script's properties. They expire after 14 days, and stop working as soon as the password changes or the
  account is disabled.
* 8 failed sign-ins for a username lock it for 15 minutes.
* Keep the Google Sheet private; only the script (running as you) needs access.
