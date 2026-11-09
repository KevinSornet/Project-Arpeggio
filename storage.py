"""Storage for Arpeggio.

Two modes, picked from environment variables:

* **Google Sheets** (online) — set GOOGLE_SHEET_ID plus GOOGLE_SERVICE_ACCOUNT_JSON (the key file's
  contents) or GOOGLE_SERVICE_ACCOUNT_FILE (a path). The spreadsheet is the source of truth. On
  start-up the server reads it into an in-memory SQLite copy that serves every read (so dashboards
  don't burn through Google's API quota). Every save is written to the sheet *before* it is committed
  locally; if Google rejects it, the local change is rolled back. The copy is refreshed from the
  sheet every ARPEGGIO_REFRESH_SECONDS (default 60) so edits made directly in the sheet show up.
* **Local file** (default) — a SQLite file (arpeggio.db), handy for development.

ARPEGGIO_FAKE_SHEET=/path/file.json simulates a spreadsheet in a JSON file, for testing the sync
logic without Google credentials.
"""
from __future__ import annotations

import json
import os
import sqlite3
import sys
import threading
import time
from collections import defaultdict
from contextlib import contextmanager

# Each table, the worksheet (tab) that holds it, and its columns: (db column, sheet header)
TABLES = {
    "releases": ("Releases", [
        ("id", "ID"), ("branch", "DEALER"), ("target_date", "TARGET RELEASE DATE"), ("variant", "VARIANT"),
        ("unit", "UNIT"), ("color", "COLOR"), ("cs_number", "CS NUMBER"), ("transaction_type", "TRANSACTION"),
        ("bank", "BANK"), ("client", "CLIENT"), ("grm", "GRM"), ("status", "STATUS"), ("remarks", "REMARKS"),
        ("created_at", "CREATED AT"), ("created_by", "CREATED BY"), ("updated_at", "UPDATED AT"),
        ("updated_by", "UPDATED BY"),
    ]),
    "refs": ("References", [
        ("id", "ID"), ("kind", "LIST"), ("name", "NAME"), ("parent", "PARENT VARIANT"),
        ("category", "CATEGORY"), ("sort", "ORDER"),
    ]),
    "users": ("Users", [
        ("id", "ID"), ("username", "USERNAME"), ("name", "NAME"), ("role", "ROLE"), ("dealer", "DEALER"),
        ("active", "ACTIVE"), ("password_hash", "PASSWORD HASH (DO NOT EDIT)"), ("created_at", "CREATED AT"),
    ]),
}
INT_COLS = {"id", "sort", "active"}

SCHEMA = """
CREATE TABLE IF NOT EXISTS releases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    branch TEXT NOT NULL,
    target_date TEXT NOT NULL,          -- ISO yyyy-mm-dd
    variant TEXT NOT NULL,
    unit TEXT DEFAULT '',
    color TEXT DEFAULT '',
    cs_number TEXT DEFAULT '',
    transaction_type TEXT NOT NULL DEFAULT 'CASH',
    bank TEXT DEFAULT '',
    client TEXT DEFAULT '',
    grm TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT '',
    remarks TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT '',
    created_by TEXT DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT '',
    updated_by TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_rel_date ON releases(target_date);
CREATE INDEX IF NOT EXISTS idx_rel_branch ON releases(branch);
CREATE TABLE IF NOT EXISTS refs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    parent TEXT DEFAULT '',             -- unit -> its variant
    category TEXT DEFAULT '',           -- status: open/sold/cancelled; transaction: bank/''
    sort INTEGER DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_refs ON refs(kind, name COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    name TEXT DEFAULT '',
    role TEXT NOT NULL DEFAULT 'dealer',  -- admin | manager | dealer
    dealer TEXT DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    password_hash TEXT NOT NULL DEFAULT '',
    created_at TEXT DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users ON users(username COLLATE NOCASE);
"""


def log(msg: str) -> None:
    print(f"[storage] {msg}", file=sys.stderr, flush=True)


def col_letter(n: int) -> str:  # 1 -> A
    s = ""
    while n:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


