"""JSON-lines request loop on stdio. One request per line: {"id", "method", "params"}.

Responses: {"id", "ok": true, "result"} or {"id", "ok": false, "error": {"message", "code"}}.
Progress events for a request: {"id", "event": {...}}.
"""
import json
import sys
import traceback

from .errors import WorkerError


def _send(obj):
    sys.stdout.write(json.dumps(obj, default=str) + "\n")
    sys.stdout.flush()


def _handlers():
    from . import dataset, hardware, profile

    def infer_predict(p, emit):
        from . import infer
        return infer.predict(p, emit)

    def infer_generate(p, emit):
        from . import infer
        return infer.generate(p, emit)

    return {
        "ping": lambda p, emit: {"pong": True},
        "env_check": lambda p, emit: hardware.env_check(),
        "preflight": lambda p, emit: hardware.preflight(p),
        "profile": lambda p, emit: profile.profile_file(p["path"], p.get("columns")),
        "prepare_dataset": lambda p, emit: dataset.prepare(p),
        "predict": infer_predict,
        "generate": infer_generate,
    }


def main():
    handlers = _handlers()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            continue
        rid = req.get("id")
        method = req.get("method")

        def emit(event, _rid=rid):
            _send({"id": _rid, "event": event})

        try:
            handler = handlers.get(method)
            if handler is None:
                raise WorkerError(f"Unknown method {method}", "invalid")
            _send({"id": rid, "ok": True, "result": handler(req.get("params") or {}, emit)})
        except WorkerError as e:
            _send({"id": rid, "ok": False, "error": {"message": str(e), "code": e.code}})
        except ModuleNotFoundError as e:
            _send({"id": rid, "ok": False, "error": {
                "message": f"Missing Python package: {e.name}. Run: npm run setup:python -- --train",
                "code": "unavailable"}})
        except Exception as e:  # noqa: BLE001 - report every failure to the caller
            traceback.print_exc(file=sys.stderr)
            _send({"id": rid, "ok": False, "error": {"message": f"{type(e).__name__}: {e}", "code": "failed"}})


if __name__ == "__main__":
    main()
