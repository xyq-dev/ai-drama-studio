"""Measured, sentence-based voice composition; the legacy compose profile is unchanged.

Only already staged local media are accepted. There are no provider, database or
network calls, and speech overflow is rejected before FFmpeg starts rendering.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import subprocess
import sys
import time
import unicodedata
from pathlib import Path

from media_worker.compose_cli import ComposeFailure, _die_with_parent, _directory, _file, _filter_path, _ratio, _run_tool
from media_worker.encode_measurement import measure_local_encode
from media_worker.voice_font import stage_voice_font

PROFILE = {
    "id": "local-ffmpeg-voice-v1",
    "width": 1080,
    "height": 1920,
    "frame_rate": 25,
    "sample_rate": 48000,
    "channels": 2,
    "max_output_bytes": 64 * 1024 * 1024,
    "render_timeout_sec": 300,
    "probe_timeout_sec": 30,
    "ducking_gain": 0.2,
    "ducking_attack_ms": 50,
    "ducking_release_ms": 200,
    "ambience_gain": 0.25,
    "music_fade_out_ms": 1000,
    "font": "Noto Sans CJK SC",
    "font_style": "m4-voice-subtitle-style-v1",
    "font_size": 48,
}
MAX_PLAN_BYTES = 1024 * 1024
MAX_SUBTITLE_BYTES = 64 * 1024
MAX_VIDEO_BYTES = 100 * 1024 * 1024
MAX_AUDIO_BYTES = 20 * 1024 * 1024
HASH = re.compile(r"[a-f0-9]{64}\Z")
UUID = re.compile(r"[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\Z", re.I)


def main(argv: list[str] | None = None) -> int:
    _die_with_parent()
    parser = argparse.ArgumentParser(prog="media-voice-compose")
    parser.add_argument("--input-dir", "--work-dir", dest="input_dir", required=True)
    parser.add_argument("--output")
    parser.add_argument("--font-path", help="Operator-owned absolute Noto Sans CJK SC font path")
    args = parser.parse_args(argv)
    root = Path(args.input_dir)
    try:
        result = render(root, Path(args.output) if args.output else root / "output.mp4", Path(args.font_path) if args.font_path else None)
    except ComposeFailure as error:
        # Neither staged text nor raw FFmpeg output belongs in a public failure.
        print(json.dumps({"ok": False, "code": error.code, "retryable": error.retryable}), file=sys.stderr)
        return 3 if error.retryable else 2
    except (OSError, ValueError, UnicodeError, json.JSONDecodeError):
        print(json.dumps({"ok": False, "code": "COMPOSE_MEDIA_INVALID", "retryable": False}), file=sys.stderr)
        return 2
    print(json.dumps(result))
    return 0


def _invalid(code: str = "COMPOSE_VOICE_MANIFEST_INVALID") -> None:
    raise ComposeFailure(code, False)


def _integer(value: object, minimum: int, maximum: int) -> bool:
    return type(value) is int and minimum <= value <= maximum


def _hash(value: object) -> bool:
    return isinstance(value, str) and HASH.fullmatch(value) is not None


def _id(value: object) -> bool:
    return isinstance(value, str) and UUID.fullmatch(value) is not None


def _text(value: object) -> bool:
    if not isinstance(value, str) or not value.strip() or len(value) > 2000 or "\0" in value:
        return False
    try:
        value.encode("utf-8", errors="strict")
    except UnicodeError:
        return False
    return True


def _bounded(path: Path, limit: int) -> bytes:
    if path.stat().st_size <= 0 or path.stat().st_size > limit:
        _invalid("COMPOSE_MEDIA_INVALID")
    with path.open("rb") as handle:
        data = handle.read(limit + 1)
    if not data or len(data) > limit:
        _invalid("COMPOSE_MEDIA_INVALID")
    return data


def _sha(path: Path, limit: int) -> str:
    size = path.stat().st_size
    if size <= 0 or size > limit:
        _invalid("COMPOSE_MEDIA_INVALID")
    digest = hashlib.sha256()
    total = 0
    with path.open("rb") as source:
        while block := source.read(64 * 1024):
            total += len(block)
            if total > limit or total > size:
                _invalid("COMPOSE_MEDIA_INVALID")
            digest.update(block)
    if total != size:
        _invalid("COMPOSE_MEDIA_INVALID")
    return digest.hexdigest()


def _timestamp(milliseconds: int) -> str:
    return f"{milliseconds // 3_600_000:02d}:{milliseconds // 60_000 % 60:02d}:{milliseconds // 1000 % 60:02d}.{milliseconds % 1000:03d}"


def _vtt(cues: list[dict]) -> str:
    def escaped(text: str) -> str:
        text = text.replace("\r\n", "\n").replace("\r", "\n")
        text = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        # Preserve every source paragraph. A WORD JOINER makes an ASCII-blank
        # content line nonempty in WebVTT without giving it visible text; raw
        # manifest cues remain unchanged and drive literal caption textfiles.
        return "\n".join(line + "\u2060" if re.fullmatch(r"[\t \f\v]*", line) else line for line in text.split("\n"))
    return "WEBVTT\n\n" + "\n".join(
        f"{index}\n{_timestamp(cue['startMs'])} --> {_timestamp(cue['endMs'])}\n{escaped(cue['text'])}\n"
        for index, cue in enumerate(cues, start=1)
    )


def validate_manifest(manifest: object) -> dict:
    if not isinstance(manifest, dict) or manifest.get("schema") != "voice.shot.mix.v1":
        _invalid()
    for key in ("workspaceId", "projectId", "shotRevisionId", "planRevisionId", "videoAssetId"):
        if not _id(manifest.get(key)):
            _invalid()
    for key in ("planHash", "selectionHash", "videoChecksumSha256"):
        if not _hash(manifest.get(key)):
            _invalid()
    if not _integer(manifest.get("videoDurationMs"), 1, 90_000) or not _integer(manifest.get("totalSpeechMs"), 0, 90_000):
        _invalid()
    lines = manifest.get("lines")
    if not isinstance(lines, list) or not 0 <= len(lines) <= 100:
        _invalid()
    cursor = 0
    line_ids: set[str] = set()
    selection_ids: set[str] = set()
    for line in lines:
        if not isinstance(line, dict):
            _invalid()
        for key in ("lineId", "lineInputRevisionId", "voiceRevisionId", "selectionId", "takeAssetId"):
            if not _id(line.get(key)):
                _invalid()
        if line["lineId"] in line_ids or line["selectionId"] in selection_ids:
            _invalid()
        line_ids.add(line["lineId"])
        selection_ids.add(line["selectionId"])
        if not _hash(line.get("checksumSha256")) or not _text(line.get("displayText")) or line.get("alignmentVersion") != "sentence-duration-v1":
            _invalid()
        if not _integer(line.get("startMs"), 0, 90_000) or not _integer(line.get("endMs"), 1, 90_000) or not _integer(line.get("pauseAfterMs"), 0, 5000):
            _invalid()
        if line["startMs"] != cursor or line["endMs"] <= line["startMs"]:
            _invalid()
        cursor = line["endMs"] + line["pauseAfterMs"]
    if cursor != manifest["totalSpeechMs"]:
        _invalid()
    if cursor > manifest["videoDurationMs"]:
        _invalid("SPEECH_AUDIO_OVERFLOW")
    subtitles = manifest.get("subtitles")
    if not isinstance(subtitles, dict) or subtitles.get("format") != "vtt" or subtitles.get("alignmentVersion") != "sentence-duration-v1" or not _hash(subtitles.get("checksumSha256")):
        _invalid()
    cues = subtitles.get("cues")
    if not isinstance(cues, list) or len(cues) != len(lines):
        _invalid()
    for line, cue in zip(lines, cues):
        if not isinstance(cue, dict) or any(cue.get(key) != line[key] for key in ("lineId", "startMs", "endMs")) or cue.get("text") != line["displayText"]:
            _invalid()
    canonical_vtt = _vtt(cues).encode("utf-8")
    if len(canonical_vtt) > MAX_SUBTITLE_BYTES or hashlib.sha256(canonical_vtt).hexdigest() != subtitles["checksumSha256"]:
        _invalid("COMPOSE_SUBTITLE_INVALID")
    mix = manifest.get("mix")
    if not isinstance(mix, dict) or mix.get("audioOverflow") != "reject" or mix.get("audioUnderflow") != "pad-silence" or mix.get("sampleRate") != 48000 or mix.get("channels") != 2:
        _invalid()
    if mix.get("originalAudio") not in ("mute", "confirmed-ambience") or type(mix.get("ducking")) is not bool:
        _invalid()
    gain = mix.get("musicGain")
    if type(gain) not in (int, float) or not math.isfinite(gain) or not 0 <= gain <= 1:
        _invalid()
    if mix.get("musicAssetId") is None:
        if mix.get("musicChecksumSha256") is not None:
            _invalid()
    elif not _id(mix.get("musicAssetId")) or not _hash(mix.get("musicChecksumSha256")):
        _invalid()
    return manifest


def _probe(path: Path) -> dict:
    try:
        result = _run_tool(["ffprobe", "-v", "error", "-protocol_whitelist", "file,pipe", "-print_format", "json", "-show_streams", "-show_format", str(path)], PROFILE["probe_timeout_sec"])
    except (OSError, subprocess.TimeoutExpired) as error:
        raise ComposeFailure("COMPOSE_PROBE_FAILED", True) from error
    if result.returncode != 0:
        _invalid("COMPOSE_MEDIA_INVALID")
    try:
        payload = json.loads(result.stdout.decode("utf-8", errors="strict"))
        streams = payload.get("streams") or []
        video = next((item for item in streams if item.get("codec_type") == "video"), None)
        audio = next((item for item in streams if item.get("codec_type") == "audio"), None)
        primary = video or audio
        if not primary:
            _invalid("COMPOSE_MEDIA_INVALID")
        duration = float(primary.get("duration") or payload.get("format", {}).get("duration") or 0)
        container_duration = float(payload.get("format", {}).get("duration") or duration)
        if not math.isfinite(duration) or not 0 < duration <= 90.1:
            _invalid("COMPOSE_MEDIA_INVALID")
        return {"duration": duration, "containerDuration": container_duration, "video": video, "audio": audio,
                "format": str(payload.get("format", {}).get("format_name") or "")}
    except (TypeError, ValueError, UnicodeError, KeyError) as error:
        raise ComposeFailure("COMPOSE_MEDIA_INVALID", False) from error


def _caption_text(text: str) -> str:
    """Wrap literal text, never interpret HTML, ASS braces or backslash escapes."""
    wrapped: list[str] = []
    for paragraph in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        row, width = "", 0
        for character in paragraph:
            units = 0 if unicodedata.combining(character) else 2 if unicodedata.east_asian_width(character) in ("W", "F") else 1
            if width + units > 36 and row:
                wrapped.append(row)
                row, width = "", 0
            row += character
            width += units
        wrapped.append(row)
    # Reject a layout that could hide text beyond the frame; it must be split at
    # the plan stage rather than silently clipped in a successful composition.
    if len(wrapped) > 16:
        _invalid("COMPOSE_SUBTITLE_LAYOUT_INVALID")
    return "\n".join(wrapped)


def _caption_files(root: Path, manifest: dict) -> list[Path]:
    paths = []
    for index, cue in enumerate(manifest["subtitles"]["cues"]):
        path = root / f"voice-caption-{index:03d}.txt"
        try:
            with path.open("x", encoding="utf-8", newline="\n") as handle:
                handle.write(_caption_text(cue["text"]))
        except FileExistsError as error:
            raise ComposeFailure("COMPOSE_OUTPUT_CONFLICT", False) from error
        paths.append(path)
    return paths


def _ducking_expression(lines: list[dict]) -> str:
    if not lines:
        return "1"
    attack = PROFILE["ducking_attack_ms"] / 1000
    release = PROFILE["ducking_release_ms"] / 1000
    envelopes = []
    for line in lines:
        start, end = line["startMs"] / 1000, line["endMs"] / 1000
        envelopes.append(f"min(1,max(0,(t-({start - attack:.6f}))/{attack:.6f}))*min(1,max(0,({end + release:.6f}-t)/{release:.6f}))")
    active = envelopes[0]
    for envelope in envelopes[1:]:
        active = f"max({active},{envelope})"
    return f"1-({1 - PROFILE['ducking_gain']:.6f})*({active})"


def command(root: Path, manifest: dict, source_has_audio: bool, caption_files: list[Path], output: Path, duration: float, font_path: Path | None = None) -> list[str]:
    def media_input(path: Path) -> list[str]:
        return ["-protocol_whitelist", "file,pipe", "-i", str(path)]
    inputs = media_input(root / "video.mp4")
    filters = [f"[0:v]scale={PROFILE['width']}:{PROFILE['height']}:force_original_aspect_ratio=decrease,pad={PROFILE['width']}:{PROFILE['height']}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps={PROFILE['frame_rate']}[vbase]"]
    previous = "vbase"
    for index, (cue, path) in enumerate(zip(manifest["subtitles"]["cues"], caption_files)):
        label = f"vc{index}"
        actual_font = font_path or root / "voice-font.otf"
        filters.append(f"[{previous}]drawtext=fontfile='{_filter_path(actual_font)}':textfile='{_filter_path(path)}':expansion=none:fontsize={PROFILE['font_size']}:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=12:line_spacing=8:x=(w-text_w)/2:y=h-text_h-96:enable='gte(t,{cue['startMs'] / 1000:.6f})*lt(t,{cue['endMs'] / 1000:.6f})'[{label}]")
        previous = label
    filters.append(f"[{previous}]null[v]")
    speech_labels = []
    for index, line in enumerate(manifest["lines"]):
        inputs.extend(media_input(root / f"speech-{index:03d}.wav"))
        # No sentence is trimmed or stretched. Padding happens only after the
        # measured sentences have been combined into their frozen timeline.
        filters.append(f"[{index + 1}:a]aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS,adelay={line['startMs']}:all=1[s{index}]")
        speech_labels.append(f"[s{index}]")
    if speech_labels:
        filters.append(f"{''.join(speech_labels)}amix=inputs={len(speech_labels)}:duration=longest:dropout_transition=0:normalize=0,apad[speech]")
    else:
        filters.append("anullsrc=r=48000:cl=stereo[speech]")
    audio_labels = ["[speech]"]
    mix = manifest["mix"]
    duck = f",volume='{_ducking_expression(manifest['lines'])}':eval=frame" if mix["ducking"] else ""
    if mix["musicAssetId"] is not None:
        inputs.extend(media_input(root / "music.wav"))
        index = len(manifest["lines"]) + 1
        fade_duration = min(PROFILE["music_fade_out_ms"] / 1000, duration)
        fade_start = max(0, duration - fade_duration)
        filters.append(f"[{index}:a]aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS,apad,atrim=duration={duration:.6f},volume={mix['musicGain']:.6f}{duck},afade=t=out:st={fade_start:.6f}:d={fade_duration:.6f}[music]")
        audio_labels.append("[music]")
    if mix["originalAudio"] == "confirmed-ambience" and source_has_audio:
        filters.append(f"[0:a]aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS,apad,atrim=duration={duration:.6f},volume={PROFILE['ambience_gain']:.6f}{duck}[ambience]")
        audio_labels.append("[ambience]")
    filters.append(f"{''.join(audio_labels)}amix=inputs={len(audio_labels)}:duration=longest:dropout_transition=0:normalize=0,alimiter=limit=0.95:level=false:latency=true[a]")
    return ["ffmpeg", "-hide_banner", "-nostdin", "-n", "-threads", "2", "-filter_threads", "2", "-filter_complex_threads", "2", *inputs,
            "-filter_complex", ";".join(filters), "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-x264-params", "threads=2",
            "-pix_fmt", "yuv420p", "-crf", "23", "-preset", "veryfast", "-r", "25", "-c:a", "aac", "-ar", "48000", "-ac", "2",
            "-t", f"{duration:.6f}", "-movflags", "+faststart", str(output)]


def _verify_output(path: Path, duration: float, started: float) -> dict:
    if time.monotonic() - started > PROFILE["render_timeout_sec"]:
        raise ComposeFailure("COMPOSE_RENDER_TIMEOUT", True)
    if path.stat().st_size <= 0 or path.stat().st_size > PROFILE["max_output_bytes"]:
        _invalid("COMPOSE_OUTPUT_INVALID")
    probed = _probe(path)
    video, audio = probed["video"], probed["audio"]
    if not video or not audio or video.get("codec_name") != "h264" or audio.get("codec_name") != "aac" or video.get("width") != PROFILE["width"] or video.get("height") != PROFILE["height"]:
        _invalid("COMPOSE_OUTPUT_INVALID")
    if abs(_ratio(str(video.get("avg_frame_rate") or "0/1")) - PROFILE["frame_rate"]) > 0.01 or abs(probed["duration"] - duration) > 0.041 or abs(probed["containerDuration"] - duration) > 0.1:
        _invalid("COMPOSE_OUTPUT_INVALID")
    if int(audio.get("sample_rate") or 0) != PROFILE["sample_rate"] or int(audio.get("channels") or 0) != PROFILE["channels"]:
        _invalid("COMPOSE_OUTPUT_INVALID")
    try:
        decoded = _run_tool(["ffmpeg", "-hide_banner", "-nostdin", "-v", "error", "-xerror", "-protocol_whitelist", "file,pipe", "-i", str(path), "-f", "null", "-"], PROFILE["render_timeout_sec"])
    except (OSError, subprocess.TimeoutExpired) as error:
        raise ComposeFailure("COMPOSE_RENDER_IO", True) from error
    if decoded.returncode != 0:
        _invalid("COMPOSE_OUTPUT_INVALID")
    return probed


def render(input_dir: Path, output: Path, font_path: Path | None = None) -> dict[str, object]:
    started = time.monotonic()
    root = _directory(input_dir)
    if not output.is_absolute() or output.parent != root or output.name != "output.mp4":
        _invalid("COMPOSE_PATH_INVALID")
    temporary = root / "output.voice.partial.mp4"
    if output.exists() or output.is_symlink() or temporary.exists() or temporary.is_symlink():
        _invalid("COMPOSE_OUTPUT_CONFLICT")
    raw_plan = _bounded(_file(root, "voice-plan.json"), MAX_PLAN_BYTES)
    try:
        manifest = validate_manifest(json.loads(raw_plan.decode("utf-8", errors="strict")))
    except (ValueError, UnicodeError) as error:
        raise ComposeFailure("COMPOSE_VOICE_MANIFEST_INVALID", False) from error
    video = _file(root, "video.mp4")
    if _sha(video, MAX_VIDEO_BYTES) != manifest["videoChecksumSha256"]:
        _invalid("COMPOSE_INPUT_INVALID")
    probed_video = _probe(video)
    if not probed_video["video"] or "mp4" not in probed_video["format"].split(",") or probed_video["duration"] > 90:
        _invalid("COMPOSE_MEDIA_INVALID")
    duration = probed_video["duration"]
    if abs(duration * 1000 - manifest["videoDurationMs"]) > 2:
        _invalid("COMPOSE_INPUT_INVALID")
    if manifest["totalSpeechMs"] / 1000 > duration + 0.001:
        _invalid("SPEECH_AUDIO_OVERFLOW")
    for index, line in enumerate(manifest["lines"]):
        path = _file(root, f"speech-{index:03d}.wav")
        if _sha(path, MAX_AUDIO_BYTES) != line["checksumSha256"]:
            _invalid("COMPOSE_INPUT_INVALID")
        probed = _probe(path)
        if probed["video"] or probed["format"] != "wav" or not probed["audio"] or not str(probed["audio"].get("codec_name") or "").startswith("pcm_"):
            _invalid("COMPOSE_MEDIA_INVALID")
        if abs(probed["duration"] * 1000 - (line["endMs"] - line["startMs"])) > 2:
            _invalid("COMPOSE_SPEECH_DURATION_CHANGED")
        if line["startMs"] / 1000 + probed["duration"] > duration + 0.001:
            _invalid("SPEECH_AUDIO_OVERFLOW")
    if manifest["mix"]["musicAssetId"] is not None:
        music = _file(root, "music.wav")
        if _sha(music, MAX_AUDIO_BYTES) != manifest["mix"]["musicChecksumSha256"]:
            _invalid("COMPOSE_INPUT_INVALID")
        probed = _probe(music)
        if probed["video"] or probed["format"] != "wav" or not probed["audio"] or not str(probed["audio"].get("codec_name") or "").startswith("pcm_"):
            _invalid("COMPOSE_MEDIA_INVALID")
    vtt = _bounded(_file(root, "subtitles.vtt"), MAX_SUBTITLE_BYTES)
    if hashlib.sha256(vtt).hexdigest() != manifest["subtitles"]["checksumSha256"] or vtt != _vtt(manifest["subtitles"]["cues"]).encode("utf-8"):
        _invalid("COMPOSE_SUBTITLE_INVALID")
    font = stage_voice_font(root, "\n".join(line["displayText"] for line in manifest["lines"]), font_path)
    caption_files = _caption_files(root, manifest)
    try:
        completed = _run_tool(command(root, manifest, probed_video["audio"] is not None, caption_files, temporary, duration, font.path), PROFILE["render_timeout_sec"])
        if completed.returncode != 0:
            _invalid("COMPOSE_MEDIA_INVALID")
        probed = _verify_output(temporary, duration, started)
        temporary.replace(output)
    except subprocess.TimeoutExpired as error:
        raise ComposeFailure("COMPOSE_RENDER_TIMEOUT", True) from error
    except OSError as error:
        raise ComposeFailure("COMPOSE_RENDER_IO", True) from error
    finally:
        temporary.unlink(missing_ok=True)
    return {"ok": True, "profileId": PROFILE["id"], "checksumSha256": _sha(output, PROFILE["max_output_bytes"]), "byteSize": output.stat().st_size,
            "durationMs": int(round(probed["duration"] * 1000)), "width": int(probed["video"]["width"]), "height": int(probed["video"]["height"]),
            "elapsedMs": int((time.monotonic() - started) * 1000), "localEncode": measure_local_encode(started), "videoCodec": "h264", "audioCodec": "aac",
            "fontSha256": font.sha256, "fontFamily": font.family, "fontSourceSha256": font.source_sha256, "fontSourceFaceIndex": font.source_face_index,
            "fontStyleVersion": PROFILE["font_style"]}


if __name__ == "__main__":
    raise SystemExit(main())