# ---------------------------------------------------------------- sheet adapters
class GspreadAdapter:
    """Talks to a real Google Spreadsheet through gspread + a service account."""

    def __init__(self, sheet_id: str, creds: dict):
        import gspread  # imported lazily so local mode needs no dependencies
        self.gspread = gspread
        gc = gspread.service_account_from_dict(creds, scopes=["https://www.googleapis.com/auth/spreadsheets"])
        self.sh = gc.open_by_key(sheet_id)
        self._ws = {}

    def ws(self, tab):
        if tab not in self._ws:
            self._ws[tab] = self.sh.worksheet(tab)
        return self._ws[tab]

    def ensure_tab(self, tab: str, headers: list[str]) -> list[str]:
        try:
            ws = self.ws(tab)
        except self.gspread.exceptions.WorksheetNotFound:
            ws = self.sh.add_worksheet(tab, rows=1000, cols=len(headers))
            self._ws[tab] = ws
        current = [h.strip() for h in ws.row_values(1)]
        missing = [h for h in headers if h.upper() not in {c.upper() for c in current}]
        if missing:
            new = current + missing
            if ws.col_count < len(new):
                ws.resize(cols=len(new))
            ws.update([new], f"A1:{col_letter(len(new))}1", raw=True)
            ws.freeze(rows=1)
            current = new
        return current

    def read_tabs(self, tabs: list[str]) -> dict[str, list[list[str]]]:
        res = self.sh.values_batch_get([f"'{t}'" for t in tabs])
        out = {}
        for tab, vr in zip(tabs, res.get("valueRanges", [])):
            out[tab] = vr.get("values", [])
        return out

    def id_rows(self, tab: str, id_col: int) -> dict[int, int]:
        out = {}
        for i, v in enumerate(self.ws(tab).col_values(id_col)[1:], start=2):
            try:
                out[int(str(v).strip())] = i
            except ValueError:
                pass
        return out

    def update_rows(self, tab: str, rows: dict[int, list], width: int) -> None:
        if rows:
            last = col_letter(width)
            self.ws(tab).batch_update([{"range": f"A{r}:{last}{r}", "values": [v]} for r, v in rows.items()], raw=True)

    def update_cells(self, tab: str, col: int, cells: dict[int, object]) -> None:
        if cells:
            c = col_letter(col)
            self.ws(tab).batch_update([{"range": f"{c}{r}", "values": [[v]]} for r, v in cells.items()], raw=True)

    def append_rows(self, tab: str, rows: list[list]) -> None:
        if rows:
            self.ws(tab).append_rows(rows, value_input_option="RAW", insert_data_option="INSERT_ROWS", table_range="A1")

    def delete_rows(self, tab: str, rownums: list[int]) -> None:
        if rownums:
            sid = self.ws(tab).id
            reqs = [{"deleteDimension": {"range": {"sheetId": sid, "dimension": "ROWS", "startIndex": r - 1, "endIndex": r}}}
                    for r in sorted(set(rownums), reverse=True)]
            self.sh.batch_update({"requests": reqs})


class FakeSheetAdapter:
    """A spreadsheet simulated in a JSON file — same behaviour as GspreadAdapter, no Google needed."""

    def __init__(self, path: str):
        self.path = path
        self.tabs = {}
        self.mtime = None
        self.calls = 0
        self._sync()

    def _sync(self):
        """Pick up edits made to the JSON file by hand, like a person editing the real sheet."""
        if os.path.exists(self.path):
            m = os.path.getmtime(self.path)
            if m != self.mtime:
                self.tabs, self.mtime = json.load(open(self.path)), m

    def _save(self):
        self.calls += 1
        with open(self.path, "w") as f:
            json.dump(self.tabs, f)
        self.mtime = os.path.getmtime(self.path)

    def ensure_tab(self, tab, headers):
        self._sync()
        rows = self.tabs.setdefault(tab, [])
        current = rows[0] if rows else []
        missing = [h for h in headers if h.upper() not in {c.upper() for c in current}]
        if missing or not rows:
            current = current + missing
            if rows:
                rows[0] = current
            else:
                rows.append(current)
            self._save()
        return current

    def read_tabs(self, tabs):
        self._sync()
        return {t: [list(r) for r in self.tabs.get(t, [])] for t in tabs}

    def id_rows(self, tab, id_col):
        self._sync()
        out = {}
        for i, row in enumerate(self.tabs[tab][1:], start=2):
            try:
                out[int(str(row[id_col - 1]).strip())] = i
            except (ValueError, IndexError):
                pass
        return out

    def update_rows(self, tab, rows, width):
        for r, v in rows.items():
            row = self.tabs[tab][r - 1]
            row[:width] = v + row[len(v):width]
        self._save()

    def update_cells(self, tab, col, cells):
        for r, v in cells.items():
            row = self.tabs[tab][r - 1]
            row.extend([""] * (col - len(row)))
            row[col - 1] = v
        self._save()

    def append_rows(self, tab, rows):
        self.tabs[tab].extend([list(r) for r in rows])
        self._save()

    def delete_rows(self, tab, rownums):
        for r in sorted(set(rownums), reverse=True):
            del self.tabs[tab][r - 1]
        self._save()


