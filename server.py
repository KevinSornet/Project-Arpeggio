#!/usr/bin/env python3
"""Arpeggio — vehicle release pipeline tracker + dashboard.

  * serves the web app in ./public (login required)
  * stores releases, reference lists and users in a Google Sheet (online) or a local
    SQLite file (development) — see storage.py
  * exposes a small JSON API used by the Sales, Dashboard, Data references and Users pages

Run:  python3 server.py            (http://127.0.0.1:8000, local file storage)
      See DEPLOY.md for running online with Google Sheets.
"""
from __future__ import annotations

import argparse
import calendar
import csv
import io
import json
import math
import mimetypes
import os
import re
import secrets
import sys
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta, timezone
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, urlparse

import auth
import storage

ROOT = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.join(ROOT, "public")
DB_PATH = os.environ.get("ARPEGGIO_DB", os.path.join(ROOT, "arpeggio.db"))
STORE = storage.Store(DB_PATH)

try:
    from zoneinfo import ZoneInfo
    TZ = ZoneInfo(os.environ.get("ARPEGGIO_TZ", "Asia/Manila"))
except Exception:  # no tz database available: Philippine time is a fixed UTC+8
    TZ = timezone(timedelta(hours=8))

# ---------------------------------------------------------------- reference data
# Each kind of reference list, which releases column it feeds, and what its
# optional "category" means. Everything here is editable on the Data references page.
REF_KINDS = {
    "dealer":      {"field": "branch",           "label": "Dealers"},
    "variant":     {"field": "variant",          "label": "Variants"},
    "unit":        {"field": "unit",             "label": "Units"},          # parent = variant
    "color":       {"field": "color",            "label": "Colors"},
    "transaction": {"field": "transaction_type", "label": "Transactions"},   # category: bank | ''
    "status":      {"field": "status",           "label": "Statuses"},       # category: open | sold | cancelled
    "bank":        {"field": "bank",             "label": "Banks"},
}
STATUS_CATEGORIES = ("open", "sold", "cancelled")

DEFAULT_REFS = {
    "dealer": ["ALABANG", "LAS PINAS", "SUCAT", "DASMA", "SILANG", "CARMONA", "CALAMBA", "KAWIT"],
    "variant": ["NAVARA", "TERRA", "URVAN STANDARD", "URVAN PREMIUM", "ALMERA", "KICKS", "LIVINA",
                "PATROL", "NISSAN Z", "XTRAIL", "PRIMERA", "NAVARA PRO"],
    "unit": [
        ("ALMERA", "NISSAN ALMERA 1.0 VE TURBO CVT WITH NCS"), ("ALMERA", "NISSAN ALMERA 1.0 VL TURBO CVT WITH NCS"),
        ("KICKS", "NISSAN KICKS E-POWER VE"), ("KICKS", "NISSAN KICKS E-POWER VL"),
        ("LIVINA", "NISSAN LIVINA 1.5 VE AT"), ("LIVINA", "NISSAN LIVINA 1.5 VL AT"),
        ("NAVARA", "NAVARA 2.5 VE CALIBRE AT 4X2"), ("NAVARA", "NAVARA 2.5 CALIBRE-X AT 4X2"),
        ("NAVARA", "NAVARA 2.5 PRO-4X AT 4X4"), ("NAVARA", "NAVARA 2.5 VE CALIBRE MT 4X2"),
        ("NAVARA", "NAVARA 2.5 VE MT 4X4"),
        ("NISSAN Z", "NISSAN Z 3.0L PREMIUM COUPE AT"), ("NISSAN Z", "NISSAN Z 3.0L PREMIUM COUPE MT"),
        ("PATROL", "NISSAN PATROL 3.5-L V6 TT AT 4x4"),
        ("TERRA", "NISSAN TERRA 2.5 VE AT 4X2"), ("TERRA", "NISSAN TERRA 2.5 SPORT AT 4X2"),
        ("TERRA", "NISSAN TERRA 2.5 SPORT AT 4x4"), ("TERRA", "NISSAN TERRA 2.5 VL AT 4X2"),
        ("URVAN PREMIUM", "NISSAN URVAN 2.5 PREMIUM AT"), ("URVAN PREMIUM", "NISSAN URVAN 2.5 PREMIUM MT"),
        ("URVAN STANDARD", "NISSAN URVAN 2.5 GX VAN MT"), ("URVAN STANDARD", "NISSAN URVAN 2.5 STANDARD"),
        ("URVAN STANDARD", "NISSAN URVAN 2.5 STANDARD PLUS"), ("URVAN STANDARD", "NISSAN URVAN 2.5 CARGO MT"),
        ("XTRAIL", "NISSAN XTRAIL"), ("PRIMERA", "PRIMERA"), ("NAVARA PRO", "NAVARA PRO"),
    ],
    "color": [
        "ASPEN PEARL WHITE", "ALPINE WHITE", "PEARL WHITE", "DIAMOND PEARL WHITE", "EVEREST WHITE",
        "GALAXY BLACK", "GRANITE BLACK", "ONYX BLACK", "LUNAR METALLIC GRAY", "GUN METALLIC",
        "STEALTH PEARL GRAY", "MOONSTONE GRAY", "FIERY RED", "CAYENNE RED", "ROYAL RUBY RED",
        "NEBULA METALLIC RED", "BRILLIANT SILVER", "FORGED METALLIC COPPER", "GUN METALLIC WITH BLACK ROOF",
        "RIPTIDE BLUE", "IKAZUCHI YELLOW WITH BLACK ROOF", "CAYENNE RED WITH BLACK ROOF",
        "PREMIUM CORONA ORANGE", "SEIRAN BLUE WITH BLACK ROOF",
    ],
    "transaction": [("FINANCING", "bank"), ("BANK PO", "bank"), ("COMPANY PO", ""), ("CASH", "")],
    # pipeline order: earliest stage first
    "status": [("For Bank Approval", "open"), ("w/ Bank Approval / Bank PO", "open"), ("w/ Payment", "open"),
               ("For Release", "open"), ("Sold", "sold"), ("Cancelled", "cancelled")],
    "bank": ["BDO", "BPI", "RCBC", "PNB", "PSB", "EWB", "METROBANK", "SECURITY BANK", "CHINABANK", "UNIONBANK"],
}

