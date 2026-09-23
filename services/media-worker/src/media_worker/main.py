"""M1-A media worker health stub.

This process does not call FFmpeg, download models, touch object storage,
read the Core database, accept file paths, or run shell commands.
"""

from __future__ import annotations

import os
from datetime import datetime, timezone

from fastapi import FastAPI

app = FastAPI(title="media-worker", docs_url=None, redoc_url=None, openapi_url=None)


def health_payload() -> dict[str, object]:
    return {
        "service": "media-worker",
        "status": "ok",
        "mode": "stub",
        "ffmpegRequired": False,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


@app.get("/health/live")
def live() -> dict[str, object]:
    return health_payload()


@app.get("/health/ready")
def ready() -> dict[str, object]:
    return health_payload()


def main() -> None:
    import uvicorn

    raw_port = os.environ.get("MEDIA_WORKER_PORT", "8001")
    host = os.environ.get("BIND_HOST", "127.0.0.1")
    if not raw_port.isdigit():
        raise SystemExit("MEDIA_WORKER_PORT must be an integer")
    port = int(raw_port)
    if port < 1 or port > 65535:
        raise SystemExit("MEDIA_WORKER_PORT must be an integer")
    uvicorn.run(app, host=host, port=port, log_level="info")
