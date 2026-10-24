"""Deterministic profiling of an authorized, already-filtered table (JSONL). Standard library only."""
import json
import re
from collections import Counter, defaultdict
from datetime import datetime

EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
PHONE = re.compile(r"(?:\+?\d{1,2}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b")
SSN = re.compile(r"\b\d{3}-\d{2}-\d{4}\b")
IPV4 = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")
CARD = re.compile(r"\b(?:\d[ -]?){13,19}\b")
SENSITIVE_NAMES = re.compile(r"(^|_)(name|email|e_mail|phone|mobile|address|ssn|dob|birth|salary|password|ip|card|account_number|customer_name|reporter)($|_)", re.I)
DATE_FORMATS = ["%Y-%m-%d", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%d %H:%M:%S", "%m/%d/%Y", "%Y-%m-%dT%H:%M:%S.%fZ"]


def _luhn(digits):
    s = [int(c) for c in digits if c.isdigit()]
    if len(s) < 13:
        return False
    total = 0
    for i, d in enumerate(reversed(s)):
        if i % 2:
            d *= 2
            if d > 9:
                d -= 9
        total += d
    return total % 10 == 0


def _parse_date(v):
    for f in DATE_FORMATS:
        try:
            return datetime.strptime(v, f)
        except ValueError:
            continue
    return None


def normalize_text(t):
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9 ]", " ", str(t).lower())).strip()


