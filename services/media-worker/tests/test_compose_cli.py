import hashlib
import json
import shutil
import subprocess
from pathlib import Path

import pytest

from media_worker.compose_cli import _safe_cues, main

needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None, reason="ffmpeg is required")


def _run(args: list[str]) -> None:
    completed = subprocess.run(args, check=False, capture_output=True)
    if completed.returncode != 0:
        raise AssertionError(completed.stderr.decode("utf-8", errors="replace"))


def _video(path: Path, size: str, seconds: str, color: str = "red") -> None:
    _run(["ffmpeg", "-hide_banner", "-y", "-f", "lavfi", "-i", f"color=c={color}:s={size}:d={seconds}", "-r", "25", str(path)])


def _tone(path: Path, seconds: str, frequency: str) -> None:
    _run(["ffmpeg", "-hide_banner", "-y", "-f", "lavfi", "-i", f"sine=frequency={frequency}:duration={seconds}", str(path)])


def _probe(path: Path) -> dict:
    completed = subprocess.run(
        ["ffprobe", "-v", "error", "-print_format", "json", "-show_streams", "-show_format", str(path)],
        check=True, capture_output=True,
    )
    return json.loads(completed.stdout)


def test_plain_cues_drop_ass_markup(tmp_path: Path) -> None:
    path = _write(tmp_path / "cue-input.vtt", "WEBVTT\n\n00:00:00.000 --> 00:00:00.200\nHello {\\an5}<b>Cue</b>\n")
    assert _safe_cues(path)[0][2] == "Hello Cue"


def _write(path: Path, text: str) -> Path:
    path.write_text(text, encoding="utf-8")
    return path


@needs_ffmpeg
def test_widescreen_source_is_padded_and_subtitle_changes_the_frame(tmp_path: Path) -> None:
    _video(tmp_path / "video.mp4", "640x360", "1", "red")
    _tone(tmp_path / "audio.wav", "1", "440")
    plain = tmp_path / "plain.mp4"
    burned = tmp_path / "burned.mp4"
    assert main(["--input-dir", str(tmp_path), "--output", str(plain)]) == 0
    _write(tmp_path / "subtitle.vtt", "WEBVTT\n\n00:00:00.000 --> 00:00:00.800\nVisible subtitle\n")
    assert main(["--input-dir", str(tmp_path), "--output", str(burned)]) == 0
    probed = _probe(burned)
    video = next(item for item in probed["streams"] if item["codec_type"] == "video")
    audio = next(item for item in probed["streams"] if item["codec_type"] == "audio")
    assert video["width"] == 1080 and video["height"] == 1920
    assert video["codec_name"] == "h264" and audio["codec_name"] == "aac"
    assert abs(_ratio(video["avg_frame_rate"]) - 25) < 0.05
    top = tmp_path / "top.png"
    center = tmp_path / "center.png"
    _run(["ffmpeg", "-y", "-i", str(burned), "-frames:v", "1", "-vf", "crop=20:20:0:0", str(top)])
    _run(["ffmpeg", "-y", "-i", str(burned), "-frames:v", "1", "-vf", "crop=40:40:520:900", str(center)])
    assert _not_flat(top, "black-bar")
    assert hashlib.sha256(plain.read_bytes()).hexdigest() != hashlib.sha256(burned.read_bytes()).hexdigest()


@needs_ffmpeg
def test_speech_and_music_mix_trim_and_pad(tmp_path: Path) -> None:
    _video(tmp_path / "video.mp4", "320x240", "1", "blue")
    _tone(tmp_path / "audio.wav", "2", "440")
    _tone(tmp_path / "music.wav", "0.2", "880")
    output = tmp_path / "mix.mp4"
    assert main(["--input-dir", str(tmp_path), "--output", str(output)]) == 0
    volume = subprocess.run(
        ["ffmpeg", "-i", str(output), "-af", "volumedetect", "-f", "null", "-"],
        check=False, capture_output=True, text=True,
    )
    assert "max_volume: -inf" not in volume.stderr
    probed = _probe(output)
    duration = float(probed["format"]["duration"])
    assert abs(duration - 1) < 0.15


def _ratio(value: str) -> float:
    left, right = value.split("/")
    return float(left) / float(right)


def _not_flat(path: Path, label: str) -> bool:
    completed = subprocess.run(
        ["ffmpeg", "-i", str(path), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        check=True, capture_output=True,
    )
    sample = completed.stdout[:3]
    if label == "black-bar":
        return sample == b"\x00\x00\x00"
    return True