FIELDS = ["branch", "target_date", "variant", "unit", "color", "cs_number", "transaction_type",
          "bank", "client", "grm", "status", "remarks"]

# ---------------------------------------------------------------- database
def db():
    """Shared, locked transaction on the store (writes go to the sheet before committing)."""
    return STORE.tx()


def seed_default_refs(conn) -> None:
    for kind, items in DEFAULT_REFS.items():
        for item in items:
            parent = category = ""
            if kind == "unit":
                parent, name = item
            elif isinstance(item, tuple):
                name, category = item
            else:
                name = item
            add_ref(conn, kind, name, parent, category)


def normalize_sheet_row(table: str, rec: dict) -> None:
    """Rows typed straight into the Google Sheet may use other date formats."""
    if table == "releases" and rec.get("target_date"):
        try:
            rec["target_date"] = parse_date(rec["target_date"])
        except BadRequest:
            pass


def canonicalize_releases(conn) -> None:
    """Match values typed straight into the sheet ('patrol', 'w/ payment') to the reference lists,
    so the app groups them correctly. Only the in-memory copy is adjusted; the sheet is left as typed."""
    lk = Lookups(conn)
    for r in conn.execute("SELECT * FROM releases").fetchall():
        fixed = {meta["field"]: lk.canonical(kind, r[meta["field"]]) for kind, meta in REF_KINDS.items() if kind != "status"}
        fixed["status"] = lk.status(r["status"])
        fixed["cs_number"] = (r["cs_number"] or "").upper()
        if any(fixed[k] != r[k] for k in fixed):
            conn.execute(f"UPDATE releases SET {', '.join(f'{k}=?' for k in fixed)} WHERE id=?", [*fixed.values(), r["id"]])


def init_db() -> None:
    STORE.row_hook = normalize_sheet_row
    STORE.post_load = canonicalize_releases
    STORE.open()
    with db() as conn:
        if not conn.execute("SELECT 1 FROM refs LIMIT 1").fetchone():
            seed_default_refs(conn)
        # migrate from the first version, which kept a separate branches table
        if conn.execute("SELECT 1 FROM sqlite_master WHERE name='branches'").fetchone():
            for (name,) in conn.execute("SELECT name FROM branches").fetchall():
                add_ref(conn, "dealer", name)
            conn.execute("DROP TABLE branches")
        if not conn.execute("SELECT 1 FROM users LIMIT 1").fetchone():
            username = os.environ.get("ARPEGGIO_ADMIN_USERNAME", "admin").strip() or "admin"
            pw = os.environ.get("ARPEGGIO_ADMIN_PASSWORD", "").strip()
            generated = not pw
            pw = pw or secrets.token_urlsafe(9)
            create_user(conn, {"username": username, "name": "Administrator", "role": "admin", "password": pw})
            print("\n" + "=" * 64 + f"\n  First admin account created\n    username: {username}\n"
                  + (f"    password: {pw}\n  Sign in and change this password under your name (top right).\n"
                     if generated else "    password: (from ARPEGGIO_ADMIN_PASSWORD)\n")
                  + "=" * 64 + "\n", file=sys.stderr, flush=True)


def now_iso() -> str:
    return datetime.now(TZ).replace(tzinfo=None).isoformat(timespec="seconds")


def today() -> date:
    override = os.environ.get("ARPEGGIO_TODAY")  # handy for demos/tests
    return date.fromisoformat(override) if override else datetime.now(TZ).date()


class BadRequest(Exception):
    pass


def load_refs(conn) -> dict[str, list[dict]]:
    out = {k: [] for k in REF_KINDS}
    for r in conn.execute("SELECT * FROM refs ORDER BY kind, sort, id"):
        if r["kind"] in out:
            out[r["kind"]].append(dict(r))
    return out


def add_ref(conn, kind: str, name: str, parent: str = "", category: str = "") -> int | None:
    name = name.strip()
    if not name:
        return None
    nxt = conn.execute("SELECT COALESCE(MAX(sort), -1) + 1 FROM refs WHERE kind=?", (kind,)).fetchone()[0]
    cur = conn.execute("INSERT OR IGNORE INTO refs(kind, name, parent, category, sort) VALUES (?,?,?,?,?)",
                       (kind, name, parent.strip(), category.strip(), nxt))
    if not cur.rowcount:
        return None
    STORE.touch("refs", [cur.lastrowid])
    return cur.lastrowid


class Lookups:
    """Canonicalises free-typed values against the reference lists."""

    def __init__(self, conn):
        self.refs = load_refs(conn)
        self.canon = {k: {self.key(r["name"]): r["name"] for r in v} for k, v in self.refs.items()}
        self.status_cat = {r["name"]: r["category"] or "open" for r in self.refs["status"]}
        self.bank_tx = {r["name"] for r in self.refs["transaction"] if r["category"] == "bank"}
        statuses = self.refs["status"]
        first = lambda cat: next((r["name"] for r in statuses if r["category"] == cat), None)
        self.first_sold, self.first_cancelled = first("sold"), first("cancelled")
        names = [r["name"] for r in statuses]
        self.default_status = "For Release" if "For Release" in names else (first("open") or "")

    @staticmethod
    def key(v: str) -> str:
        return re.sub(r"[\s_]+", " ", (v or "").strip()).lower()

    def canonical(self, kind: str, value: str) -> str:
        value = re.sub(r"\s+", " ", (value or "").strip())
        return self.canon[kind].get(self.key(value), value)

    def cat(self, status: str) -> str:
        return self.status_cat.get(status, "open")

    def status(self, value: str) -> str:
        v = self.key(value)
        if not v or v == "-":
            return self.default_status
        if v in ("released", "delivered") and self.first_sold:
            return self.first_sold
        if v in ("canceled", "cancel") and self.first_cancelled:
            return self.first_cancelled
        return self.canonical("status", value)


