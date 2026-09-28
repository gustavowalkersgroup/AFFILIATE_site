#!/usr/bin/env python3
"""Validate a Meta Ads JSON export for scope, metrics, and demographic QA."""
import csv
import json
import sys
from collections import defaultdict
from pathlib import Path

REQUIRED = {"campaign_id", "adset_id", "ad_id", "date_start", "date_stop"}
METRIC_ALIASES = {"inline_link_clicks": "Link clicks", "clicks": "Clicks (all)"}


def load(path):
    if path.suffix.lower() == ".csv":
        with path.open(newline="", encoding="utf-8-sig") as f:
            return list(csv.DictReader(f))
    data = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(data, dict):
        for key in ("insights", "data", "result"):
            if isinstance(data.get(key), list):
                return data[key]
            if isinstance(data.get(key), dict) and isinstance(data[key].get("insights"), list):
                return data[key]["insights"]
    return data if isinstance(data, list) else []


def num(row, key):
    try:
        return float(row.get(key, 0) or 0)
    except (TypeError, ValueError):
        return 0.0


def main():
    if len(sys.argv) != 2:
        print("Usage: validate_campaign_export.py EXPORT.json|EXPORT.csv", file=sys.stderr)
        return 2
    rows = load(Path(sys.argv[1]))
    if not rows:
        print("ERROR: no rows found")
        return 1
    fields = set().union(*(r.keys() for r in rows))
    missing = sorted(REQUIRED - fields)
    print(f"rows={len(rows)}")
    print("missing_scope_fields=" + (",".join(missing) if missing else "none"))
    print("metric_labels=" + ", ".join(METRIC_ALIASES.values()))
    groups = defaultdict(lambda: defaultdict(float))
    for row in rows:
        gender = str(row.get("gender", "unknown") or "unknown").lower()
        groups[gender]["Link clicks"] += num(row, "inline_link_clicks")
        groups[gender]["Clicks (all)"] += num(row, "clicks")
        groups[gender]["Impressions"] += num(row, "impressions")
        groups[gender]["Amount spent"] += num(row, "spend")
    known_link = sum(v["Link clicks"] for k, v in groups.items() if k != "unknown")
    for gender, values in sorted(groups.items()):
        share = (values["Link clicks"] / known_link * 100) if known_link and gender != "unknown" else None
        suffix = f" share_known_link_clicks={share:.2f}%" if share is not None else ""
        print(f"gender={gender} impressions={values['Impressions']:.2f} Link clicks={values['Link clicks']:.2f} Clicks (all)={values['Clicks (all)']:.2f} Amount spent={values['Amount spent']:.2f}{suffix}")
    if "gender" not in fields:
        print("WARNING: gender breakdown is absent; do not infer demographic delivery.")
    if missing:
        print("WARNING: object scope is incomplete; verify IDs before analysis.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
