"""Dataset preparation: mapping, label editing, deduplication before splitting, leakage-safe splits."""
import json
import os
import random
from collections import Counter, defaultdict

from .errors import WorkerError
from .profile import load_rows, normalize_text


class PrepError(WorkerError):
    def __init__(self, message):
        super().__init__(message, "invalid")


def _text(row, fields):
    parts = []
    for f in fields:
        v = row.get(f)
        if v is not None and str(v).strip():
            parts.append(f"{f}: {v}" if len(fields) > 1 else str(v))
    return "\n".join(parts).strip()


def build_examples(rows, cfg):
    label_map = cfg.get("label_map") or {}
    drop = set(cfg.get("drop_labels") or [])
    removed = Counter()
    examples = []
    for i, r in enumerate(rows):
        text = _text(r, cfg["text_fields"])
        raw = r.get(cfg["label_field"])
        if not text:
            removed["empty_text"] += 1
            continue
        if raw is None or str(raw).strip() == "":
            removed["missing_label"] += 1
            continue
        label = str(label_map.get(str(raw), raw)).strip()
        if not label or label in drop:
            removed["dropped_label"] += 1
            continue
        ex = {"id": i, "text": text, "label": label}
        if cfg["split"].get("group_field"):
            ex["group"] = str(r.get(cfg["split"]["group_field"], ""))
        if cfg["split"].get("time_field"):
            ex["time"] = str(r.get(cfg["split"]["time_field"], ""))
        examples.append(ex)
    return examples, removed


def deduplicate(examples):
    """Merge exact (normalized) duplicates before splitting so no text appears in two splits.
    Duplicates with conflicting labels are dropped entirely and reported."""
    by_text = defaultdict(list)
    for e in examples:
        by_text[normalize_text(e["text"])].append(e)
    kept, merged, conflicting = [], 0, 0
    for _, group in by_text.items():
        labels = {e["label"] for e in group}
        if len(labels) > 1:
            conflicting += len(group)
            continue
        kept.append(group[0])
        merged += len(group) - 1
    kept.sort(key=lambda e: e["id"])
    return kept, merged, conflicting


def split(examples, scfg):
    rng = random.Random(scfg.get("seed", 13))
    tr, va = scfg.get("train", 0.7), scfg.get("validation", 0.15)
    strategy = scfg.get("strategy", "random")
    out = {"train": [], "validation": [], "test": []}
    if strategy == "time":
        if not scfg.get("time_field"):
            raise PrepError("Choose a time field for a time-based split.")
        ordered = sorted(examples, key=lambda e: e.get("time", ""))
        n = len(ordered)
        a, b = int(n * tr), int(n * (tr + va))
        out["train"], out["validation"], out["test"] = ordered[:a], ordered[a:b], ordered[b:]
    elif strategy == "group":
        if not scfg.get("group_field"):
            raise PrepError("Choose a group field for a group-based split.")
        groups = defaultdict(list)
        for e in examples:
            groups[e.get("group", "")].append(e)
        keys = sorted(groups)
        rng.shuffle(keys)
        n = len(examples)
        count = 0
        for k in keys:
            target = "train" if count < n * tr else "validation" if count < n * (tr + va) else "test"
            out[target].extend(groups[k])
            count += len(groups[k])
    else:
        by_label = defaultdict(list)
        for e in examples:
            by_label[e["label"]].append(e)
        for label in sorted(by_label):
            items = by_label[label]
            rng.shuffle(items)
            n = len(items)
            n_test = max(1, round(n * (1 - tr - va))) if n >= 3 else 0
            n_val = max(1, round(n * va)) if n >= 3 else 0
            out["test"].extend(items[:n_test])
            out["validation"].extend(items[n_test:n_test + n_val])
            out["train"].extend(items[n_test + n_val:])
    for k in out:
        out[k].sort(key=lambda e: e["id"])
    return out


def leakage(splits):
    seen = {k: {normalize_text(e["text"]) for e in v} for k, v in splits.items()}
    groups = {k: {e.get("group") for e in v if e.get("group") is not None} for k, v in splits.items()}
    return {
        "text_overlap": len(seen["train"] & seen["test"]) + len(seen["train"] & seen["validation"]) + len(seen["validation"] & seen["test"]),
        "group_overlap": len(groups["train"] & groups["test"]) + len(groups["train"] & groups["validation"]) + len(groups["validation"] & groups["test"]),
    }


def prepare(p):
    cfg = p["config"]
    rows = load_rows(p["input_path"])
    if not rows:
        raise PrepError("The collection returned no rows.")
    examples, removed = build_examples(rows, cfg)
    examples, merged, conflicting = deduplicate(examples)
    counts = Counter(e["label"] for e in examples)
    min_n = int(cfg.get("min_examples_per_label", 5))
    rare = sorted(l for l, c in counts.items() if c < min_n)
    examples = [e for e in examples if e["label"] not in rare]
    labels = sorted({e["label"] for e in examples})
    if len(labels) < 2:
        raise PrepError("At least two labels with enough examples are needed to train a classifier.")
    splits = split(examples, cfg["split"])
    leak = leakage(splits)
    os.makedirs(p["out_dir"], exist_ok=True)
    for name, items in splits.items():
        with open(os.path.join(p["out_dir"], f"{name}.jsonl"), "w", encoding="utf-8") as f:
            for e in items:
                f.write(json.dumps(e) + "\n")
    with open(os.path.join(p["out_dir"], "labels.json"), "w") as f:
        json.dump(labels, f)
    warnings = []
    for name in ("validation", "test"):
        missing = [l for l in labels if not any(e["label"] == l for e in splits[name])]
        if missing:
            warnings.append(f"{name.title()} split has no examples of: {', '.join(missing)}.")
    if leak["text_overlap"] or leak["group_overlap"]:
        warnings.append("Leakage detected between splits.")
    stats = {
        "source_rows": len(rows), "examples": len(examples), "labels": labels,
        "splits": {k: len(v) for k, v in splits.items()},
        "per_label": {l: {k: sum(1 for e in v if e["label"] == l) for k, v in splits.items()} for l in labels},
        "removed": {**dict(removed), "duplicates_merged": merged, "conflicting_duplicates_dropped": conflicting, "rare_labels_dropped": rare},
        "leakage": leak, "warnings": warnings, "strategy": cfg["split"].get("strategy", "random"),
    }
    with open(os.path.join(p["out_dir"], "stats.json"), "w") as f:
        json.dump(stats, f, indent=1)
    return stats
