"""Local inference: registered fine-tuned classifiers and an optional local general model."""
import json
import os
import time

from .errors import WorkerError

_classifiers = {}
_generators = {}

LOCAL_GENERAL_MODELS = {"Qwen/Qwen2.5-0.5B-Instruct": {"license": "Apache-2.0", "size_bytes": 988_097_824}}


def _device():
    import torch
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def _load_classifier(model_dir):
    if model_dir in _classifiers:
        return _classifiers[model_dir]
    if not os.path.isfile(os.path.join(model_dir, "relay.json")):
        raise WorkerError(f"No trained model found at {model_dir}.", "unavailable")
    from transformers import AutoModelForSequenceClassification, AutoTokenizer
    meta = json.load(open(os.path.join(model_dir, "relay.json")))
    device = _device()
    model = AutoModelForSequenceClassification.from_pretrained(model_dir).to(device).eval()
    tok = AutoTokenizer.from_pretrained(model_dir)
    _classifiers[model_dir] = (model, tok, meta, device)
    return _classifiers[model_dir]


def predict(p, emit=None):
    import torch
    model, tok, meta, device = _load_classifier(p["model_dir"])
    texts = [str(t)[:20000] for t in p["texts"]][:256]
    if not texts:
        raise WorkerError("No text to classify.", "invalid")
    t0 = time.perf_counter()
    with torch.no_grad():
        enc = tok(texts, truncation=True, max_length=int(meta.get("max_length", 128)), padding=True, return_tensors="pt").to(device)
        probs = torch.softmax(model(**enc).logits.float(), dim=-1).cpu()
    ms = (time.perf_counter() - t0) * 1000
    labels = meta["labels"]
    out = []
    for row in probs:
        scores = sorted(((labels[i], float(v)) for i, v in enumerate(row)), key=lambda x: -x[1])
        out.append({"label": scores[0][0], "confidence": round(scores[0][1], 4), "scores": [{"label": l, "p": round(v, 4)} for l, v in scores[:5]]})
    return {"predictions": out, "latency_ms": round(ms, 2), "device": device}


def generate(p, emit=None):
    model_id = p["model"]
    if model_id not in LOCAL_GENERAL_MODELS:
        raise WorkerError(f"{model_id} is not a supported local general model in this build.", "invalid")
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer
    if model_id not in _generators:
        device = _device()
        tok = AutoTokenizer.from_pretrained(model_id)
        model = AutoModelForCausalLM.from_pretrained(model_id, torch_dtype=torch.float32).to(device).eval()
        _generators[model_id] = (model, tok, device)
    model, tok, device = _generators[model_id]
    msgs = [{"role": "system", "content": p.get("system", "")}, {"role": "user", "content": p["prompt"]}]
    ids = tok.apply_chat_template(msgs, add_generation_prompt=True, return_tensors="pt").to(device)
    with torch.no_grad():
        out = model.generate(ids, max_new_tokens=int(p.get("max_new_tokens", 512)), do_sample=False)
    new = out[0][ids.shape[-1]:]
    return {"text": tok.decode(new, skip_special_tokens=True), "input_tokens": int(ids.shape[-1]), "output_tokens": int(new.shape[-1])}
