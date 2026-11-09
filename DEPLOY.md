# Putting Arpeggio online (Google Sheets + Render)

When you're done, your data lives in a Google Sheet you own, and the app runs at a public
`https://…onrender.com` address where every dealer signs in with their own account.

You need: a Google account, a GitHub account (this repo pushed to it, private is fine), and a
free [Render](https://render.com) account. Plan for about 20 minutes.

---

## 1. Create the Google Sheet

1. Go to [sheets.new](https://sheets.new) and name it something like **Arpeggio Data**.
2. Copy its ID from the address bar. It's the long part between `/d/` and `/edit`:
   `https://docs.google.com/spreadsheets/d/`**`1AbC…xyz`**`/edit`

Leave it empty. The app creates the **Releases**, **References** and **Users** tabs itself.

## 2. Create a Google "service account" (the app's robot login)

1. Open [console.cloud.google.com](https://console.cloud.google.com) and create a project, e.g. *arpeggio*.
2. **APIs & Services → Library**, search **Google Sheets API**, click **Enable**.
3. **APIs & Services → Credentials → Create credentials → Service account**. Name it `arpeggio`,
   click **Done** (no roles needed).
4. Open the new service account → **Keys → Add key → Create new key → JSON**. A `.json` file downloads.
   Treat it like a password: don't email it or commit it to GitHub.
5. Copy the service account's email (looks like `arpeggio@your-project.iam.gserviceaccount.com`).

## 3. Share the sheet with the service account

In the Google Sheet: **Share** → paste the service account email → **Editor** → untick "Notify" → **Share**.

## 4. (Optional) Try it from your Mac first

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
```

```bash
GOOGLE_SHEET_ID=PASTE_SHEET_ID GOOGLE_SERVICE_ACCOUNT_FILE=/path/to/key.json ARPEGGIO_ADMIN_PASSWORD=choose-a-password .venv/bin/python server.py
```

Open http://127.0.0.1:8000, sign in as `admin`, and watch the tabs appear in your sheet.

## 5. Deploy on Render

1. Push this repo to GitHub.
2. In Render: **New → Blueprint** → connect your GitHub → pick this repo. It reads `render.yaml`.
3. Fill in the three values it asks for:
   | Setting | Value |
   |---|---|
   | `GOOGLE_SHEET_ID` | the ID from step 1 |
   | `GOOGLE_SERVICE_ACCOUNT_JSON` | open the key `.json` file in a text editor and paste **all** of it |
   | `ARPEGGIO_ADMIN_PASSWORD` | the password for the first `admin` login (8+ characters) |
4. Click **Apply**. After a few minutes you get a URL like `https://arpeggio-xxxx.onrender.com`.

## 6. First sign-in

1. Open the URL and sign in as **admin** with the password from step 5.
2. Click your name (top right) → **Change password** if you like.
3. Go to **Users → + Add user** and create an account for each person:
   * **Admin**: everything, including Users and Data references
   * **Manager**: all dealers' releases and the full dashboard
   * **Dealer staff**: only their own dealer's releases and dashboard
4. Send each person their username and password privately. They can change it after signing in.
5. To bring in your existing spreadsheet: **Sales entry → Import CSV** (export the old sheet as CSV first).

---

## Good to know

**Editing the Google Sheet directly is fine.** The app re-reads it every minute. Some rules keep things tidy:
* Don't change the **ID** column or the header row. Add your own extra columns to the *right* only.
* New rows can leave **ID** blank; the app fills it in.
* Dates can be typed as `11/20/2026` or `2026-11-20`.
* The **Users** tab holds scrambled (hashed) passwords. Only admins should create users, through the app.

**Keep the sheet private.** Share it only with the service account and the people who manage the data.
Dealers use the app, not the sheet.

**Backups.** Google Sheets keeps every version: **File → Version history**. You can also download a copy
any time (**File → Download → Excel**).

**Free plan limits.** Render's free plan sleeps after 15 idle minutes, so the first visit afterwards takes
about 30–60 seconds. Upgrade the service to *Starter* (~$7/month) to keep it awake. Your data is safe either
way, because it lives in the sheet.

**Speed.** Reads come from a copy kept in memory, so they're instant. Saves go to Google first, which takes
about a second, and only show as saved once Google confirms. That suits dozens of people working at once.
At many thousands of releases per month, consider a real database (Supabase/Postgres).

**Time zone.** "Today" uses Philippine time (`ARPEGGIO_TZ=Asia/Manila`).
