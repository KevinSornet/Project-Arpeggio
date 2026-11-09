#!/usr/bin/env python3
"""Fill arpeggio.db with ~13 months of realistic *fake* release data for demos.

Works with local storage and with Google Sheets (rows are written to the sheet in one go).
Uses whatever is on the Data references page (dealers, variants, units, colors,
transactions, statuses, banks), so it always matches your lists.

    python3 seed_demo.py           # adds demo data (refuses if the DB already has releases)
    python3 seed_demo.py --reset   # wipes releases first (reference lists are kept)
"""
import random
import sys
from datetime import date, timedelta

import server

VARIANT_WEIGHTS = {"TERRA": 24, "NAVARA": 18, "URVAN PREMIUM": 10, "URVAN STANDARD": 9, "PATROL": 10,
                   "KICKS": 9, "LIVINA": 8, "ALMERA": 8}  # anything else gets weight 1
TX_WEIGHTS = {"FINANCING": 45, "CASH": 28, "BANK PO": 15, "COMPANY PO": 8}
FIRST = ["JUAN", "MARIA", "JOSE", "ANA", "MARK", "GRACE", "PAULO", "ROSE", "JOHN", "LIZA", "CARLO", "NINA",
         "RAMON", "DIANA", "VICTOR", "ELLA", "BENJIE", "TESS", "ARNEL", "JOY", "KEVIN", "ABBY"]
LAST = ["DELA CRUZ", "SANTOS", "REYES", "BAUTISTA", "GONZALES", "AQUINO", "VILLANUEVA", "FLORES", "CASTRO",
        "MERCADO", "PASCUAL", "SALAZAR", "TORRES", "LOPEZ", "RIVERA", "MORALES", "DOMINGO", "ROXAS"]
COMPANIES = ["METRO LOGISTICS INC.", "SUNRISE REALTY CORP.", "PACIFIC TOURS INC.", "GREENFIELD FARMS CORP."]
SEASON = {1: 0.85, 2: 0.9, 3: 1.05, 4: 0.95, 5: 0.95, 6: 1.0, 7: 0.95, 8: 1.0, 9: 1.05, 10: 1.1, 11: 1.15, 12: 1.35}


def main():
    rnd = random.Random(42)
    server.init_db()
    with server.db() as conn:
        n = conn.execute("SELECT COUNT(*) FROM releases").fetchone()[0]
        if n and "--reset" not in sys.argv:
            sys.exit(f"Database already has {n} releases. Use --reset to wipe them and reseed.")
        old_ids = [r[0] for r in conn.execute("SELECT id FROM releases")]
        conn.execute("DELETE FROM releases")
        server.STORE.removed("releases", old_ids)

        lk = server.Lookups(conn)
        refs = lk.refs
        dealers = [r["name"] for r in refs["dealer"]]
        sizes = {d: rnd.uniform(0.5, 1.3) for d in dealers}
        grms = {d: [f"{rnd.choice(FIRST)} {rnd.choice(LAST)}" for _ in range(rnd.randint(2, 3))] for d in dealers}
        units = {}
        for u in refs["unit"]:
            units.setdefault(u["parent"], []).append(u["name"])
        variants = [v["name"] for v in refs["variant"] if units.get(v["name"])]
        v_weights = [VARIANT_WEIGHTS.get(v, 1) for v in variants]
        txs = [t["name"] for t in refs["transaction"]]
        t_weights = [TX_WEIGHTS.get(t, 5) for t in txs]
        colors = [c["name"] for c in refs["color"]]
        banks = [b["name"] for b in refs["bank"]][:8]
        statuses = refs["status"]
        sold = next(s["name"] for s in statuses if s["category"] == "sold")
        cancelled = next(s["name"] for s in statuses if s["category"] == "cancelled")
        open_ = [s["name"] for s in statuses if (s["category"] or "open") == "open"]  # pipeline order

        today = server.today()
        start = server.add_months(date(today.year, today.month, 1), -12)
        end = server.add_months(date(today.year, today.month, 1), 2)  # ~2 months of forward pipeline
        d, total = start, 0
        while d < end:
            growth = 1 + 0.02 * ((d.year - start.year) * 12 + d.month - start.month)
            for dealer in dealers:
                lam = 0.75 * sizes[dealer] * SEASON[d.month] * growth * (0.55 if d.weekday() == 6 else 1)
                k = sum(1 for _ in range(6) if rnd.random() < lam / 6)
                days_ahead = (d - today).days
                if days_ahead > 0:  # future: pipeline thins out the further we look
                    k = sum(1 for _ in range(k) if rnd.random() < max(0.15, 0.95 - days_ahead / 70))
                for _ in range(k):
                    variant = rnd.choices(variants, v_weights)[0]
                    tt = rnd.choices(txs, t_weights)[0]
                    is_bank = tt in lk.bank_tx
                    if d < today:
                        status = cancelled if rnd.random() < (0.14 if is_bank else 0.06) else sold
                    elif d == today:
                        status = rnd.choice([sold, open_[-1]])
                    else:
                        # later stages for nearer dates; bank deals start at "For Bank Approval"
                        progress = max(0.0, 1 - days_ahead / 45) + rnd.uniform(-0.25, 0.25)
                        stages = open_ if is_bank else [s for s in open_ if "bank" not in s.lower()] or open_
                        status = stages[min(len(stages) - 1, max(0, int(progress * len(stages))))]
                    client = (rnd.choice(COMPANIES) if tt.endswith("PO") and rnd.random() < 0.6
                              else f"{rnd.choice(FIRST)} {rnd.choice(LAST)}")
                    cs = (f"{rnd.choice('FGHKLMN')}{rnd.choice('ABCDLMR')}{rnd.randint(100, 999)}{rnd.choice('ABCDEF')}"
                          if status == sold or status == open_[-1] else "")
                    server.insert_release(conn, {
                        "branch": dealer, "target_date": d.isoformat(), "variant": variant,
                        "unit": rnd.choice(units[variant]), "color": rnd.choice(colors), "cs_number": cs,
                        "transaction_type": tt, "bank": rnd.choice(banks) if is_bank else "",
                        "client": client, "grm": rnd.choice(grms[dealer]), "status": status,
                        "remarks": "Client backed out" if status == cancelled and rnd.random() < 0.4 else "",
                    }, "demo")
                    total += 1
            d += timedelta(days=1)
    print(f"Seeded {total} demo releases across {len(dealers)} dealers (storage: {server.STORE.mode})")


if __name__ == "__main__":
    main()