def parse_date(value: str) -> str:
    value = (value or "").strip()
    for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y", "%d-%b-%Y", "%b %d, %Y"):
        try:
            return datetime.strptime(value, fmt).date().isoformat()
        except ValueError:
            pass
    raise BadRequest(f"Unrecognised date: {value!r}")


def clean_record(data: dict, lk: Lookups) -> dict:
    rec = {k: str(data.get(k, "") or "").strip() for k in FIELDS}
    if not rec["branch"]:
        raise BadRequest("Dealer is required")
    if not rec["variant"]:
        raise BadRequest("Variant is required")
    rec["target_date"] = parse_date(rec["target_date"])
    for kind, meta in REF_KINDS.items():
        if kind != "status":
            rec[meta["field"]] = lk.canonical(kind, rec[meta["field"]])
    rec["status"] = lk.status(rec["status"])
    rec["transaction_type"] = rec["transaction_type"] or "CASH"
    if rec["transaction_type"] not in lk.bank_tx and rec["transaction_type"] in lk.canon["transaction"].values():
        rec["bank"] = ""
    rec["cs_number"] = rec["cs_number"].upper()
    return rec


def insert_release(conn, rec: dict, user: str = "") -> int:
    add_ref(conn, "dealer", rec["branch"])
    ts = now_iso()
    cur = conn.execute(
        f"INSERT INTO releases ({','.join(FIELDS)}, created_at, created_by, updated_at, updated_by) "
        f"VALUES ({','.join('?' * len(FIELDS))}, ?, ?, ?, ?)",
        [rec[k] for k in FIELDS] + [ts, user, ts, user],
    )
    STORE.touch("releases", [cur.lastrowid])
    return cur.lastrowid


def update_release(conn, rid: int, rec: dict, user: str = "") -> None:
    add_ref(conn, "dealer", rec["branch"])
    conn.execute(f"UPDATE releases SET {', '.join(f'{k}=?' for k in FIELDS)}, updated_at=?, updated_by=? WHERE id=?",
                 [rec[k] for k in FIELDS] + [now_iso(), user, rid])
    STORE.touch("releases", [rid])


# ---------------------------------------------------------------- users
PUBLIC_USER_FIELDS = ("id", "username", "name", "role", "dealer", "active", "created_at")


def public_user(u) -> dict:
    return {k: u[k] for k in PUBLIC_USER_FIELDS}


def create_user(conn, data: dict) -> int:
    username = str(data.get("username", "")).strip().lower()
    if not re.fullmatch(r"[a-z0-9._@-]{3,64}", username):
        raise BadRequest("Username: 3-64 characters, letters/numbers/._@- only")
    if conn.execute("SELECT 1 FROM users WHERE username=? COLLATE NOCASE", (username,)).fetchone():
        raise BadRequest(f"Username {username!r} is taken")
    role, dealer = check_role(conn, data)
    pw = str(data.get("password", ""))
    if (problem := auth.password_problem(pw)):
        raise BadRequest(problem)
    cur = conn.execute(
        "INSERT INTO users(username, name, role, dealer, active, password_hash, created_at) VALUES (?,?,?,?,1,?,?)",
        (username, str(data.get("name", "")).strip(), role, dealer, auth.hash_password(pw), now_iso()))
    STORE.touch("users", [cur.lastrowid])
    return cur.lastrowid


def check_role(conn, data: dict) -> tuple[str, str]:
    role = str(data.get("role", "dealer")).strip().lower()
    if role not in auth.ROLES:
        raise BadRequest("Role must be admin, manager or dealer")
    dealer = str(data.get("dealer", "")).strip()
    if role == "dealer":
        if dealer not in dealer_list(conn):
            raise BadRequest("Pick the dealer this person works for")
    else:
        dealer = ""
    return role, dealer


def active_admins(conn, exclude_id: int | None = None) -> int:
    return conn.execute("SELECT COUNT(*) FROM users WHERE role='admin' AND active=1 AND id<>?",
                        (exclude_id or -1,)).fetchone()[0]


# ---------------------------------------------------------------- queries
def dealer_list(conn) -> list[str]:
    refs = [r[0] for r in conn.execute("SELECT name FROM refs WHERE kind='dealer' ORDER BY sort, id")]
    extra = [r[0] for r in conn.execute("SELECT DISTINCT branch FROM releases ORDER BY 1") if r[0] not in refs]
    return refs + extra


def filtered_rows(conn, q: dict) -> list[dict]:
    sql, args = "SELECT * FROM releases WHERE 1=1", []
    branches = [b for b in q.get("branch", "").split(",") if b]
    if branches:
        sql += f" AND branch IN ({','.join('?' * len(branches))})"
        args += branches
    if q.get("from"):
        sql += " AND target_date >= ?"
        args.append(parse_date(q["from"]))
    if q.get("to"):
        sql += " AND target_date <= ?"
        args.append(parse_date(q["to"]))
    if q.get("status"):
        sql += " AND status = ?"
        args.append(q["status"])
    if q.get("q"):
        like = f"%{q['q']}%"
        sql += " AND (client LIKE ? OR cs_number LIKE ? OR unit LIKE ? OR grm LIKE ? OR variant LIKE ? OR remarks LIKE ?)"
        args += [like] * 6
    sql += " ORDER BY target_date, id"
    return [dict(r) for r in conn.execute(sql, args).fetchall()]


def month_key(d: date) -> str:
    return f"{d.year:04d}-{d.month:02d}"


