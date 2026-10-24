"""Fine-tune a small open-weight encoder for text classification with LoRA (PEFT).

Run as: python -m relay_worker.train --job job.json
Writes JSON events to stdout. Exits non-zero on failure; the caller marks the job failed.
Every reported number is measured in this process; nothing is estimated or simulated.
"""
import argparse
import json
import math
import os
import random
import sys
import time

from .hardware import BASE_MODELS
from .metrics import classification_metrics


def emit(**event):
    sys.stdout.write(json.dumps(event, default=str) + "\n")
    sys.stdout.flush()


def read_jsonl(path):
    with open(path, encoding="utf-8") as f:
        return [json.loads(l) for l in f if l.strip()]


def load_tokenizer(model_id):
    from transformers import AutoTokenizer, BertTokenizerFast
    try:
        return AutoTokenizer.from_pretrained(model_id)
    except (ValueError, OSError):
        # Some checkpoints (e.g. prajjwal1/bert-tiny) ship only vocab.txt.
        from huggingface_hub import hf_hub_download
        return BertTokenizerFast(vocab_file=hf_hub_download(model_id, "vocab.txt"), do_lower_case=True)


def pick_device(requested):
    import torch
    if requested == "cuda" or (requested == "auto" and torch.cuda.is_available()):
        return "cuda"
    if requested == "mps" or (requested == "auto" and torch.backends.mps.is_available()):
        return "mps"
    return "cpu"


def baselines(train, test, labels):
    """Majority class and TF-IDF + logistic regression, trained on the same train split."""
    from collections import Counter
    majority = Counter(e["label"] for e in train).most_common(1)[0][0]
    y_true = [e["label"] for e in test]
    out = {"majority": {**classification_metrics(y_true, [majority] * len(test), labels), "description": f"Always predicts “{majority}”"}}
    try:
        from sklearn.feature_extraction.text import TfidfVectorizer
        from sklearn.linear_model import LogisticRegression
        vec = TfidfVectorizer(ngram_range=(1, 2), min_df=1, max_features=30000, sublinear_tf=True)
        x_train = vec.fit_transform([e["text"] for e in train])
        clf = LogisticRegression(max_iter=2000, class_weight="balanced")
        clf.fit(x_train, [e["label"] for e in train])
        t0 = time.perf_counter()
        pred = list(clf.predict(vec.transform([e["text"] for e in test])))
        ms = (time.perf_counter() - t0) * 1000 / max(len(test), 1)
        out["tfidf_logreg"] = {**classification_metrics(y_true, pred, labels), "latency_ms_per_example": round(ms, 3), "description": "TF-IDF + logistic regression"}
    except ImportError:
        out["tfidf_logreg"] = None
    return out


