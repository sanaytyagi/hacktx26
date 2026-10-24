"""Environment and hardware preflight. Reports what is actually installed and available."""
import importlib.util
import os
import platform
import shutil
import sys

# Supported base models with license and approximate weight size (verified against the
# Hugging Face Hub on 2026-10-24). Sizes are refreshed from the Hub when online.
BASE_MODELS = {
    "prajjwal1/bert-tiny": {
        "license": "MIT", "params_m": 4.4, "size_bytes": 17_756_393,
        "lora_targets": ["query", "value"], "tier": "smoke", "arch": "bert",
        "note": "Tiny model for smoke tests only. Results do not indicate business-quality performance.",
    },
    "google/electra-small-discriminator": {
        "license": "Apache-2.0", "params_m": 13.5, "size_bytes": 54_245_363,
        "lora_targets": ["query", "value"], "tier": "laptop",
        "note": "Small, fast encoder suited to laptop fine-tuning of text classifiers.",
    },
    "distilbert-base-uncased": {
        "license": "Apache-2.0", "params_m": 66.4, "size_bytes": 267_954_768,
        "lora_targets": ["q_lin", "v_lin"], "tier": "standard",
        "note": "Larger and usually more accurate; slower on CPU.",
    },
}


def _has(mod):
    return importlib.util.find_spec(mod) is not None


def env_check():
    pkgs = {m: _has(m) for m in ["numpy", "sklearn", "pypdf", "torch", "transformers", "peft", "safetensors"]}
    info = {"python": sys.version.split()[0], "platform": platform.platform(), "packages": pkgs, "devices": {"cpu": True, "mps": False, "cuda": False}}
    if pkgs["torch"]:
        import torch
        info["torch_version"] = torch.__version__
        info["devices"]["mps"] = bool(getattr(torch.backends, "mps", None) and torch.backends.mps.is_available())
        info["devices"]["cuda"] = bool(torch.cuda.is_available())
        if info["devices"]["cuda"]:
            info["cuda_device"] = torch.cuda.get_device_name(0)
    if pkgs["transformers"]:
        import transformers
        info["transformers_version"] = transformers.__version__
    try:
        if hasattr(os, "sysconf"):
            info["ram_gb"] = round(os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES") / 1e9, 1)
    except (ValueError, OSError):
        pass
    info["cpu_count"] = os.cpu_count()
    return info


def _hf_cache_has(model_id):
    home = os.environ.get("HF_HOME")
    if not home:
        return False
    d = os.path.join(home, "hub", "models--" + model_id.replace("/", "--"))
    return os.path.isdir(d)


def preflight(p):
    model_id = p["base_model"]
    env = env_check()
    meta = dict(BASE_MODELS.get(model_id, {}))
    warnings, blockers = [], []
    if not meta:
        blockers.append(f"{model_id} is not in Relay's supported list for this build.")
    for pkg in ["torch", "transformers", "peft", "sklearn"]:
        if not env["packages"].get(pkg):
            blockers.append(f"Python package '{pkg}' is not installed. Run: npm run setup:python -- --train")
    cache = os.environ.get("HF_HOME") or os.getcwd()
    os.makedirs(cache, exist_ok=True)
    disk = shutil.disk_usage(cache)
    need = (meta.get("size_bytes") or 0) * 3
    if disk.free < need + 500_000_000:
        blockers.append(f"Not enough free disk space (need about {round((need + 5e8) / 1e9, 1)} GB).")
    requested = p.get("device", "auto")
    devices = env["devices"]
    device = requested
    if requested == "auto":
        device = "cuda" if devices.get("cuda") else "mps" if devices.get("mps") else "cpu"
    elif not devices.get(requested, False):
        blockers.append(f"Requested device '{requested}' is not available on this computer.")
    cached = _hf_cache_has(model_id)
    if not cached and meta:
        warnings.append(f"First run downloads {round(meta['size_bytes'] / 1e6, 1)} MB from huggingface.co ({meta['license']} license).")
    n_train = int(p.get("train_examples") or 0)
    epochs = int(p.get("epochs") or 3)
    # Rough throughput (examples/second) by device and model size, measured loosely on laptops.
    base_rate = {"cpu": 60.0, "mps": 180.0, "cuda": 600.0}.get(device, 60.0)
    rate = base_rate * (13.5 / max(meta.get("params_m", 13.5), 1)) ** 0.7
    est_sec = n_train * epochs / max(rate, 1) + 20
    return {
        "env": env, "device": device, "model": {"id": model_id, **meta, "cached": cached},
        "estimate_seconds": round(est_sec), "estimate_basis": f"~{round(rate)} examples/s on {device}; rough estimate",
        "warnings": warnings, "blockers": blockers,
    }