def load_rows(path):
    rows = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def profile_rows(rows, columns=None):
    columns = columns or (list(rows[0].keys()) if rows else [])
    n = len(rows)
    cols = {}
    for c in columns:
        vals = [r.get(c) for r in rows]
        present = [v for v in vals if v is not None and str(v).strip() != ""]
        strs = [str(v) for v in present]
        counter = Counter(strs)
        unique = len(counter)
        numeric = sum(1 for v in present if isinstance(v, (int, float)) or re.fullmatch(r"-?\d+(\.\d+)?", str(v)))
        dates = [d for d in (_parse_date(s) for s in strs[:2000]) if d] if strs else []
        avg_len = (sum(len(s) for s in strs) / len(strs)) if strs else 0
        kind = "empty"
        if present:
            if len(dates) >= 0.9 * min(len(strs), 2000):
                kind = "datetime"
            elif numeric >= 0.95 * len(present):
                kind = "numeric"
            elif unique <= max(50, 0.05 * len(present)) and avg_len < 60:
                kind = "categorical"
            elif unique >= 0.9 * len(present) and avg_len < 40:
                kind = "identifier"
            else:
                kind = "text"
        sample = strs[:3000]
        hits = Counter()
        for s in sample:
            if EMAIL.search(s):
                hits["email"] += 1
            if SSN.search(s):
                hits["ssn"] += 1
            if PHONE.search(s):
                hits["phone"] += 1
            if IPV4.search(s):
                hits["ip_address"] += 1
            m = CARD.search(s)
            if m and _luhn(m.group(0)):
                hits["payment_card"] += 1
        sensitive = sorted(k for k, v in hits.items() if v >= max(1, 0.02 * len(sample)))
        if SENSITIVE_NAMES.search(c) and kind != "categorical":
            sensitive.append("name_suggests_personal_data")
        info = {
            "name": c, "kind": kind, "missing": n - len(present), "missing_pct": round(100 * (n - len(present)) / n, 1) if n else 0,
            "unique": unique, "avg_length": round(avg_len, 1), "sensitive": sensitive,
            "top_values": [{"value": v[:80], "count": k} for v, k in counter.most_common(12)] if kind in ("categorical", "numeric") else [],
        }
        if kind == "datetime" and dates:
            info["range"] = [min(dates).isoformat(), max(dates).isoformat()]
        if kind == "text":
            info["examples"] = [s[:160] for s in strs[:3]]
        cols[c] = info

    exact_dups = n - len({json.dumps(r, sort_keys=True, default=str) for r in rows})
    text_cols = [c for c, i in cols.items() if i["kind"] == "text" and i["avg_length"] >= 20]
    label_cols = [c for c, i in cols.items() if i["kind"] == "categorical" and 2 <= i["unique"] <= 50 and not i["sensitive"]]
    group_cols = [c for c, i in cols.items() if i["kind"] in ("categorical", "identifier") and 2 <= i["unique"] < 0.8 * max(n, 1) and c not in label_cols]
    time_cols = [c for c, i in cols.items() if i["kind"] == "datetime"]

    text_stats = {}
    for t in text_cols:
        norm = Counter(normalize_text(r.get(t, "")) for r in rows if r.get(t))
        text_stats[t] = {"duplicate_texts": sum(v - 1 for v in norm.values() if v > 1)}

    label_stats = {}
    for lc in label_cols:
        labeled = [r for r in rows if r.get(lc) not in (None, "")]
        dist = Counter(str(r[lc]) for r in labeled)
        counts = sorted(dist.values())
        conflicts = {}
        for t in text_cols:
            by_text = defaultdict(set)
            for r in labeled:
                if r.get(t):
                    by_text[normalize_text(r[t])].add(str(r[lc]))
            conflicts[t] = sum(1 for s in by_text.values() if len(s) > 1)
        label_stats[lc] = {
            "labeled": len(labeled), "coverage_pct": round(100 * len(labeled) / n, 1) if n else 0,
            "classes": len(dist), "distribution": [{"label": k, "count": v} for k, v in dist.most_common()],
            "min_class": counts[0] if counts else 0, "max_class": counts[-1] if counts else 0,
            "imbalance_ratio": round(counts[-1] / max(counts[0], 1), 1) if counts else 0,
            "conflicting_duplicates": conflicts,
        }

    # Label quality signals: labels derived from another label, and labels copied verbatim in text.
    label_relations = {}
    for lc in label_cols:
        rel = {"derived_from": None, "in_text": {}}
        for other in label_cols:
            if other == lc:
                continue
            mapping = defaultdict(set)
            for r in rows:
                if r.get(lc) not in (None, "") and r.get(other) not in (None, ""):
                    mapping[str(r[other])].add(str(r[lc]))
            if mapping and all(len(v) == 1 for v in mapping.values()) and len(mapping) >= label_stats[lc]["classes"] and label_stats[other]["classes"] >= label_stats[lc]["classes"]:
                if label_stats[other]["classes"] > label_stats[lc]["classes"] or other < lc:
                    rel["derived_from"] = other
        for t in text_cols:
            hits = sum(1 for r in rows if r.get(lc) not in (None, "") and r.get(t) and str(r[lc]).lower() in str(r[t]).lower())
            labeled = label_stats[lc]["labeled"] or 1
            rel["in_text"][t] = round(hits / labeled, 3)
        label_relations[lc] = rel
    text_quality = {}
    for t in text_cols:
        vals = [normalize_text(r.get(t, "")) for r in rows if r.get(t)]
        text_quality[t] = {"unique_ratio": round(len(set(vals)) / max(len(vals), 1), 3), "avg_length": cols[t]["avg_length"]}

    return {
        "label_relations": label_relations, "text_quality": text_quality,
        "rows": n, "columns": list(cols.values()), "exact_duplicate_rows": exact_dups,
        "candidates": {"text_inputs": text_cols, "labels": label_cols, "groups": group_cols, "times": time_cols},
        "text_stats": text_stats, "label_stats": label_stats,
        "sensitive_columns": [c for c, i in cols.items() if i["sensitive"]],
        "limitations": [
            "Profiling covers only the rows and columns this collection exposes to you.",
            "Sensitive-field detection uses patterns and column names; it can miss or over-flag fields.",
        ],
    }


def profile_file(path, columns=None):
    return profile_rows(load_rows(path), columns)
