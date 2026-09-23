# Media Worker

M1-A health stub. It does not run FFmpeg or accept media jobs.

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
