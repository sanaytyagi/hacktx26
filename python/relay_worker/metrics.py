"""Classification metrics computed from predictions on the held-out test split."""


def classification_metrics(y_true, y_pred, labels):
    idx = {l: i for i, l in enumerate(labels)}
    matrix = [[0] * len(labels) for _ in labels]
    for t, p in zip(y_true, y_pred):
        if t in idx and p in idx:
            matrix[idx[t]][idx[p]] += 1
    per_class = []
    f1s = []
    for l in labels:
        i = idx[l]
        tp = matrix[i][i]
        fp = sum(matrix[r][i] for r in range(len(labels))) - tp
        fn = sum(matrix[i]) - tp
        prec = tp / (tp + fp) if tp + fp else 0.0
        rec = tp / (tp + fn) if tp + fn else 0.0
        f1 = 2 * prec * rec / (prec + rec) if prec + rec else 0.0
        support = sum(matrix[i])
        per_class.append({"label": l, "precision": round(prec, 4), "recall": round(rec, 4), "f1": round(f1, 4), "support": support})
        if support:
            f1s.append(f1)
    correct = sum(1 for t, p in zip(y_true, y_pred) if t == p)
    return {
        "examples": len(y_true),
        "accuracy": round(correct / len(y_true), 4) if y_true else 0.0,
        "macro_f1": round(sum(f1s) / len(f1s), 4) if f1s else 0.0,
        "per_class": per_class,
        "confusion_matrix": {"labels": labels, "matrix": matrix},
    }
