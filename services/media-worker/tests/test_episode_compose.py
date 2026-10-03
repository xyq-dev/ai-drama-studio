import json
import shutil
import subprocess
from pathlib import Path

import pytest

from media_worker.episode_compose import main, render

needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None, reason="ffmpeg is required")


def _run(args: list[str]) -> None:
    completed = subprocess.run(args, check=False, capture_output=True)
    if completed.returncode != 0:
        raise AssertionError(completed.stderr.decode("utf-8", errors="replace"))


def _clip(path: Path, color: str, seconds: str, frequency: str, audio_seconds: str | None = None) -> None:
    audio = audio_seconds or seconds
    _run([
        "ffmpeg", "-hide_banner", "-y",
        "-f", "lavfi", "-i", f"color=c={color}:s=1080x1920:r=25:d={seconds}",
        "-f", "lavfi", "-i", f"sine=frequency={frequency}:sample_rate=48000:duration={audio}",
        "-filter_complex",
        f"[0:v]fps=25,setsar=1,trim=0:{seconds},setpts=PTS-STARTPTS[v];"
        f"[1:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,atrim=0:{audio},asetpts=PTS-STARTPTS[a]",
        "-map", "[v]", "-map", "[a]",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", "25",
        "-c:a", "aac", "-ar", "48000", "-ac", "2",
        str(path),
    ])


def _probe(path: Path) -> dict:
    completed = subprocess.run(
        ["ffprobe", "-v", "error", "-print_format", "json", "-show_streams", "-show_format", str(path)],
        check=True, capture_output=True,
    )
    return json.loads(completed.stdout)


def _video_seconds(path: Path) -> float:
    video = next(item for item in _probe(path)["streams"] if item["codec_type"] == "video")
    return float(video["duration"])


def _color_at(path: Path, seconds: str) -> tuple[int, int, int]:
    completed = subprocess.run(
        ["ffmpeg", "-hide_banner", "-v", "error", "-ss", seconds, "-i", str(path), "-frames:v", "1",
         "-vf", "crop=40:40:20:20,scale=1:1:flags=fast_bilinear", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        check=True, capture_output=True,
    )
    return tuple(completed.stdout[:3])


def _plan(directory: Path, durations: list[int]) -> None:
    (directory / "plan.json").write_text(json.dumps({
        "durationMs": durations,
        "totalDurationMs": sum(durations),
    }), encoding="utf-8")


@needs_ffmpeg
def test_concat_keeps_order_and_audio_bounds(tmp_path: Path) -> None:
    first = tmp_path / "seg-000.mp4"
    second = tmp_path / "seg-001.mp4"
    _clip(first, "red", "0.40", "440", "0.16")
    _clip(second, "blue", "0.80", "880", "1.20")
    durations = [int(round(_video_seconds(first) * 1000)), int(round(_video_seconds(second) * 1000))]
    _plan(tmp_path, durations)
    output = tmp_path / "episode.mp4"
    assert main(["--input-dir", str(tmp_path), "--output", str(output)]) == 0
    early = _color_at(output, "0.08")
    later = _color_at(output, "0.56")
    assert early[0] > early[2]
    assert later[2] > later[0]
    probed = _probe(output)
    video = next(item for item in probed["streams"] if item["codec_type"] == "video")
    audio = next(item for item in probed["streams"] if item["codec_type"] == "audio")
    expected = sum(durations) / 1000
    assert abs(float(video["duration"]) - expected) <= (1 / 25) + 0.001
    assert abs(float(probed["format"]["duration"]) - expected) <= 0.1
    assert audio["codec_name"] == "aac"
    assert abs(float(audio["duration"]) - float(video["duration"])) <= 0.1


@needs_ffmpeg
def test_two_and_thirty_segments_and_rejects_bounds(tmp_path: Path) -> None:
    short = tmp_path / "unit.mp4"
    _clip(short, "green", "0.08", "660")
    duration = int(round(_video_seconds(short) * 1000))
    pair = tmp_path / "pair"
    pair.mkdir()
    for index in range(2):
        target = pair / f"seg-{index:03d}.mp4"
        target.write_bytes(short.read_bytes())
    _plan(pair, [duration, duration])
    assert main(["--input-dir", str(pair), "--output", str(pair / "out.mp4")]) == 0
    many = tmp_path / "many"
    many.mkdir()
    for index in range(30):
        (many / f"seg-{index:03d}.mp4").write_bytes(short.read_bytes())
    _plan(many, [duration] * 30)
    assert main(["--input-dir", str(many), "--output", str(many / "out.mp4")]) == 0
    over = tmp_path / "over"
    over.mkdir()
    _plan(over, [1000] * 31)
    with pytest.raises(Exception):
        render(over, over / "no.mp4")
    long = tmp_path / "long"
    long.mkdir()
    _plan(long, [45001, 45001])
    with pytest.raises(Exception):
        render(long, long / "no.mp4")


@needs_ffmpeg
def test_missing_audio_and_corrupt_media_fail(tmp_path: Path) -> None:
    silent = tmp_path / "seg-000.mp4"
    _run([
        "ffmpeg", "-hide_banner", "-y", "-f", "lavfi", "-i", "color=c=black:s=1080x1920:r=25:d=0.2",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", str(silent),
    ])
    other = tmp_path / "seg-001.mp4"
    _clip(other, "red", "0.20", "440")
    _plan(tmp_path, [200, 200])
    assert main(["--input-dir", str(tmp_path), "--output", str(tmp_path / "out.mp4")]) != 0
    broken = tmp_path / "broken"
    broken.mkdir()
    (broken / "seg-000.mp4").write_bytes(b"not-media")
    (broken / "seg-001.mp4").write_bytes(other.read_bytes())
    _plan(broken, [200, 200])
    assert main(["--input-dir", str(broken), "--output", str(broken / "out.mp4")]) != 0