# ---------------------------------------------------------------- sync
class SheetBackend:
    def __init__(self, adapter):
        self.a = adapter
        self.headers: dict[str, list[str]] = {}

    def ensure(self):
        for table, (tab, cols) in TABLES.items():
            self.headers[table] = self.a.ensure_tab(tab, [h for _, h in cols])

    def positions(self, table) -> dict[str, int]:
        """db column -> 1-based column position in the sheet (by header name)."""
        idx = {h.strip().upper(): i + 1 for i, h in enumerate(self.headers[table])}
        return {k: idx[h.upper()] for k, h in TABLES[table][1] if h.upper() in idx}

    def read_all(self) -> dict[str, list[tuple[int, dict]]]:
        raw = self.a.read_tabs([TABLES[t][0] for t in TABLES])
        out = {}
        for table, (tab, cols) in TABLES.items():
            rows = raw.get(tab, [])
            if rows:  # headers may have been re-ordered by a person: trust what's in row 1
                self.headers[table] = [str(h) for h in rows[0]]
            pos = self.positions(table)
            recs = []
            for rownum, row in enumerate(rows[1:], start=2):
                if not any(str(c).strip() for c in row):
                    continue
                rec = {}
                for key, p in pos.items():
                    v = row[p - 1] if p - 1 < len(row) else ""
                    rec[key] = str(v).strip() if v is not None else ""
                recs.append((rownum, rec))
            out[table] = recs
        return out

    def row_values(self, table, rec: dict) -> tuple[list, int]:
        pos = self.positions(table)
        width = max(pos.values())
        vals = [""] * width
        for key, p in pos.items():
            v = rec.get(key, "")
            vals[p - 1] = "" if v is None else v
        return vals, width

    def push(self, conn, pending) -> None:
        for table, (tab, _) in TABLES.items():
            dels = pending["del"].get(table, set())
            ups = pending["up"].get(table, set()) - dels
            if not ups and not dels:
                continue
            pos = self.positions(table)
            idmap = self.a.id_rows(tab, pos["id"])
            updates, appends, width = {}, [], 1
            if ups:
                ids = sorted(ups)
                q = f"SELECT * FROM {table} WHERE id IN ({','.join('?' * len(ids))})"
                for r in conn.execute(q, ids).fetchall():
                    vals, width = self.row_values(table, dict(r))
                    if r["id"] in idmap:
                        updates[idmap[r["id"]]] = vals
                    else:
                        appends.append(vals)
            self.a.update_rows(tab, updates, width)
            self.a.delete_rows(tab, [idmap[i] for i in dels if i in idmap])
            self.a.append_rows(tab, appends)


