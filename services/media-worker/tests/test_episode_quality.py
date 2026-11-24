import shutil
import subprocess

import pytest

from media_worker import episode_quality


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg is required")
def test_measures_black_and_silence_on_actual_timeline(tmp_path):
    output = tmp_path / "episode.mp4"
    # Begin with half a second of picture and sound, then black and silence.
    subprocess.run([
        "ffmpeg", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "color=red:size=96x128:rate=25:duration=0.52",
        "-f", "lavfi", "-i", "sine=frequency=880:duration=0.52",
        "-f", "lavfi", "-i", "color=black:size=96x128:rate=25:duration=1.48",
        "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono:d=1.48",
        "-filter_complex", "[0:v][1:a][2:v][3:a]concat=n=2:v=1:a=1[vid][aud]",
        "-map", "[vid]", "-map", "[aud]", "-c:v", "libx264", "-threads", "1", "-c:a", "aac", str(output),
    ], check=True)
    report = episode_quality.check_episode(output, 2000, video_present=True, audio_present=True)
    assert report["status"] == "FAIL"
    assert {item["code"] for item in report["findings"]} == {"BLACK", "SILENCE"}
    for item in report["findings"]:
        assert 480 <= item["startMs"] <= 560
        assert 1900 <= item["endMs"] <= 2000


def test_missing_audio_and_unavailable_scanner_are_distinct(tmp_path, monkeypatch):
    path = tmp_path / "episode.mp4"
    result = episode_quality.check_episode(path, 1000, video_present=True, audio_present=False)
    assert result["status"] == "FAIL"
    assert result["findings"] == [{"code": "NO_AUDIO"}]

    def failed_to_start(*args):
        raise OSError("ffmpeg unavailable")
    monkeypatch.setattr(episode_quality, "_run_tool", failed_to_start)
    result = episode_quality.check_episode(path, 1000, video_present=True, audio_present=True)
    assert (result["status"], result["reason"]) == ("UNKNOWN", "CHECK_UNAVAILABLE")

    monkeypatch.setattr(episode_quality, "_run_tool", lambda *args: subprocess.CompletedProcess([], 1, b"", b""))
    result = episode_quality.check_episode(path, 1000, video_present=True, audio_present=True)
    assert (result["status"], result["reason"]) == ("UNKNOWN", "INCOMPLETE")
