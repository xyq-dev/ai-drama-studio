# Media Worker

M1-A health stub. The health process does not run FFmpeg or accept media jobs. Single-shot rendering is a separate CLI, `python -m media_worker.compose_cli`, invoked by the Node worker. Episode rendering is `python -m media_worker.episode_compose`.

Three interpreters stay separate:

- `MEDIA_WORKER_PYTHON` selects the interpreter for `pnpm verify`. When it is unset, `scripts/run-media-worker-tests.mjs` uses `python` on Windows and `python3` elsewhere. An empty value is not replaced with another interpreter.
- `M4_COMPOSE_PYTHON` selects the interpreter the Node worker uses for the compose CLIs. The worker schema defaults it to `python3` when the variable is absent. An empty string is rejected even when every compose switch is off. This does not change `MEDIA_WORKER_PYTHON`.
- `python -m media_worker` is only the HTTP health process. Its `/health/live` and `/health/ready` responses do not mean FFmpeg compose ran.

The development path, including the default-off switches, is in `docs/DEV_RUNBOOK.md`.

## Episode quality check

After rendering, the episode CLI scans the final MP4 with local FFmpeg. It reports black intervals of at least 0.5 s and silence below −50 dB lasting at least 1 s. Very short previews use half their duration as the maximum detection threshold. Findings include millisecond timestamps; the first 64 are retained. An unavailable or incomplete scan is recorded as `UNKNOWN`. Findings are available for creator review alongside the output.

The worker freezes the admin skill switch when dispatching the render and verifies the output digest before persisting the report with the asset. The measurement parsers are adapted from [qc-skill 1.4.5](https://github.com/kajisho5/qc-skill/tree/df73a07105fba979192273cfb863dc72cbd634b6). The source revision and MIT license are included in `qc_skill_measurements.py`.

## Local setup

Windows PowerShell:

From the repository root:

```powershell
python -m venv services/media-worker/.venv
services/media-worker/.venv/Scripts/python -m pip install -e "services/media-worker[dev]"
services/media-worker/.venv/Scripts/python -m pytest services/media-worker/tests
```

Linux/macOS shell:

```sh
python3 -m venv services/media-worker/.venv
services/media-worker/.venv/bin/python -m pip install -e "services/media-worker[dev]"
services/media-worker/.venv/bin/python -m pytest services/media-worker/tests
```

## Start

```powershell
$env:MEDIA_WORKER_PORT = "8001"
$env:BIND_HOST = "127.0.0.1"
services/media-worker/.venv/Scripts/python -m media_worker
```

Linux/macOS shell:

```sh
MEDIA_WORKER_PORT=8001 BIND_HOST=127.0.0.1 services/media-worker/.venv/bin/python -m media_worker
```

Health:

- http://127.0.0.1:8001/health/live
- http://127.0.0.1:8001/health/ready

The virtual environment stays local and is gitignored.