def predict_texts(model, tok, texts, device, max_length, batch_size=32):
    import torch
    model.eval()
    preds, probs = [], []
    with torch.no_grad():
        for i in range(0, len(texts), batch_size):
            enc = tok(texts[i:i + batch_size], truncation=True, max_length=max_length, padding=True, return_tensors="pt").to(device)
            logits = model(**enc).logits.float()
            p = torch.softmax(logits, dim=-1)
            preds.extend(p.argmax(-1).tolist())
            probs.extend(p.max(-1).values.tolist())
    return preds, probs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--job", required=True)
    job = json.load(open(ap.parse_args().job))
    started = time.time()
    try:
        import torch
        from peft import LoraConfig, TaskType, get_peft_model
        from transformers import AutoModelForSequenceClassification, get_linear_schedule_with_warmup
    except ImportError as e:
        emit(type="error", message=f"Missing package {e.name}. Run: npm run setup:python -- --train")
        sys.exit(2)

    seed = int(job.get("seed", 13))
    random.seed(seed)
    torch.manual_seed(seed)
    cfg = job["config"]
    ddir, out_dir = job["dataset_dir"], job["out_dir"]
    os.makedirs(out_dir, exist_ok=True)
    labels = json.load(open(os.path.join(ddir, "labels.json")))
    l2i = {l: i for i, l in enumerate(labels)}
    train = read_jsonl(os.path.join(ddir, "train.jsonl"))
    val = read_jsonl(os.path.join(ddir, "validation.jsonl"))
    test = read_jsonl(os.path.join(ddir, "test.jsonl"))
    smoke = bool(cfg.get("smokeTest"))
    if smoke:
        rng = random.Random(seed)
        rng.shuffle(train)
        train = train[:64]
    elif cfg.get("maxTrainExamples"):
        train = train[: int(cfg["maxTrainExamples"])]
    if not train or not test:
        emit(type="error", message="Training and test splits must both contain examples.")
        sys.exit(3)

    device = pick_device(cfg.get("device", "auto"))
    base = cfg["baseModel"]
    meta = BASE_MODELS.get(base, {})
    emit(type="phase", phase="baseline", message="Training baselines on the train split")
    base_metrics = baselines(train, test, labels)
    emit(type="baseline", metrics=base_metrics)

    emit(type="phase", phase="loading", message=f"Loading {base} (downloads on first use) on {device}")
    tok = load_tokenizer(base)
    model_cls = AutoModelForSequenceClassification
    if meta.get("arch") == "bert":
        # Checkpoint config lacks model_type; load through the explicit architecture class.
        from transformers import BertForSequenceClassification as model_cls
    model = model_cls.from_pretrained(
        base, num_labels=len(labels), id2label={i: l for i, l in enumerate(labels)}, label2id=l2i)
    if tok.pad_token is None:
        tok.pad_token = tok.unk_token
    rank = int(cfg.get("loraRank", 8))
    lora = LoraConfig(task_type=TaskType.SEQ_CLS, r=rank, lora_alpha=rank * 2, lora_dropout=0.1,
                      target_modules=meta.get("lora_targets") or ["query", "value"])
    model = get_peft_model(model, lora)
    trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
    total = sum(p.numel() for p in model.parameters())
    emit(type="log", message=f"LoRA rank {rank}: training {trainable:,} of {total:,} parameters ({100 * trainable / total:.2f}%) on {device}")
    model.to(device)

    epochs = 1 if smoke else int(cfg.get("epochs", 3))
    bs = int(cfg.get("batchSize", 16))
    max_len = int(cfg.get("maxLength", 128))
    steps_per_epoch = math.ceil(len(train) / bs)
    total_steps = steps_per_epoch * epochs
    opt = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=float(cfg.get("learningRate", 5e-4)), weight_decay=0.01)
    sched = get_linear_schedule_with_warmup(opt, int(0.06 * total_steps), total_steps)

    emit(type="phase", phase="training", message=f"{len(train)} training examples, {epochs} epoch(s), {total_steps} steps")
    step = 0
    best = (-1.0, None, 0)
    for epoch in range(1, epochs + 1):
        model.train()
        order = list(range(len(train)))
        random.Random(seed + epoch).shuffle(order)
        running = 0.0
        for b in range(steps_per_epoch):
            batch = [train[i] for i in order[b * bs:(b + 1) * bs]]
            enc = tok([e["text"] for e in batch], truncation=True, max_length=max_len, padding=True, return_tensors="pt").to(device)
            y = torch.tensor([l2i[e["label"]] for e in batch], device=device)
            out = model(**enc, labels=y)
            out.loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step()
            sched.step()
            opt.zero_grad()
            step += 1
            running += out.loss.item()
            if step % max(1, total_steps // 60) == 0 or step == total_steps:
                emit(type="progress", step=step, total_steps=total_steps, epoch=epoch, loss=round(out.loss.item(), 5),
                     lr=sched.get_last_lr()[0], elapsed_sec=round(time.time() - started, 1))
        if val:
            preds, _ = predict_texts(model, tok, [e["text"] for e in val], device, max_len)
            vm = classification_metrics([e["label"] for e in val], [labels[p] for p in preds], labels)
            emit(type="eval", split="validation", epoch=epoch, train_loss=round(running / steps_per_epoch, 5), accuracy=vm["accuracy"], macro_f1=vm["macro_f1"])
            if vm["macro_f1"] > best[0]:
                best = (vm["macro_f1"], {k: v.detach().cpu().clone() for k, v in model.state_dict().items() if "lora_" in k or "classifier" in k or "modules_to_save" in k}, epoch)
    if best[1] is not None and best[2] != epochs:
        model.load_state_dict(best[1], strict=False)
        emit(type="log", message=f"Restored weights from epoch {best[2]} (best validation macro F1 {best[0]:.4f})")

    emit(type="phase", phase="evaluating", message=f"Evaluating on {len(test)} held-out test examples")
    texts = [e["text"] for e in test]
    t0 = time.perf_counter()
    preds, probs = predict_texts(model, tok, texts, device, max_len)
    batch_ms = (time.perf_counter() - t0) * 1000 / len(texts)
    single = []
    model.eval()
    with torch.no_grad():
        for t in texts[:30]:
            s0 = time.perf_counter()
            enc = tok([t], truncation=True, max_length=max_len, return_tensors="pt").to(device)
            model(**enc)
            single.append((time.perf_counter() - s0) * 1000)
    single.sort()
    ft = classification_metrics([e["label"] for e in test], [labels[p] for p in preds], labels)
    ft["latency_ms_per_example_batched"] = round(batch_ms, 3)
    ft["latency_ms_single_p50"] = round(single[len(single) // 2], 3) if single else None
    ft["device"] = device

    emit(type="phase", phase="saving", message="Saving adapter and merged model")
    model.save_pretrained(os.path.join(out_dir, "adapter"))
    merged = model.merge_and_unload()
    model_dir = os.path.join(out_dir, "model")
    merged.save_pretrained(model_dir, safe_serialization=True)
    tok.save_pretrained(model_dir)
    json.dump({"labels": labels, "base_model": base, "max_length": max_len}, open(os.path.join(model_dir, "relay.json"), "w"))

    # Prove the saved artifact reloads and reproduces predictions.
    from transformers import AutoModelForSequenceClassification as Auto, AutoTokenizer
    reloaded = Auto.from_pretrained(model_dir).to(device)
    rtok = AutoTokenizer.from_pretrained(model_dir)
    sample = texts[:50]
    rpreds, _ = predict_texts(reloaded, rtok, sample, device, max_len)
    matched = sum(1 for a, b in zip(rpreds, preds[:len(sample)]) if a == b)

    result = {
        "type": "result", "labels": labels, "artifact_dir": out_dir, "model_dir": model_dir,
        "fine_tuned": ft, "baselines": base_metrics, "smoke_test": smoke,
        "train_examples": len(train), "validation_examples": len(val), "test_examples": len(test),
        "epochs": epochs, "best_epoch": best[2] or epochs, "trainable_params": trainable, "total_params": total,
        "reload_check": {"matched": matched, "of": len(sample)}, "elapsed_sec": round(time.time() - started, 1),
        "base_model": {"id": base, "license": meta.get("license"), "size_bytes": meta.get("size_bytes")},
    }
    json.dump(result, open(os.path.join(out_dir, "metrics.json"), "w"), indent=1)
    emit(**result)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001
        import traceback
        traceback.print_exc(file=sys.stderr)
        emit(type="error", message=f"{type(e).__name__}: {e}")
        sys.exit(1)
