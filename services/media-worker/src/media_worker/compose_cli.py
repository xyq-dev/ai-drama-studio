"""Local single-shot FFmpeg compose.

This module does not read PostgreSQL or Redis and does not accept database
credentials. The HTTP health process remains a stub and does not render.
"""

from __future__ import annotations

import argparse
import ctypes
import hashlib
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

PROFILE = {
    "width": 1080,
    "height": 1920,
    "frame_rate": 25,
    "crf": "23",
    "preset": "veryfast",
    "speech_gain": "1",
    "music_gain": "0.25",
    "sample_rate": "48000",
    "max_output_bytes": 64 * 1024 * 1024,
    "render_timeout_sec": 300,
    "probe_timeout_sec": 30,
    "font": "DejaVu Sans",
    "font_style": "m4-subtitle-style-v1",
}
FIXED_NAMES = {"video": "video.mp4", "audio": "audio.wav", "music": "music.wav", "subtitle": "subtitle.vtt"}


def main(argv: list[str] | None = None) -> int:
    _die_with_parent()
    parser = argparse.ArgumentParser(prog="media-compose")
    parser.add_argument("--input-dir", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args(argv)
    try:
        result = render(Path(args.input_dir), Path(args.output))
    except ComposeFailure as error:
        print(json.dumps({"ok": False, "code": error.code, "retryable": error.retryable, "detail": error.detail[-400:]}), file=sys.stderr)
        return 2 if not error.retryable else 3
    print(json.dumps(result))
    return 0


class ComposeFailure(Exception):
    def __init__(self, code: str, retryable: bool, detail: str = "") -> None:
        super().__init__(code)
        self.code = code
        self.retryable = retryable
        self.detail = detail


def render(input_dir: Path, output: Path) -> dict[str, object]:
    started = time.monotonic()
    root = _directory(input_dir)
    video = _file(root, FIXED_NAMES["video"])
    speech = _optional(root, FIXED_NAMES["audio"])
    music = _optional(root, FIXED_NAMES["music"])
    subtitle = _optional(root, FIXED_NAMES["subtitle"])
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(f"{output.stem}.partial{output.suffix}")
    if temporary.exists() or output.exists():
        raise ComposeFailure("COMPOSE_OUTPUT_CONFLICT", False)
    source = _probe(video)
    duration = float(source["duration"])
    if duration <= 0 or duration > 90:
        raise ComposeFailure("COMPOSE_MEDIA_INVALID", False)
    cues = _safe_cues(subtitle) if subtitle else []
    srt = root / "burn.srt"
    if cues:
        srt.write_text(_srt(cues), encoding="utf-8")
    command = _command(video, speech, music, srt if cues else None, temporary, duration)
    try:
        completed = _run_tool(command, PROFILE["render_timeout_sec"])
    except subprocess.TimeoutExpired as error:
        temporary.unlink(missing_ok=True)
        raise ComposeFailure("COMPOSE_RENDER_TIMEOUT", True) from error
    except OSError as error:
        temporary.unlink(missing_ok=True)
        raise ComposeFailure("COMPOSE_RENDER_IO", True) from error
    if completed.returncode != 0:
        temporary.unlink(missing_ok=True)
        detail = completed.stderr.decode("utf-8", errors="replace")
        raise ComposeFailure("COMPOSE_MEDIA_INVALID", False, detail)
    _publish(temporary, output, duration, started)
    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    probed = _probe(output)
    return {
        "ok": True,
        "checksumSha256": digest,
        "byteSize": output.stat().st_size,
        "durationMs": int(round(float(probed["duration"]) * 1000)),
        "width": int(probed["width"]),
        "height": int(probed["height"]),
        "elapsedMs": int((time.monotonic() - started) * 1000),
        "videoCodec": probed["videoCodec"],
        "audioCodec": probed["audioCodec"],
    }


def _command(video: Path, speech: Path | None, music: Path | None, srt: Path | None, output: Path, duration: float) -> list[str]:
    inputs = ["-i", str(video)]
    filters = [f"[0:v]scale={PROFILE['width']}:{PROFILE['height']}:force_original_aspect_ratio=decrease,pad={PROFILE['width']}:{PROFILE['height']}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps={PROFILE['frame_rate']}[vbase]"]
    video_label = "vbase"
    if srt is not None:
        escaped = _filter_path(srt)
        style = f"FontName={PROFILE['font']},FontSize=28,PrimaryColour=&H00FFFFFF&,BorderStyle=1,Outline=1,Alignment=2"
        filters.append(f"[vbase]subtitles=filename='{escaped}':force_style='{style}'[v]")
        video_label = "v"
    else:
        filters.append("[vbase]null[v]")
    audio_labels: list[str] = []
    next_index = 1
    if speech is not None:
        inputs.extend(["-i", str(speech)])
        filters.append(_audio_filter(next_index, duration, PROFILE["speech_gain"], "speech"))
        audio_labels.append("[speech]")
        next_index += 1
    if music is not None:
        inputs.extend(["-i", str(music)])
        filters.append(_audio_filter(next_index, duration, PROFILE["music_gain"], "music"))
        audio_labels.append("[music]")
    if not audio_labels:
        inputs.extend(["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"])
        filters.append(f"[{next_index}:a]atrim=0:{duration:.6f},asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a]")
    elif len(audio_labels) == 1:
        filters.append(f"{audio_labels[0]}alimiter=limit=0.95:level=false[a]")
    else:
        filters.append(f"{''.join(audio_labels)}amix=inputs={len(audio_labels)}:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95:level=false[a]")
    return [
        "ffmpeg", "-hide_banner", "-nostdin", "-y",
        "-protocol_whitelist", "file,crypto,data",
        "-threads", "2",
        "-filter_threads", "2",
        "-filter_complex_threads", "2",
        *inputs,
        "-filter_complex", ";".join(filters),
        "-map", f"[{video_label}]" if video_label == "v" else "[v]",
        "-map", "[a]",
        "-c:v", "libx264", "-x264-params", "threads=2", "-pix_fmt", "yuv420p", "-crf", PROFILE["crf"], "-preset", PROFILE["preset"],
        "-r", str(PROFILE["frame_rate"]),
        "-c:a", "aac", "-ar", PROFILE["sample_rate"], "-ac", "2",
        "-t", f"{duration:.6f}",
        "-movflags", "+faststart",
        str(output),
    ]


def _audio_filter(index: int, duration: float, gain: str, label: str) -> str:
    return (
        f"[{index}:a]atrim=0:{duration:.6f},asetpts=PTS-STARTPTS,apad,"
        f"atrim=0:{duration:.6f},volume={gain},aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[{label}]"
    )


def _publish(temporary: Path, output: Path, duration: float, started: float) -> None:
    if time.monotonic() - started > PROFILE["render_timeout_sec"]:
        temporary.unlink(missing_ok=True)
        raise ComposeFailure("COMPOSE_RENDER_TIMEOUT", True)
    size = temporary.stat().st_size
    if size <= 0 or size > PROFILE["max_output_bytes"]:
        temporary.unlink(missing_ok=True)
        raise ComposeFailure("COMPOSE_OUTPUT_INVALID", False, f"size {size}")
    probed = _probe(temporary)
    if probed["videoCodec"] != "h264" or probed["audioCodec"] != "aac":
        temporary.unlink(missing_ok=True)
        raise ComposeFailure("COMPOSE_OUTPUT_INVALID", False, f"codecs {probed['videoCodec']}/{probed['audioCodec']}")
    if int(probed["width"]) != PROFILE["width"] or int(probed["height"]) != PROFILE["height"]:
        temporary.unlink(missing_ok=True)
        raise ComposeFailure("COMPOSE_OUTPUT_INVALID", False, f"frame {probed['width']}x{probed['height']}")
    if abs(float(probed["frameRate"]) - PROFILE["frame_rate"]) > 0.01:
        temporary.unlink(missing_ok=True)
        raise ComposeFailure("COMPOSE_OUTPUT_INVALID", False, f"fps {probed['frameRate']}")
    actual = float(probed["duration"])
    if abs(actual - duration) > (1 / PROFILE["frame_rate"]) + 0.001:
        temporary.unlink(missing_ok=True)
        raise ComposeFailure("COMPOSE_OUTPUT_INVALID", False, f"duration {actual} expected {duration}")
    if abs(float(probed["containerDuration"]) - duration) > 0.1:
        temporary.unlink(missing_ok=True)
        raise ComposeFailure("COMPOSE_OUTPUT_INVALID", False, f"container {probed['containerDuration']} expected {duration}")
    decode = _run_tool(
        ["ffmpeg", "-hide_banner", "-nostdin", "-v", "error", "-xerror", "-i", str(temporary), "-f", "null", "-"],
        PROFILE["render_timeout_sec"],
    )
    if decode.returncode != 0:
        temporary.unlink(missing_ok=True)
        raise ComposeFailure("COMPOSE_OUTPUT_INVALID", False, decode.stderr.decode("utf-8", errors="replace")[-300:])
    temporary.replace(output)


def _probe(path: Path) -> dict[str, object]:
    try:
        completed = _run_tool(
            ["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)],
            PROFILE["probe_timeout_sec"],
        )
    except (subprocess.TimeoutExpired, OSError) as error:
        raise ComposeFailure("COMPOSE_PROBE_FAILED", True) from error
    if completed.returncode != 0:
        raise ComposeFailure("COMPOSE_MEDIA_INVALID", False)
    payload = json.loads(completed.stdout.decode("utf-8"))
    streams = payload.get("streams") or []
    video = next((item for item in streams if item.get("codec_type") == "video"), None)
    audio = next((item for item in streams if item.get("codec_type") == "audio"), None)
    if not isinstance(video, dict):
        raise ComposeFailure("COMPOSE_MEDIA_INVALID", False)
    rate = str(video.get("avg_frame_rate") or video.get("r_frame_rate") or "0/1")
    frame_rate = _ratio(rate)
    duration = video.get("duration") or (payload.get("format") or {}).get("duration")
    container = (payload.get("format") or {}).get("duration") or duration
    return {
        "duration": float(duration),
        "containerDuration": float(container),
        "width": int(video.get("width") or 0),
        "height": int(video.get("height") or 0),
        "frameRate": frame_rate,
        "videoCodec": str(video.get("codec_name") or ""),
        "audioCodec": str(audio.get("codec_name") or "") if isinstance(audio, dict) else "",
    }


def _safe_cues(path: Path) -> list[tuple[str, str, str]]:
    text = path.read_text(encoding="utf-8", errors="replace")
    cues: list[tuple[str, str, str]] = []
    for block in re.split(r"\n\s*\n", text.strip()):
        lines = [line.strip() for line in block.splitlines() if line.strip() and not line.startswith("WEBVTT") and not line.startswith("NOTE")]
        timing = next((line for line in lines if "-->" in line), None)
        if not timing:
            continue
        start, end = [part.strip() for part in timing.split("-->", 1)]
        body = " ".join(line for line in lines if "-->" not in line and not line.isdigit())
        plain = re.sub(r"\{[^}]*\}", "", body)
        plain = re.sub(r"<[^>]*>", "", plain)
        plain = plain.replace("{", "").replace("}", "").replace("\\", "")
        plain = " ".join(plain.split())
        if plain:
            cues.append((_timestamp(start), _timestamp(end), plain))
    return cues


def _srt(cues: list[tuple[str, str, str]]) -> str:
    parts = []
    for index, (start, end, text) in enumerate(cues, start=1):
        parts.append(f"{index}\n{start.replace('.', ',')} --> {end.replace('.', ',')}\n{text}\n")
    return "\n".join(parts)


def _timestamp(value: str) -> str:
    match = re.match(r"(?:(\d+):)?(\d{2}):(\d{2})[.](\d{3})", value.strip())
    if not match:
        raise ComposeFailure("COMPOSE_MEDIA_INVALID", False)
    hours = int(match.group(1) or "0")
    return f"{hours:02d}:{match.group(2)}:{match.group(3)}.{match.group(4)}"


def _ratio(value: str) -> float:
    if "/" in value:
        left, right = value.split("/", 1)
        denominator = float(right)
        if denominator == 0:
            return 0
        return float(left) / denominator
    return float(value)


def _filter_path(path: Path) -> str:
    text = path.as_posix().replace("\\", "\\\\").replace(":", "\\:").replace("'", r"\'")
    return text


def _run_tool(args: list[str], timeout: float) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        args,
        shell=False,
        check=False,
        capture_output=True,
        timeout=timeout,
        preexec_fn=_die_with_parent if sys.platform == "linux" else None,
    )


def _die_with_parent() -> None:
    if sys.platform != "linux":
        return
    libc = ctypes.CDLL("libc.so.6", use_errno=True)
    if libc.prctl(1, 9) != 0 or os.getppid() == 1:
        os.kill(os.getpid(), 9)


def _directory(path: Path) -> Path:
    if not path.is_absolute():
        raise ComposeFailure("COMPOSE_PATH_INVALID", False)
    current = Path(path.anchor)
    for part in path.parts[1:]:
        current = current / part
        if current.is_symlink():
            raise ComposeFailure("COMPOSE_PATH_INVALID", False)
    if not current.is_dir():
        raise ComposeFailure("COMPOSE_PATH_INVALID", False)
    return current


def _file(root: Path, name: str) -> Path:
    if name != Path(name).name or name in {".", ".."}:
        raise ComposeFailure("COMPOSE_PATH_INVALID", False)
    candidate = root / name
    if candidate.is_symlink() or not candidate.is_file() or root.resolve() not in candidate.resolve().parents:
        raise ComposeFailure("COMPOSE_PATH_INVALID", False)
    return candidate.resolve()


def _optional(root: Path, name: str) -> Path | None:
    candidate = root / name
    if not candidate.exists():
        return None
    return _file(root, name)


if __name__ == "__main__":
    raise SystemExit(main())
