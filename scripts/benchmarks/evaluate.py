#!/usr/bin/env python3
"""Versioned adapter from the pinned CooperBench dataset to official test_solo."""
from __future__ import annotations
import hashlib, json, pathlib, subprocess, sys, tempfile, types

sys.dont_write_bytecode = True

EXPECTED_UPSTREAM = "63b9d44d9f39a02fccf5bf0052db48a917a011fd"
SCHEMA = "agent-hub.cooperbench-run/v1"

def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()

def git(root: pathlib.Path, *args: str) -> str:
    p = subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True)
    if p.returncode:
        raise RuntimeError("cannot verify pinned CooperBench checkout")
    return p.stdout.strip()

def tree_digest(root: pathlib.Path) -> str:
    files: dict[str, str] = {}
    for path in sorted(root.rglob("*")):
        if path.is_file() and ".git" not in path.relative_to(root).parts:
            files[path.relative_to(root).as_posix()] = digest(path.read_bytes())
    return digest(json.dumps(files, sort_keys=True, separators=(",", ":")).encode())

def main() -> int:
    if len(sys.argv) != 7:
        raise SystemExit("usage: evaluate.py UPSTREAM_ROOT SOURCE_SHA256 CASE_JSON MODE PATCH|- OUTPUT_JSON")
    upstream_root = pathlib.Path(sys.argv[1]).resolve()
    source_sha256 = sys.argv[2]
    case_path = pathlib.Path(sys.argv[3]).resolve()
    mode = sys.argv[4]
    patch_arg = sys.argv[5]
    output = pathlib.Path(sys.argv[6]).resolve()
    case_bytes = case_path.read_bytes()
    case = json.loads(case_bytes)
    manifest_path = pathlib.Path(__file__).with_name("manifest-v1.json")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("schema") != SCHEMA or manifest.get("upstream", {}).get("commit") != EXPECTED_UPSTREAM:
        raise RuntimeError("unsupported benchmark manifest")
    if git(upstream_root, "rev-parse", "HEAD") != EXPECTED_UPSTREAM:
        raise RuntimeError("upstream checkout commit mismatch")
    if tree_digest(upstream_root) != source_sha256:
        raise RuntimeError("upstream source/data tree changed after preparation")
    repo = case.get("repo")
    task = case.get("task")
    features = case.get("features")
    if not isinstance(repo, str) or not isinstance(task, int) or not isinstance(features, list) or len(features) != 2:
        raise RuntimeError("case JSON does not identify one pinned feature pair")
    case_match = next((c for c in manifest["cases"] if c["repo"] == repo and c["task"] == task and c["features"] == features), None)
    if case_match is None:
        raise RuntimeError("case identity is not present in the versioned manifest")
    if case.get("image") != case_match.get("image"):
        raise RuntimeError("case image tag differs from the versioned manifest")
    if mode not in {"scored", "base", "oracle"}:
        raise RuntimeError("unsupported evaluation mode")
    dataset = upstream_root / "dataset"
    task_root = dataset / repo / f"task{task}"
    if mode == "scored":
        patch_path = pathlib.Path(patch_arg).resolve()
        patch_bytes = patch_path.read_bytes()
        input_sha = digest(patch_bytes)
    elif mode == "oracle":
        patch_path = task_root / "combined.patch"
        patch_bytes = patch_path.read_bytes()
        input_sha = digest(patch_bytes)
    else:
        patch_path = None
        h = hashlib.sha256()
        for feature in features:
            rel = pathlib.Path(repo) / f"task{task}" / f"feature{feature}" / "tests.patch"
            h.update(rel.as_posix().encode())
            h.update((dataset / rel).read_bytes())
        input_sha = h.hexdigest()

    # Load the official package modules without importing its optional CLI entrypoint.
    source = upstream_root / "src" / "cooperbench"
    for name, path in (("cooperbench", source), ("cooperbench.eval", source / "eval"), ("cooperbench.runner", source / "runner")):
        module = types.ModuleType(name)
        module.__path__ = [str(path)]
        sys.modules[name] = module
    import cooperbench.eval.backends as backends
    import cooperbench.eval.sandbox as sandbox_module
    from cooperbench.eval.sandbox import _parse_results, _write_patch, test_solo

    original_get_backend = backends.get_backend
    def pinned_get_backend(name):
        backend = original_get_backend(name)
        if name != "docker":
            return backend
        original_create = backend.create_sandbox
        def create_sandbox(image, *args, **kwargs):
            if image not in (case_match["image"], case_match["image_digest"]):
                raise RuntimeError("CooperBench requested an image other than its pinned task image")
            inspected = subprocess.run(["docker", "image", "inspect", case_match["image_digest"]], capture_output=True, text=True)
            if inspected.returncode:
                raise RuntimeError("pinned Docker image is unavailable")
            records = json.loads(inspected.stdout)
            if case_match["image_digest"] not in (records[0].get("RepoDigests") or []):
                raise RuntimeError("Docker returned an image with the wrong repository digest")
            return original_create(case_match["image_digest"], *args, **kwargs)
        backend.create_sandbox = create_sandbox
        return backend
    backends.get_backend = pinned_get_backend
    sandbox_module.get_backend = pinned_get_backend

    if mode == "base":
        sandbox = pinned_get_backend("docker").create_sandbox(case_match["image"], 180)
        try:
            results = []
            for feature in features:
                tests = (task_root / f"feature{feature}" / "tests.patch").read_text(encoding="utf-8")
                _write_patch(sandbox, "tests.patch", tests)
                result = sandbox.exec("bash", "/usr/local/bin/runner.sh", "tests.patch")
                parsed = _parse_results(result.stdout_read() + result.stderr_read())
                results.append({"feature": feature, "exit_code": result.returncode, **parsed})
            passed = all(x["exit_code"] != 0 and x.get("failed", 0) > 0 for x in results)
            result_obj = {"mode": mode, "features": results, "both_passed": False, "valid_negative": passed}
        finally:
            sandbox.terminate()
    else:
        result_obj = test_solo(repo, task, *features, patch=patch_path, timeout=180, backend="docker", dataset_dir=dataset)
        if mode == "oracle": result_obj["valid_oracle"] = result_obj.get("both_passed") is True

    if mode == "base" and result_obj.get("valid_negative") is not True:
        raise RuntimeError("base-fail control did not fail every selected feature")
    if mode == "oracle" and result_obj.get("valid_oracle") is not True:
        raise RuntimeError("oracle control did not pass every selected feature")
    result_obj.update({"schema": SCHEMA, "mode": mode, "repo": repo, "task": task, "features": features,
                       "upstream_commit": EXPECTED_UPSTREAM, "upstream_source_sha256": source_sha256, "case_sha256": digest(case_bytes),
                       "input_sha256": input_sha, "evaluator_sha256": digest(pathlib.Path(__file__).read_bytes()),
                       "image_digest": case_match["image_digest"]})
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=output.parent, delete=False) as f:
        json.dump(result_obj, f, indent=2, sort_keys=True)
        f.write("\n")
        temp = pathlib.Path(f.name)
    temp.chmod(0o600)
    temp.replace(output)
    return 0

if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        # Do not include arbitrary task, provider, or credential contents in errors.
        print(f"benchmark evaluator: {type(exc).__name__}", file=sys.stderr)
        raise SystemExit(2)
