# Putting SVC Sales Tracker online (GitHub Pages + Google Sheets)

How it fits together:

```
 Browser ──► GitHub Pages (the website: public/)
    │
    └──────► Google Apps Script web app (checks logins & roles) ──► your Google Sheet (the data)
```

* **GitHub Pages** serves the pages. They're static files, free to host.
* **Google Apps Script** is a small program that runs on Google's servers, attached to your sheet.
  It's the only thing that can read or write the sheet, and it enforces who can see what.
* **The Google Sheet** holds everything: **Releases**, **References** and **Users** tabs.

All free. Allow about 20 minutes.

> Until step 3 is done the site runs in **demo mode**: fake data stored in each visitor's own browser.
> That's handy for trying it out, but nothing is shared between people.

---

## 1. Create the sheet and its script

1. Go to [sheets.new](https://sheets.new) and name the sheet **SVC Sales Tracker Data**.
2. In the sheet: **Extensions → Apps Script**. A script editor opens.
3. In the editor's left panel you'll see `Code.gs`. Replace its contents with
   [`apps-script/Code.gs`](apps-script/Code.gs) from this repo.
4. Click **+** next to *Files* → **Script**, name it **Core** (it becomes `Core.gs`), and paste in the
   contents of [`public/core.js`](public/core.js).
5. Click **Save** (💾).

## 2. Run the one-time setup

1. In the toolbar's function dropdown pick **setup**, then click **Run**.
2. Google asks for permission the first time: **Review permissions** → pick your account →
   **Advanced → Go to … (unsafe)** → **Allow**. ("Unsafe" just means Google hasn't reviewed *your own* script.)
3. Open **Execution log** at the bottom. It shows:
   `FIRST ADMIN ACCOUNT → username: admin   password: ……`
   Copy that password. You'll change it after signing in.

Your sheet now has **Releases**, **References** and **Users** tabs.

## 3. Publish the script as a web app

1. **Deploy → New deployment** → click the ⚙️ next to *Select type* → **Web app**.
2. Set **Execute as: Me** and **Who has access: Anyone**.
   ("Anyone" lets the website reach the script. The script still requires a sign-in for everything.)
3. **Deploy**, then copy the **Web app URL**. It ends in `/exec`.
4. In this repo, open [`public/config.js`](public/config.js) and paste it in:
   ```js
   window.ARPEGGIO_CONFIG = {
     apiUrl: 'https://script.google.com/macros/s/AKfy…/exec',
   };
   ```

## 4. Turn on GitHub Pages

1. Commit and push to the `main` branch.
2. On GitHub: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. The *Deploy to GitHub Pages* workflow runs (watch the **Actions** tab). When it's green, the site is at
   `https://<your-username>.github.io/<repo-name>/`.

> On a free GitHub account, Pages only works for **public** repositories. That's fine here: the code holds no
> secrets. The data lives in your private sheet, and the script URL is useless without a sign-in.
> To keep the repo private you need GitHub Pro.

## 5. First sign-in

1. Open the site and sign in as **admin** with the password from step 2.
2. Click your name (top right) → **Change password**.
3. **Users → + Add user** for each person:
   * **Admin**: everything, including Users and Data references
   * **Manager**: all dealers' releases and the full dashboard
   * **Dealer staff**: only their own dealer's releases and dashboard
4. To bring in the old spreadsheet: **Sales entry → Import CSV** (export the old sheet as CSV first).

---

## Updating later

* **Website changes** (anything in `public/`): push to `main`. Pages redeploys by itself.
* **Changes to `core.js` or `Code.gs`**: paste the new contents into the script editor, then
  **Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy**.
  The URL stays the same. Update **Core.gs** whenever `public/core.js` changes, so the server and the
  website agree.

## Good to know

**Editing the sheet directly is fine.** The app reads it fresh on every request.
* Don't change the **ID** column or the header names. Add your own columns anywhere; the app leaves them alone.
* New rows can leave **ID** blank; the app fills it in. Dates can be `11/20/2026` or `2026-11-20`, and
  values like `patrol` or `w/ payment` are matched to your lists.
* The **Users** tab holds scrambled (hashed) passwords. Create users through the app, not by typing in the sheet.

**Keep the sheet private.** Don't share it with dealers; they use the website.

**Locked out?** In the script editor, run **resetAdminPassword**. The new `admin` password appears in the
Execution log.

**Speed.** Each save takes about 1–3 seconds, because Google Apps Script isn't fast. Reading is quick, and the
dashboard calculates in your browser, so filters are instant. Google's free limits are generous for a team of
dealers (roughly 20,000 requests a day).

**Backups.** **File → Version history** in the sheet keeps every past version.

**Time zone.** "Today" uses Philippine time (`TIME_ZONE` at the top of `Code.gs`).