def add_months(d: date, n: int) -> date:
    m = d.month - 1 + n
    return date(d.year + m // 12, m % 12 + 1, 1)


def holt_forecast(series: list[float], horizon: int, alpha=0.5, beta=0.3) -> tuple[list[float], float]:
    """Holt's linear exponential smoothing (damped). Returns (forecasts, residual std)."""
    if not series:
        return [0.0] * horizon, 0.0
    if len(series) < 3:
        avg = sum(series) / len(series)
        return [avg] * horizon, 0.0
    level, trend = series[0], series[1] - series[0]
    residuals = []
    for y in series[1:]:
        pred = level + trend
        residuals.append(y - pred)
        new_level = alpha * y + (1 - alpha) * (level + trend)
        trend = beta * (new_level - level) + (1 - beta) * trend
        level = new_level
    fc, damp, cum = [], 0.85, 0.0
    for h in range(1, horizon + 1):
        cum += damp ** h
        fc.append(max(0.0, level + cum * trend))
    sd = math.sqrt(sum(r * r for r in residuals) / len(residuals)) if residuals else 0.0
    return fc, sd


def compute_stats(conn, q: dict) -> dict:
    t = today()
    lk = Lookups(conn)
    branches = [b for b in q.get("branch", "").split(",") if b]
    scope = filtered_rows(conn, {"branch": q.get("branch", "")})  # all dates, dealer-filtered
    for r in scope:
        r["cat"] = lk.cat(r["status"])
    rng_from = parse_date(q["from"]) if q.get("from") else "0000-01-01"
    rng_to = parse_date(q["to"]) if q.get("to") else "9999-12-31"
    in_range = [r for r in scope if rng_from <= r["target_date"] <= rng_to]

    sold = [r for r in in_range if r["cat"] == "sold"]
    cancelled = [r for r in in_range if r["cat"] == "cancelled"]
    open_ = [r for r in in_range if r["cat"] == "open"]
    closed = len(sold) + len(cancelled)
    financed = lambda r: r["transaction_type"] in lk.bank_tx

    # --- close rate per transaction type (historical, all closed deals in scope)
    hist = Counter((r["transaction_type"], r["cat"]) for r in scope if r["cat"] != "open")
    total_sold = sum(v for (_, c), v in hist.items() if c == "sold")
    total_closed = sum(hist.values())
    overall_rate = total_sold / total_closed if total_closed else 0.85
    tx_names = [r["name"] for r in lk.refs["transaction"]]
    tx_names += sorted({tt for tt, _ in hist} - set(tx_names))
    close_rate = {}
    for tt in tx_names:
        s, c = hist[(tt, "sold")], hist[(tt, "cancelled")]
        # Bayesian shrink toward the overall rate so tiny samples don't swing wildly
        close_rate[tt] = (s + 5 * overall_rate) / (s + c + 5)

    def expected(rows):
        return sum(close_rate.get(r["transaction_type"], overall_rate) for r in rows)

    # --- monthly history (last 12 full months + current) and forecast
    cur_month = date(t.year, t.month, 1)
    months = [add_months(cur_month, -i) for i in range(12, -1, -1)]
    sold_by_month = Counter(r["target_date"][:7] for r in scope if r["cat"] == "sold")
    planned_by_month = Counter(r["target_date"][:7] for r in scope if r["cat"] != "cancelled")
    history = [{"month": month_key(m), "sold": sold_by_month[month_key(m)],
                "planned": planned_by_month[month_key(m)]} for m in months]

    complete = [h["sold"] for h in history[:-1]]
    while complete and complete[0] == 0:  # skip leading empty months (new dealer)
        complete.pop(0)
    trend_fc, sd = holt_forecast([float(x) for x in complete], 4)
    # Seasonality: with a full year of history, nudge each forecast month halfway toward
    # how that same month performed last year relative to the yearly average.
    if len(complete) >= 12:
        mean12 = sum(complete[-12:]) / 12 or 1
        for i in range(4):
            last_year = sold_by_month[month_key(add_months(cur_month, i - 12))]
            if last_year:
                trend_fc[i] *= 1 + 0.5 * (last_year / mean12 - 1)

    open_scope = [r for r in scope if r["cat"] == "open"]
    days_in_month = calendar.monthrange(t.year, t.month)[1]
    cur_key = month_key(cur_month)
    sold_mtd = sum(1 for r in scope if r["cat"] == "sold" and r["target_date"][:7] == cur_key
                   and r["target_date"] <= t.isoformat())
    open_cur = [r for r in open_scope if r["target_date"][:7] == cur_key]
    pipeline_cur = expected(open_cur) + sum(1 for r in scope if r["cat"] == "sold"
                                            and r["target_date"][:7] == cur_key
                                            and r["target_date"] > t.isoformat())
    pipeline_projection = sold_mtd + pipeline_cur
    # Blend: early in the month trust the trend more, later trust the pipeline more
    w = min(1.0, t.day / days_in_month + 0.35)
    cur_projection = w * pipeline_projection + (1 - w) * max(trend_fc[0], pipeline_projection)

    forecast = [{
        "month": cur_key, "value": round(cur_projection, 1),
        "low": round(max(sold_mtd, cur_projection - sd * (1 - w)), 1),
        "high": round(cur_projection + sd * (1 - w) + 0.5, 1),
        "pipeline": round(pipeline_projection, 1), "trend": round(trend_fc[0], 1),
    }]
    for i in range(1, 4):
        k = month_key(add_months(cur_month, i))
        pipe = expected([r for r in open_scope if r["target_date"][:7] == k])
        val = max(trend_fc[i], pipe)
        band = sd * math.sqrt(i)
        forecast.append({"month": k, "value": round(val, 1), "low": round(max(pipe, val - band), 1),
                         "high": round(val + band, 1), "pipeline": round(pipe, 1), "trend": round(trend_fc[i], 1)})

    # --- next month forecast split by variant (mix of last 3 months)
    mix_from = add_months(cur_month, -3).isoformat()
    mix = Counter(r["variant"] for r in scope if r["cat"] == "sold" and r["target_date"] >= mix_from)
    mix_total = sum(mix.values()) or 1
    nxt = forecast[1]
    nxt_open = Counter(r["variant"] for r in open_scope if r["target_date"][:7] == nxt["month"])
    variant_forecast = sorted(
        ({"variant": v, "share": round(c / mix_total, 3), "forecast": round(nxt["value"] * c / mix_total, 1),
          "booked": nxt_open.get(v, 0)} for v, c in mix.items()),
        key=lambda x: -x["forecast"])

    # --- breakdowns (range-filtered)
    def count(rows, key, top=None):
        return [{"label": k, "value": v} for k, v in Counter(r[key] or "—" for r in rows).most_common(top)]

    branch_table = []
    for b in sorted({r["branch"] for r in in_range}):
        rows = [r for r in in_range if r["branch"] == b]
        s = sum(1 for r in rows if r["cat"] == "sold")
        c = sum(1 for r in rows if r["cat"] == "cancelled")
        o = [r for r in rows if r["cat"] == "open"]
        branch_table.append({"branch": b, "sold": s, "cancelled": c, "open": len(o),
                             "expected": round(expected(o), 1),
                             "close_rate": round(s / (s + c), 3) if s + c else None,
                             "financing": round(sum(1 for r in rows if financed(r) and r["cat"] == "sold") / s, 3) if s else None})
    branch_table.sort(key=lambda x: -x["sold"])

    grm = defaultdict(lambda: {"sold": 0, "cancelled": 0, "open": 0, "branch": ""})
    for r in in_range:
        g = grm[r["grm"] or "—"]
        g["branch"] = r["branch"]
        g[r["cat"]] += 1
    grm_table = sorted(({"grm": k, **v} for k, v in grm.items()), key=lambda x: (-x["sold"], x["grm"]))[:12]

    # --- upcoming: next 14 days, plus weekly planned volume by open status for next 8 weeks
    horizon_end = (t + timedelta(days=14)).isoformat()
    upcoming = [r for r in open_scope if t.isoformat() <= r["target_date"] <= horizon_end]
    overdue = [r for r in open_scope if r["target_date"] < t.isoformat()]
    open_names = [r["name"] for r in lk.refs["status"] if (r["category"] or "open") == "open"]
    open_names += sorted({r["status"] for r in open_scope} - set(open_names))
    week0 = t - timedelta(days=t.weekday())
    weekly = []
    for i in range(8):
        ws = week0 + timedelta(weeks=i)
        we = ws + timedelta(days=6)
        c = Counter(r["status"] for r in open_scope if ws.isoformat() <= r["target_date"] <= we.isoformat())
        weekly.append({"week": ws.isoformat(), "counts": {n: c.get(n, 0) for n in open_names}})
    used_open = [n for n in open_names if any(w["counts"][n] for w in weekly)]

    status_names = [r["name"] for r in lk.refs["status"]]
    status_names += sorted({r["status"] for r in in_range} - set(status_names))
    return {
        "today": t.isoformat(),
        "branches": branches or dealer_list(conn),
        "range": {"from": q.get("from"), "to": q.get("to")},
        "kpi": {
            "entries": len(in_range), "sold": len(sold), "cancelled": len(cancelled), "open": len(open_),
            "expected_from_open": round(expected(open_), 1),
            "cancel_rate": round(len(cancelled) / closed, 3) if closed else None,
            "financing_share": round(sum(1 for r in sold if financed(r)) / len(sold), 3) if sold else None,
            "sold_mtd": sold_mtd, "projection": forecast[0], "overdue": len(overdue),
        },
        "close_rate": {k: round(v, 3) for k, v in close_rate.items()},
        "history": history,
        "forecast": forecast,
        "variant_forecast": variant_forecast,
        "by_branch": count(sold, "branch"),
        "by_variant": count(sold, "variant"),
        "by_transaction": count(sold, "transaction_type"),
        "by_bank": count([r for r in sold if financed(r)], "bank", 8),
        "by_color": count(sold, "color", 8),
        "status_counts": {s: sum(1 for r in in_range if r["status"] == s) for s in status_names},
        "branch_table": branch_table,
        "grm_table": grm_table,
        "weekly_pipeline": weekly,
        "weekly_statuses": used_open,
        "upcoming": upcoming[:40],
        "overdue": overdue[:40],
    }


# ---------------------------------------------------------------- CSV
CSV_HEADERS = ["BRANCH", "TARGET RELEASE DATE", "VARIANT", "UNIT", "COLOR", "CS NUMBER",
               "TRANSACTION", "BANK", "CLIENT", "GRM", "STATUS", "REMARKS"]


def to_csv(rows: list[dict]) -> str:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(CSV_HEADERS)
    for r in rows:
        d = date.fromisoformat(r["target_date"])
        w.writerow([r["branch"], f"{d.month}/{d.day}/{d.year}", r["variant"], r["unit"], r["color"],
                    r["cs_number"], r["transaction_type"], r["bank"], r["client"], r["grm"],
                    r["status"], r["remarks"]])
    return buf.getvalue()


def import_csv(conn, text: str, default_branch: str = "", force_branch: str | None = None, user: str = "") -> dict:
    lk = Lookups(conn)
    lines = text.splitlines()
    # find the header row (sheet exports often have a title row above it)
    start = next((i for i, ln in enumerate(lines) if "VARIANT" in ln.upper() and "STATUS" in ln.upper()), 0)
    reader = csv.DictReader(lines[start:])
    alias = {
        "branch": "branch", "dealer": "branch", "target release date": "target_date", "target date": "target_date",
        "release date": "target_date", "date": "target_date", "variant": "variant", "unit": "unit",
        "color": "color", "colour": "color", "cs number": "cs_number", "cs no": "cs_number",
        "transaction": "transaction_type", "transaction type": "transaction_type", "bank": "bank",
        "client": "client", "grm": "grm", "status": "status", "remarks": "remarks",
    }
    added, errors = 0, []
    for n, raw in enumerate(reader, start=start + 2):
        rec = {}
        for k, v in raw.items():
            key = alias.get(re.sub(r"\s+", " ", (k or "").strip().lower()))
            if key:
                rec[key] = v
        if not any((v or "").strip() for v in rec.values()):
            continue
        if not (rec.get("branch") or "").strip():
            rec["branch"] = default_branch
        try:
            if force_branch is not None:
                if lk.key(rec["branch"]) != lk.key(force_branch):
                    raise BadRequest(f"belongs to {rec['branch']!r}; you can only import {force_branch} rows")
                rec["branch"] = force_branch
            insert_release(conn, clean_record(rec, lk), user)
            added += 1
        except BadRequest as e:
            errors.append(f"Row {n}: {e}")
    return {"added": added, "errors": errors[:20], "error_count": len(errors)}


# ---------------------------------------------------------------- reference API
def refs_payload(conn) -> dict:
    refs = load_refs(conn)
    for kind, items in refs.items():
        field = REF_KINDS[kind]["field"]
        usage = dict(conn.execute(f"SELECT {field}, COUNT(*) FROM releases GROUP BY {field}").fetchall())
        for it in items:
            it["usage"] = usage.get(it["name"], 0)
    return {"kinds": {k: v["label"] for k, v in REF_KINDS.items()}, "refs": refs,
            "status_categories": STATUS_CATEGORIES}


def update_ref(conn, rid: int, data: dict) -> None:
    row = conn.execute("SELECT * FROM refs WHERE id=?", (rid,)).fetchone()
    if not row:
        raise BadRequest("Reference not found")
    kind, old = row["kind"], row["name"]
    name = str(data.get("name", old)).strip() or old
    parent = str(data.get("parent", row["parent"]) or "").strip()
    category = str(data.get("category", row["category"]) or "").strip()
    if kind == "status" and category not in STATUS_CATEGORIES:
        raise BadRequest("Status category must be open, sold or cancelled")
    clash = conn.execute("SELECT id FROM refs WHERE kind=? AND name=? COLLATE NOCASE AND id<>?",
                         (kind, name, rid)).fetchone()
    if clash:
        raise BadRequest(f"{name!r} already exists")
    conn.execute("UPDATE refs SET name=?, parent=?, category=?, sort=COALESCE(?, sort) WHERE id=?",
                 (name, parent, category, data.get("sort"), rid))
    STORE.touch("refs", [rid])
    if name != old:  # renames flow through to existing releases so stats stay together
        field = REF_KINDS[kind]["field"]
        ids = [r[0] for r in conn.execute(f"SELECT id FROM releases WHERE {field}=?", (old,))]
        conn.execute(f"UPDATE releases SET {field}=? WHERE {field}=?", (name, old))
        STORE.touch("releases", ids)
        if kind == "variant":
            ids = [r[0] for r in conn.execute("SELECT id FROM refs WHERE kind='unit' AND parent=?", (old,))]
            conn.execute("UPDATE refs SET parent=? WHERE kind='unit' AND parent=?", (name, old))
            STORE.touch("refs", ids)
        if kind == "dealer":
            ids = [r[0] for r in conn.execute("SELECT id FROM users WHERE dealer=?", (old,))]
            conn.execute("UPDATE users SET dealer=? WHERE dealer=?", (name, old))
            STORE.touch("users", ids)


def delete_ref(conn, rid: int) -> None:
    row = conn.execute("SELECT * FROM refs WHERE id=?", (rid,)).fetchone()
    if row:
        ids = [rid]
        if row["kind"] == "variant":
            ids += [r[0] for r in conn.execute("SELECT id FROM refs WHERE kind='unit' AND parent=?", (row["name"],))]
        conn.execute(f"DELETE FROM refs WHERE id IN ({','.join('?' * len(ids))})", ids)
        STORE.removed("refs", ids)


# ---------------------------------------------------------------- HTTP
PUBLIC_PATHS = {"/login", "/login.html", "/styles.css", "/common.js", "/login.js", "/favicon.ico"}
ADMIN_PAGES = {"/references", "/references.html", "/users", "/users.html"}


class Forbidden(Exception):
    pass


class Handler(BaseHTTPRequestHandler):
    server_version = "Arpeggio/2.0"
    user = None  # the signed-in user (sqlite Row) for this request

    def log_message(self, fmt, *args):
        if not self.path.startswith("/api/stats"):
            super().log_message(fmt, *args)

    # ---- helpers
    def client_ip(self) -> str:
        fwd = self.headers.get("X-Forwarded-For", "")
        return fwd.split(",")[0].strip() if fwd else self.client_address[0]

    def is_https(self) -> bool:
        return self.headers.get("X-Forwarded-Proto", "").lower() == "https"

    _buffering = False
    _pending = None

    def send_json(self, obj, status=200, cookie: str | None = None):
        if self._buffering:
            self._pending = ("json", (obj, status, cookie))
            return
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if cookie is not None:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(body)

    def redirect(self, location: str):
        self.send_response(302)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def session_cookie(self, token: str, max_age: int) -> str:
        c = f"{auth.SESSION_COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age}"
        return c + ("; Secure" if self.is_https() else "")

    def read_body(self) -> bytes:
        n = int(self.headers.get("Content-Length") or 0)
        if n > 10 * 1024 * 1024:
            raise BadRequest("Upload too large")
        return self.rfile.read(n) if n else b""

    def read_json(self) -> dict:
        try:
            data = json.loads(self.read_body() or b"{}")
        except json.JSONDecodeError:
            raise BadRequest("Invalid JSON")
        if not isinstance(data, dict):
            raise BadRequest("Invalid JSON")
        return data

    def load_user(self, conn):
        cookie = SimpleCookie(self.headers.get("Cookie", ""))
        morsel = cookie.get(auth.SESSION_COOKIE)
        parsed = auth.read_token(morsel.value) if morsel else None
        if not parsed:
            return None
        uid, ver = parsed
        u = conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        return u if u and auth.token_matches(dict(u), ver) else None

    # ---- role helpers
    def require(self, *roles):
        if self.user["role"] not in roles:
            raise Forbidden("You don't have permission for that")

    def my_branch(self, requested: str = "") -> str:
        """Dealer staff are pinned to their own dealer; others may pick any (or all)."""
        if self.user["role"] == "dealer":
            if not self.user["dealer"]:
                raise Forbidden("Your account isn't linked to a dealer yet; ask an admin")
            return self.user["dealer"]
        return requested

    def can_touch(self, row) -> None:
        if self.user["role"] == "dealer" and row["branch"] != self.my_branch():
            raise Forbidden("That release belongs to another dealer")

    # ---- routing
    def route(self, method: str):
        url = urlparse(self.path)
        q = {k: v[-1] for k, v in parse_qs(url.query).items()}
        path = url.path.rstrip("/") or "/"
        try:
            if method != "GET":  # basic CSRF guard on top of SameSite cookies
                origin = self.headers.get("Origin")
                if origin and urlparse(origin).netloc != self.headers.get("Host"):
                    raise Forbidden("Cross-site request blocked")
            with db() as conn:
                self.user = self.load_user(conn)
            if path.startswith("/api/"):
                return self.api(method, path, q)
            if method != "GET":
                return self.send_error(HTTPStatus.METHOD_NOT_ALLOWED)
            return self.static(path)
        except BadRequest as e:
            self.send_json({"error": str(e)}, 400)
        except Forbidden as e:
            self.send_json({"error": str(e)}, 403)
        except Exception as e:  # pragma: no cover
            self.log_error("Unhandled: %r", e)
            msg = "Couldn't save to Google Sheets — please try again" if STORE.backend else "Server error"
            self.send_json({"error": msg}, 502 if STORE.backend else 500)

    def do_GET(self):
        self.route("GET")

    def do_POST(self):
        self.route("POST")

    def do_PUT(self):
        self.route("PUT")

    def do_DELETE(self):
        self.route("DELETE")

    def static(self, path: str):
        if path == "/":
            path = "/index.html"
        if path not in PUBLIC_PATHS:
            if not self.user:
                return self.redirect("/login?next=" + quote(self.path, safe=""))
            if path in ADMIN_PAGES and self.user["role"] != "admin":
                return self.redirect("/sales")
        elif path in ("/login", "/login.html") and self.user:
            return self.redirect("/")
        if "." not in os.path.basename(path):
            path += ".html"
        full = os.path.normpath(os.path.join(PUBLIC, path.lstrip("/")))
        if not full.startswith(PUBLIC) or not os.path.isfile(full):
            return self.send_error(HTTPStatus.NOT_FOUND)
        with open(full, "rb") as f:
            body = f.read()
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", ctype + ("; charset=utf-8" if ctype.startswith("text") or ctype.endswith("javascript") else ""))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Frame-Options", "SAMEORIGIN")
        self.end_headers()
        self.wfile.write(body)

    def api(self, method: str, path: str, q: dict):
        # ---- sign in / out (no session needed)
        if path == "/api/login" and method == "POST":
            data = self.read_json()
            ip = self.client_ip()
            if auth.throttle.blocked(ip):
                return self.send_json({"error": "Too many failed attempts. Try again in 15 minutes."}, 429)
            with db() as conn:
                u = conn.execute("SELECT * FROM users WHERE username=? COLLATE NOCASE",
                                 (str(data.get("username", "")).strip(),)).fetchone()
            if not u or not u["active"] or not auth.verify_password(str(data.get("password", "")), u["password_hash"]):
                auth.throttle.fail(ip)
                return self.send_json({"error": "Wrong username or password"}, 401)
            auth.throttle.clear(ip)
            return self.send_json({"ok": True, "user": public_user(u)},
                                  cookie=self.session_cookie(auth.make_token(dict(u)), auth.SESSION_DAYS * 86400))
        if path == "/api/logout" and method == "POST":
            return self.send_json({"ok": True}, cookie=self.session_cookie("", 0))
        if not self.user:
            return self.send_json({"error": "Please sign in"}, 401)

        # Responses are held until the transaction (and its Google Sheets write) succeeds,
        # so the browser never sees "saved" for a change the sheet rejected.
        self._buffering, self._pending = True, None
        try:
            with db() as conn:
                self.api_authed(conn, method, path, q)
        finally:
            self._buffering = False
        if self._pending is None:
            return self.send_json({"error": "Not found"}, 404)
        kind, payload = self._pending
        if kind == "csv":
            self.send_response(200)
            self.send_header("Content-Type", "text/csv; charset=utf-8")
            self.send_header("Content-Disposition", f'attachment; filename="release-pipeline-{today().isoformat()}.csv"')
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            return self.wfile.write(payload)
        return self.send_json(*payload)

    def api_authed(self, conn, method: str, path: str, q: dict):
        user = self.user
        uname = user["username"]
        if True:
            # ---- me
            if path == "/api/me" and method == "GET":
                return self.send_json({**public_user(user), "roles": auth.ROLES, "storage": STORE.mode})
            if path == "/api/me/password" and method == "POST":
                data = self.read_json()
                if not auth.verify_password(str(data.get("current", "")), user["password_hash"]):
                    raise BadRequest("Current password is wrong")
                new = str(data.get("new", ""))
                if (problem := auth.password_problem(new)):
                    raise BadRequest(problem)
                h = auth.hash_password(new)
                conn.execute("UPDATE users SET password_hash=? WHERE id=?", (h, user["id"]))
                STORE.touch("users", [user["id"]])
                fresh = {**dict(user), "password_hash": h}
                return self.send_json({"ok": True}, cookie=self.session_cookie(auth.make_token(fresh), auth.SESSION_DAYS * 86400))

            # ---- lookups for forms
            if path == "/api/meta" and method == "GET":
                lk = Lookups(conn)
                mine = self.my_branch() if user["role"] == "dealer" else None
                grms = defaultdict(set)
                for r in conn.execute("SELECT branch, grm FROM releases WHERE grm <> ''"):
                    if mine is None or r["branch"] == mine:
                        grms[r["branch"]].add(r["grm"])
                catalog = {v["name"]: [] for v in lk.refs["variant"]}
                for u in lk.refs["unit"]:
                    catalog.setdefault(u["parent"], []).append(u["name"])
                return self.send_json({
                    "branches": [mine] if mine is not None else dealer_list(conn),
                    "statuses": [{"name": r["name"], "category": r["category"] or "open"} for r in lk.refs["status"]],
                    "transactions": [{"name": r["name"], "category": r["category"]} for r in lk.refs["transaction"]],
                    "banks": [r["name"] for r in lk.refs["bank"]],
                    "colors": [r["name"] for r in lk.refs["color"]],
                    "catalog": catalog, "default_status": lk.default_status,
                    "grms": {k: sorted(v) for k, v in grms.items()}, "today": today().isoformat(),
                })

            # ---- reference lists (admin)
            if path.startswith("/api/refs"):
                self.require("admin")
                if path == "/api/refs" and method == "GET":
                    return self.send_json(refs_payload(conn))
                if path == "/api/refs" and method == "POST":
                    data = self.read_json()
                    kind = data.get("kind")
                    if kind not in REF_KINDS:
                        raise BadRequest("Unknown reference type")
                    category = str(data.get("category") or ("open" if kind == "status" else ""))
                    names = [n for n in re.split(r"[\r\n]+", str(data.get("name", ""))) if n.strip()]
                    if not names:
                        raise BadRequest("Name is required")
                    if kind == "unit" and not str(data.get("parent", "")).strip():
                        raise BadRequest("Pick the variant this unit belongs to")
                    added = sum(1 for n in names if add_ref(conn, kind, n, str(data.get("parent", "")), category))
                    return self.send_json({"added": added, "skipped": len(names) - added, **refs_payload(conn)})
                if path == "/api/refs/reorder" and method == "POST":
                    ids = [int(i) for i in self.read_json().get("ids", [])]
                    for i, rid in enumerate(ids):
                        conn.execute("UPDATE refs SET sort=? WHERE id=?", (i, rid))
                    STORE.touch("refs", ids)
                    return self.send_json(refs_payload(conn))
                m = re.fullmatch(r"/api/refs/(\d+)", path)
                if m and method == "PUT":
                    update_ref(conn, int(m.group(1)), self.read_json())
                    return self.send_json(refs_payload(conn))
                if m and method == "DELETE":
                    delete_ref(conn, int(m.group(1)))
                    return self.send_json(refs_payload(conn))

            # ---- user accounts (admin)
            if path.startswith("/api/users"):
                self.require("admin")
                if path == "/api/users" and method == "GET":
                    return self.send_json({"users": [public_user(u) for u in conn.execute("SELECT * FROM users ORDER BY role, username")],
                                           "roles": auth.ROLES, "dealers": dealer_list(conn)})
                if path == "/api/users" and method == "POST":
                    uid = create_user(conn, self.read_json())
                    return self.send_json(public_user(conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()), 201)
                m = re.fullmatch(r"/api/users/(\d+)", path)
                if m:
                    uid = int(m.group(1))
                    target = conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
                    if not target:
                        return self.send_json({"error": "Not found"}, 404)
                    if method == "PUT":
                        data = self.read_json()
                        merged = {**dict(target), **{k: v for k, v in data.items() if k in ("name", "role", "dealer", "active")}}
                        role, dealer = check_role(conn, merged)
                        active = 1 if merged.get("active") in (1, True, "1", "true") else 0
                        if target["role"] == "admin" and (role != "admin" or not active) and not active_admins(conn, uid):
                            raise BadRequest("Keep at least one active admin")
                        h = target["password_hash"]
                        if data.get("password"):
                            if (problem := auth.password_problem(str(data["password"]))):
                                raise BadRequest(problem)
                            h = auth.hash_password(str(data["password"]))
                        conn.execute("UPDATE users SET name=?, role=?, dealer=?, active=?, password_hash=? WHERE id=?",
                                     (str(merged.get("name") or "").strip(), role, dealer, active, h, uid))
                        STORE.touch("users", [uid])
                        return self.send_json(public_user(conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()))
                    if method == "DELETE":
                        if uid == user["id"]:
                            raise BadRequest("You can't delete your own account")
                        if target["role"] == "admin" and not active_admins(conn, uid):
                            raise BadRequest("Keep at least one active admin")
                        conn.execute("DELETE FROM users WHERE id=?", (uid,))
                        STORE.removed("users", [uid])
                        return self.send_json({"ok": True})

            # ---- releases
            if path == "/api/releases" and method == "GET":
                return self.send_json(filtered_rows(conn, {**q, "branch": self.my_branch(q.get("branch", ""))}))
            if path == "/api/releases" and method == "POST":
                data = self.read_json()
                data["branch"] = self.my_branch(data.get("branch", ""))
                rid = insert_release(conn, clean_record(data, Lookups(conn)), uname)
                return self.send_json(dict(conn.execute("SELECT * FROM releases WHERE id=?", (rid,)).fetchone()), 201)
            m = re.fullmatch(r"/api/releases/(\d+)", path)
            if m:
                rid = int(m.group(1))
                existing = conn.execute("SELECT * FROM releases WHERE id=?", (rid,)).fetchone()
                if not existing:
                    return self.send_json({"error": "Not found"}, 404)
                self.can_touch(existing)
                if method == "PUT":
                    merged = {**dict(existing), **self.read_json()}
                    merged["branch"] = self.my_branch(merged.get("branch", ""))
                    update_release(conn, rid, clean_record(merged, Lookups(conn)), uname)
                    return self.send_json(dict(conn.execute("SELECT * FROM releases WHERE id=?", (rid,)).fetchone()))
                if method == "DELETE":
                    conn.execute("DELETE FROM releases WHERE id=?", (rid,))
                    STORE.removed("releases", [rid])
                    return self.send_json({"ok": True})
            if path == "/api/stats" and method == "GET":
                return self.send_json(compute_stats(conn, {**q, "branch": self.my_branch(q.get("branch", ""))}))
            if path == "/api/export.csv" and method == "GET":
                body = to_csv(filtered_rows(conn, {**q, "branch": self.my_branch(q.get("branch", ""))})).encode()
                self._pending = ("csv", body)
                return
            if path == "/api/import" and method == "POST":
                text = self.read_body().decode("utf-8-sig", errors="replace")
                force = self.my_branch() if user["role"] == "dealer" else None
                return self.send_json(import_csv(conn, text, q.get("branch", ""), force, uname))


def main():
    ap = argparse.ArgumentParser(description="Arpeggio release pipeline server")
    ap.add_argument("--host", default=os.environ.get("HOST", "127.0.0.1"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8000)))
    args = ap.parse_args()
    init_db()
    STORE.start_refresh(float(os.environ.get("ARPEGGIO_REFRESH_SECONDS", 60)))
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    where = {"local": f"local file {DB_PATH}", "google-sheets": "Google Sheets",
             "fake-sheet": f"simulated sheet {os.environ.get('ARPEGGIO_FAKE_SHEET')}"}[STORE.mode]
    print(f"Arpeggio running on http://{args.host}:{args.port}  (storage: {where})", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