class Store:
    def __init__(self, db_path: str):
        self.db_path = db_path
        self.lock = threading.RLock()
        self.pending = None
        self.writes = 0
        self.stale = False
        self.backend = None
        self.mode = "local"
        self.row_hook = None   # optional fn(table, rec) to clean rows read from the sheet
        self.post_load = None  # optional fn(conn) run after the sheet is loaded
        self.conn = None
        sheet_id = os.environ.get("GOOGLE_SHEET_ID", "").strip()
        fake = os.environ.get("ARPEGGIO_FAKE_SHEET", "").strip()
        if fake:
            self.backend, self.mode = SheetBackend(FakeSheetAdapter(fake)), "fake-sheet"
        elif sheet_id:
            raw = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON", "").strip()
            path = os.environ.get("GOOGLE_SERVICE_ACCOUNT_FILE", "").strip()
            if not raw and path:
                raw = open(path).read()
            if not raw:
                raise SystemExit("GOOGLE_SHEET_ID is set but GOOGLE_SERVICE_ACCOUNT_JSON / _FILE is missing")
            self.backend, self.mode = SheetBackend(GspreadAdapter(sheet_id, json.loads(raw))), "google-sheets"

    # ---- connections
    def _new_conn(self, path: str) -> sqlite3.Connection:
        conn = sqlite3.connect(path, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.executescript(SCHEMA)
        # migrate older local databases
        have = {r[1] for r in conn.execute("PRAGMA table_info(releases)")}
        for col in ("created_by", "updated_by"):
            if col not in have:
                conn.execute(f"ALTER TABLE releases ADD COLUMN {col} TEXT DEFAULT ''")
        conn.commit()
        return conn

    def _build_from_sheet(self) -> sqlite3.Connection:
        data = self.backend.read_all()
        conn = self._new_conn(":memory:")
        for table, recs in data.items():
            tab, cols = TABLES[table]
            keys = [k for k, _ in cols]
            missing_ids = []
            for rec_rownum, rec in recs:
                if self.row_hook:
                    self.row_hook(table, rec)
                for k in INT_COLS & set(keys):
                    v = rec.get(k, "")
                    if k == "active":
                        rec[k] = 0 if str(v).strip().upper() in ("0", "FALSE", "NO", "N") else 1
                    else:
                        try:
                            rec[k] = int(float(v)) if str(v).strip() else None
                        except ValueError:
                            rec[k] = None
            # Rows keep their IDs; rows typed into the sheet without one (or copied with a
            # duplicate ID) get a new ID *after* every existing ID is in place, so a new
            # number can never collide with a row further down the sheet.
            seen, later = set(), []
            for rownum, rec in recs:
                if rec.get("id") is None or rec["id"] in seen:
                    later.append((rownum, rec))
                else:
                    seen.add(rec["id"])
            later_ids = {id(r) for _, r in later}
            ordered = [(n, r) for n, r in recs if id(r) not in later_ids] + later
            for rownum, rec in ordered:
                fresh = id(rec) in later_ids
                vals = [None if (k == "id" and fresh) else
                        (rec.get(k, "") if rec.get(k) is not None else ("" if k not in INT_COLS else None)) for k in keys]
                try:
                    cur = conn.execute(f"INSERT INTO {table} ({','.join(keys)}) VALUES ({','.join('?' * len(keys))})", vals)
                except sqlite3.IntegrityError as e:
                    log(f"skipping row {rownum} of '{tab}': {e}")
                    continue
                if fresh:
                    missing_ids.append((rownum, cur.lastrowid))
            if missing_ids:
                pos = self.backend.positions(table)
                self.backend.a.update_cells(tab, pos["id"], dict(missing_ids))
                log(f"assigned IDs to {len(missing_ids)} new row(s) in '{tab}'")
        if self.post_load:
            self.post_load(conn)
        conn.commit()
        return conn

    def open(self) -> None:
        if self.backend:
            self.backend.ensure()
            self.conn = self._build_from_sheet()
        else:
            self.conn = self._new_conn(self.db_path)

    def reload(self) -> bool:
        """Re-read the sheet. Skipped if a save happened while we were downloading."""
        if not self.backend:
            return False
        w = self.writes
        conn = self._build_from_sheet()
        with self.lock:
            if self.writes != w:
                return False
            self.conn, self.stale = conn, False
        return True

    def start_refresh(self, interval: float) -> None:
        if not self.backend or interval <= 0:
            return

        def loop():
            last = time.time()
            while True:
                time.sleep(1)
                if self.stale or time.time() - last >= interval:
                    last = time.time()
                    try:
                        self.reload()
                    except Exception as e:  # network hiccup: keep serving the current copy
                        log(f"refresh failed: {e!r}")

        threading.Thread(target=loop, daemon=True, name="sheet-refresh").start()

    # ---- transactions
    @contextmanager
    def tx(self):
        """Lock + transaction. Changes marked with touch()/removed() are written to the sheet
        before the local commit; any failure rolls the local copy back."""
        with self.lock:
            outer = self.pending is None
            if outer:
                self.pending = {"up": defaultdict(set), "del": defaultdict(set)}
            try:
                yield self.conn
                if outer:
                    if self.backend and (any(self.pending["up"].values()) or any(self.pending["del"].values())):
                        try:
                            self.backend.push(self.conn, self.pending)
                        except Exception:
                            self.stale = True  # sheet may be half-updated: re-sync soon
                            raise
                        self.writes += 1
                    self.conn.commit()
            except BaseException:
                if outer:
                    self.conn.rollback()
                raise
            finally:
                if outer:
                    self.pending = None

    def touch(self, table: str, ids) -> None:
        if self.pending is not None:
            self.pending["up"][table].update(i for i in ids if i is not None)

    def removed(self, table: str, ids) -> None:
        if self.pending is not None:
            self.pending["del"][table].update(ids)
