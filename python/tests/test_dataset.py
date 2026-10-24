import json
import os
import tempfile
import unittest

from relay_worker import dataset, metrics, profile


def write_rows(rows):
    d = tempfile.mkdtemp()
    p = os.path.join(d, "rows.jsonl")
    with open(p, "w") as f:
        f.write("\n".join(json.dumps(r) for r in rows))
    return d, p


def base_cfg(**split):
    return {"text_fields": ["text"], "label_field": "label", "label_map": {}, "drop_labels": [], "min_examples_per_label": 2,
            "split": {"strategy": "random", "train": 0.6, "validation": 0.2, "seed": 3, **split}}


class DatasetTests(unittest.TestCase):
    def rows(self):
        rows = []
        for i in range(60):
            label = ["a", "b", "c"][i % 3]
            rows.append({"text": f"ticket {i} about {label} topic", "label": label, "svc": f"s{i % 6}", "t": f"2025-01-{(i % 28) + 1:02d}"})
        # Exact and near-exact duplicates (case/punctuation) that must never straddle splits.
        rows += [{"text": "Ticket 1 about B topic!", "label": "b", "svc": "s1", "t": "2025-02-01"}] * 5
        # Conflicting duplicate labels are dropped entirely.
        rows += [{"text": "ambiguous text", "label": "a", "svc": "s2", "t": "2025-02-02"}, {"text": "ambiguous text", "label": "c", "svc": "s2", "t": "2025-02-03"}]
        return rows

    def test_dedupes_before_split_and_reports_no_leakage(self):
        d, p = write_rows(self.rows())
        stats = dataset.prepare({"input_path": p, "out_dir": d, "config": base_cfg()})
        self.assertEqual(stats["leakage"], {"text_overlap": 0, "group_overlap": 0})
        self.assertEqual(stats["removed"]["conflicting_duplicates_dropped"], 2)
        self.assertGreaterEqual(stats["removed"]["duplicates_merged"], 5)
        seen = {}
        for split in ("train", "validation", "test"):
            for line in open(os.path.join(d, f"{split}.jsonl")):
                key = profile.normalize_text(json.loads(line)["text"])
                self.assertNotIn(key, seen, "same text appears in two splits")
                seen[key] = split

    def test_group_split_keeps_groups_together(self):
        d, p = write_rows(self.rows())
        stats = dataset.prepare({"input_path": p, "out_dir": d, "config": base_cfg(strategy="group", group_field="svc")})
        self.assertEqual(stats["leakage"]["group_overlap"], 0)

    def test_time_split_tests_on_newest(self):
        d, p = write_rows(self.rows())
        dataset.prepare({"input_path": p, "out_dir": d, "config": base_cfg(strategy="time", time_field="t")})
        train_t = max(json.loads(l)["time"] for l in open(os.path.join(d, "train.jsonl")))
        test_t = min(json.loads(l)["time"] for l in open(os.path.join(d, "test.jsonl")))
        self.assertLessEqual(train_t, test_t)

    def test_label_map_and_drop(self):
        d, p = write_rows(self.rows())
        cfg = base_cfg()
        cfg["label_map"] = {"c": "merged"}
        cfg["drop_labels"] = ["b"]
        stats = dataset.prepare({"input_path": p, "out_dir": d, "config": cfg})
        self.assertEqual(stats["labels"], ["a", "merged"])
        self.assertGreater(stats["removed"]["dropped_label"], 0)

    def test_requires_two_labels(self):
        d, p = write_rows([{"text": f"x {i}", "label": "only"} for i in range(20)])
        with self.assertRaises(dataset.PrepError):
            dataset.prepare({"input_path": p, "out_dir": d, "config": base_cfg()})


class ProfileTests(unittest.TestCase):
    def test_detects_labels_sensitive_fields_and_derived_labels(self):
        rows = [{"desc": f"the service number {i} is failing badly today", "cat": ["db", "net"][i % 2], "team": ["data", "infra"][i % 2], "email": f"p{i}@x.example"} for i in range(80)]
        p = profile.profile_rows(rows)
        self.assertIn("desc", p["candidates"]["text_inputs"])
        self.assertIn("cat", p["candidates"]["labels"])
        self.assertIn("email", p["sensitive_columns"])
        derived = {k: v["derived_from"] for k, v in p["label_relations"].items()}
        self.assertTrue(derived.get("cat") == "team" or derived.get("team") == "cat")


class MetricsTests(unittest.TestCase):
    def test_macro_f1_and_confusion(self):
        m = metrics.classification_metrics(["a", "a", "b", "b"], ["a", "b", "b", "b"], ["a", "b"])
        self.assertEqual(m["confusion_matrix"]["matrix"], [[1, 1], [0, 2]])
        self.assertAlmostEqual(m["accuracy"], 0.75)
        self.assertAlmostEqual(m["macro_f1"], round((2 / 3 + 0.8) / 2, 4), places=3)


if __name__ == "__main__":
    unittest.main()
