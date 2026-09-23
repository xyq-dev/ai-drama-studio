from fastapi.testclient import TestClient

from media_worker.main import app


def test_live_and_ready_are_stubs() -> None:
    client = TestClient(app)
    for path in ("/health/live", "/health/ready"):
        response = client.get(path)
        assert response.status_code == 200
        body = response.json()
        assert body["service"] == "media-worker"
        assert body["status"] == "ok"
        assert body["mode"] == "stub"
        assert body["ffmpegRequired"] is False
        assert isinstance(body["timestamp"], str)
        assert "password" not in response.text
        assert "secret" not in response.text
