import contextlib
import hashlib
import io
import json
import math
import os
import shutil
import struct
import tempfile
import unittest
import subprocess
from copy import deepcopy
from pathlib import Path
from unittest.mock import patch

from media_worker.voice_compose import PROFILE, _caption_files, _caption_text, _ducking_expression, _vtt, command, main, validate_manifest
from media_worker.compose_cli import ComposeFailure
from media_worker.compose_cli import _run_tool
from media_worker.voice_font import FAMILY, _checksum, _families, _standalone, _tables, find_voice_font, select_font_face, stage_voice_font

needs_ffmpeg = unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "ffmpeg is required")


def _id(number: int) -> str:
    return f"00000000-0000-4000-8000-{number:012d}"


def _run(args: list[str]) -> bytes:
    result = subprocess.run(args, capture_output=True, check=False)
    assert result.returncode == 0, result.stderr.decode("utf-8", errors="replace")
    return result.stdout


def _tone(path: Path, duration: str, frequency: int) -> None:
    _run(["ffmpeg", "-hide_banner", "-y", "-f", "lavfi", "-i", f"sine=frequency={frequency}:sample_rate=48000:duration={duration}", "-c:a", "pcm_s16le", str(path)])


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _manifest() -> dict:
    lines = []
    for index, (start, end, pause) in enumerate([(0, 250, 500), (750, 1000, 200)]):
        lines.append({"lineId": _id(10 + index), "lineInputRevisionId": _id(20 + index), "voiceRevisionId": _id(30 + index),
                      "selectionId": _id(40 + index), "takeAssetId": _id(50 + index), "checksumSha256": "b" * 64,
                      "startMs": start, "endMs": end, "pauseAfterMs": pause,
                      "displayText": "Keep {braces} <b>text</b> \\N 100%" if index == 0 else "Second voice, full sentence.",
                      "alignmentVersion": "sentence-duration-v1"})
    cues = [{"lineId": line["lineId"], "startMs": line["startMs"], "endMs": line["endMs"], "text": line["displayText"]} for line in lines]
    return {"schema": "voice.shot.mix.v1", "workspaceId": _id(1), "projectId": _id(2), "shotRevisionId": _id(3), "planRevisionId": _id(4),
            "planHash": "a" * 64, "selectionHash": "c" * 64, "videoAssetId": _id(5), "videoChecksumSha256": "d" * 64,
            "videoDurationMs": 2000, "totalSpeechMs": 1200, "lines": lines,
            "subtitles": {"format": "vtt", "alignmentVersion": "sentence-duration-v1", "checksumSha256": hashlib.sha256(_vtt(cues).encode()).hexdigest(), "cues": cues},
            "mix": {"audioOverflow": "reject", "audioUnderflow": "pad-silence", "sampleRate": 48000, "channels": 2,
                    "originalAudio": "mute", "musicAssetId": _id(6), "musicChecksumSha256": "e" * 64, "musicGain": 0.5, "ducking": True}}


def _save(root: Path, manifest: dict) -> None:
    (root / "voice-plan.json").write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
    (root / "subtitles.vtt").write_text(_vtt(manifest["subtitles"]["cues"]), encoding="utf-8", newline="\n")


def _stage(root: Path) -> dict:
    _run(["ffmpeg", "-hide_banner", "-y", "-f", "lavfi", "-i", "color=c=blue:s=160x120:r=25:d=2", "-f", "lavfi", "-i", "sine=frequency=1200:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(root / "video.mp4")])
    _tone(root / "speech-000.wav", "0.25", 440)
    _tone(root / "speech-001.wav", "0.25", 660)
    _tone(root / "music.wav", "2", 880)
    manifest = _manifest()
    manifest["videoChecksumSha256"] = _sha(root / "video.mp4")
    manifest["lines"][0]["checksumSha256"] = _sha(root / "speech-000.wav")
    manifest["lines"][1]["checksumSha256"] = _sha(root / "speech-001.wav")
    manifest["mix"]["musicChecksumSha256"] = _sha(root / "music.wav")
    _save(root, manifest)
    return manifest


def _spectral(samples: list[float], frequency: int, start: float, duration: float = 0.08) -> float:
    start_sample = round(start * 48000)
    span = samples[start_sample:start_sample + round(duration * 48000)]
    real = sum(value * math.cos(2 * math.pi * frequency * index / 48000) for index, value in enumerate(span))
    imaginary = sum(value * math.sin(2 * math.pi * frequency * index / 48000) for index, value in enumerate(span))
    return 2 * math.hypot(real, imaginary) / len(span)


def _check_profile_uses_new_fixed_gain_envelope_and_literal_caption_files(tmp_path: Path) -> None:
    manifest = validate_manifest(_manifest())
    paths = [tmp_path / "voice-caption-000.txt", tmp_path / "voice-caption-001.txt"]
    result = command(tmp_path, manifest, True, paths, tmp_path / "out.mp4", 2)
    graph = result[result.index("-filter_complex") + 1]
    assert "adelay=750:all=1" in graph
    sentence_chains = [chain for chain in graph.split(";") if chain.endswith("[s0]") or chain.endswith("[s1]")]
    assert len(sentence_chains) == 2
    assert all("atrim" not in chain and "apad" not in chain for chain in sentence_chains)
    assert "normalize=0,apad[speech]" in graph
    assert "expansion=none" in graph and "textfile=" in graph
    assert "[0:a]" not in graph
    assert "alimiter=limit=0.95:level=false:latency=true" in graph
    assert "0.050000" in _ducking_expression(manifest["lines"])
    assert "0.200000" in _ducking_expression(manifest["lines"])
    assert PROFILE["ducking_gain"] == 0.2
    manifest["mix"]["originalAudio"] = "confirmed-ambience"
    graph = command(tmp_path, manifest, True, paths, tmp_path / "out.mp4", 2)
    assert "[0:a]" in graph[graph.index("-filter_complex") + 1]
    assert "volume=0.250000" in graph[graph.index("-filter_complex") + 1]
    assert _caption_text(manifest["lines"][0]["displayText"]).replace("\n", "") == manifest["lines"][0]["displayText"]


def _check_silent_shot_has_an_explicit_silent_audio_track(tmp_path: Path) -> None:
    manifest = _manifest()
    manifest["lines"] = []
    manifest["totalSpeechMs"] = 0
    manifest["subtitles"]["cues"] = []
    manifest["subtitles"]["checksumSha256"] = hashlib.sha256(b"WEBVTT\n\n").hexdigest()
    validate_manifest(manifest)
    graph = command(tmp_path, manifest, False, [], tmp_path / "out.mp4", 2)
    assert "anullsrc=r=48000:cl=stereo" in graph[graph.index("-filter_complex") + 1]
    assert "amix=inputs=0" not in graph[graph.index("-filter_complex") + 1]


def _check_manifest_rejects_overlap_overflow_and_disagreeing_cues() -> None:
    for mutate in (
        lambda value: value["lines"][1].update(startMs=200),
        lambda value: value.update(videoDurationMs=1100),
        lambda value: value["subtitles"]["cues"][0].update(text="Missing source words"),
        lambda value: value["mix"].update(audioOverflow="trim-to-video-end"),
        lambda value: value["mix"].update(musicGain=float("nan")),
    ):
        manifest = deepcopy(_manifest())
        mutate(manifest)
        with unittest.TestCase().assertRaises(ComposeFailure):
            validate_manifest(manifest)


def _check_real_render_preserves_sentences_pauses_captions_and_ducks_music(tmp_path: Path, capsys) -> None:
    try:
        real_font = find_voice_font()
        select_font_face(real_font.read_bytes(), "原来，真相一直在这里。我们一起找到答案。")
    except ComposeFailure as error:
        raise unittest.SkipTest("Real Noto Sans CJK SC with the Chinese fixture glyphs is unavailable; Chinese rendering is unverified") from error
    manifest = _stage(tmp_path)
    for line, cue, text in zip(manifest["lines"], manifest["subtitles"]["cues"], ["原来，真相一直在这里。{字} <b>逐字</b> \\N 100%", "我们一起找到答案。"]):
        line["displayText"] = cue["text"] = text
    manifest["subtitles"]["checksumSha256"] = hashlib.sha256(_vtt(manifest["subtitles"]["cues"]).encode()).hexdigest()
    _save(tmp_path, manifest)
    assert main(["--input-dir", str(tmp_path), "--output", str(tmp_path / "output.mp4")]) == 0
    result = json.loads(capsys.readouterr().out)
    assert result["profileId"] == "local-ffmpeg-voice-v1"
    assert result["width"] == 1080 and result["height"] == 1920 and result["durationMs"] == 2000
    assert result["videoCodec"] == "h264" and result["audioCodec"] == "aac"
    assert result["fontFamily"] == FAMILY and len(result["fontSha256"]) == 64
    assert result["fontStyleVersion"] == "m4-voice-subtitle-style-v1"
    assert result["checksumSha256"] == _sha(tmp_path / "output.mp4")
    assert (tmp_path / "subtitles.vtt").read_text() == _vtt(manifest["subtitles"]["cues"])
    assert (tmp_path / "voice-caption-000.txt").read_text().replace("\n", "") == manifest["lines"][0]["displayText"]
    _assert_actual_sentence_audio(tmp_path / "output.mp4")
    _run(["ffmpeg", "-hide_banner", "-v", "error", "-ss", "0.12", "-i", str(tmp_path / "output.mp4"), "-frames:v", "1", str(tmp_path / "voice-proof.png")])
    proof = tmp_path / "voice-proof.png"
    assert proof.stat().st_size > 0
    region = _run(["ffmpeg", "-hide_banner", "-v", "error", "-i", str(proof), "-vf", "crop=1000:440:40:1400", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
    assert len(region) == 1000 * 440 * 3
    # The synthetic blue source and black letterboxing contain no white. This
    # proves captions reached the frame; the independently validated SC cmap
    # proves these Chinese codepoints are present rather than missing glyphs.
    white_glyph_pixels = sum(1 for red, green, blue in struct.iter_unpack("BBB", region)
                             if min(red, green, blue) >= 220 and max(red, green, blue) - min(red, green, blue) <= 20)
    assert white_glyph_pixels > 300
    evidence_dir = os.environ.get("VOICE_COMPOSE_TEST_EVIDENCE_DIR")
    if evidence_dir:
        destination = Path(evidence_dir)
        assert destination.is_absolute(), "VOICE_COMPOSE_TEST_EVIDENCE_DIR must be an operator-owned absolute path"
        destination.mkdir(parents=True, exist_ok=True)
        shutil.copy2(proof, destination / "voice-proof.png")
        evidence = {"schema": "voice.compose.test.evidence.v1", "fixture": "Synthetic color video and sine tones; technical rendering only, not AI voice quality",
                    "aiVoiceQualityVerified": False, "visualReview": "pending", "chineseFontGlyphCoverageVerified": True,
                    "bottomRegionWhiteGlyphPixels": white_glyph_pixels, "renderResult": result}
        (destination / "voice-proof.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _assert_actual_sentence_audio(output: Path) -> None:
    raw = _run(["ffmpeg", "-hide_banner", "-v", "error", "-i", str(output), "-map", "0:a", "-f", "f32le", "-ar", "48000", "-ac", "1", "-"])
    samples = list(struct.unpack(f"<{len(raw) // 4}f", raw))
    assert _spectral(samples, 440, 0.12) > 0.03
    assert _spectral(samples, 660, 0.85) > 0.03
    assert _spectral(samples, 440, 0.21, 0.03) > 0.03
    assert _spectral(samples, 660, 0.96, 0.03) > 0.03
    assert _spectral(samples, 440, 0.55) < 0.005
    assert _spectral(samples, 660, 0.55) < 0.005
    assert _spectral(samples, 880, 0.12) < _spectral(samples, 880, 0.55) * 0.4
    assert _spectral(samples, 1200, 1.5) < 0.005
    assert _spectral(samples, 880, 1.6) > 0.015


def _check_actual_audio_mp4_without_caption_evidence(tmp_path: Path) -> None:
    """Exercise the real FFmpeg mix graph, with no claim about Chinese fonts."""
    manifest = _stage(tmp_path)
    output = tmp_path / "audio-mix-proof.mp4"
    # This directly tests the graph builder with captions absent. Production
    # render() always requires stage_voice_font before invoking this command.
    _run(command(tmp_path, manifest, True, [], output, 2))
    probed = json.loads(_run(["ffprobe", "-v", "error", "-print_format", "json", "-show_streams", "-show_format", str(output)]))
    video = next(stream for stream in probed["streams"] if stream["codec_type"] == "video")
    audio = next(stream for stream in probed["streams"] if stream["codec_type"] == "audio")
    assert video["width"] == 1080 and video["height"] == 1920 and video["codec_name"] == "h264"
    assert audio["codec_name"] == "aac" and audio["sample_rate"] == "48000" and audio["channels"] == 2
    assert abs(float(video["duration"]) - 2) < 0.041
    assert abs(float(probed["format"]["duration"]) - 2) < 0.1
    _assert_actual_sentence_audio(output)


def _check_changed_measured_take_or_subtitle_bytes_fail_before_output(tmp_path: Path, capsys) -> None:
    manifest = _stage(tmp_path)
    _tone(tmp_path / "speech-001.wav", "0.4", 660)
    manifest["lines"][1]["checksumSha256"] = _sha(tmp_path / "speech-001.wav")
    _save(tmp_path, manifest)
    assert main(["--work-dir", str(tmp_path)]) == 2
    assert json.loads(capsys.readouterr().err)["code"] == "COMPOSE_SPEECH_DURATION_CHANGED"
    assert not (tmp_path / "output.mp4").exists()
    _tone(tmp_path / "speech-001.wav", "0.25", 660)
    manifest["lines"][1]["checksumSha256"] = _sha(tmp_path / "speech-001.wav")
    _save(tmp_path, manifest)
    (tmp_path / "subtitles.vtt").write_text("WEBVTT\n\n", encoding="utf-8")
    assert main(["--work-dir", str(tmp_path)]) == 2
    assert json.loads(capsys.readouterr().err)["code"] == "COMPOSE_SUBTITLE_INVALID"
    assert not (tmp_path / "output.mp4").exists()


def _check_symlink_input_and_output_paths_are_rejected(tmp_path: Path, capsys) -> None:
    real = tmp_path / "real"
    real.mkdir()
    linked = tmp_path / "linked"
    try:
        linked.symlink_to(real, target_is_directory=True)
    except OSError as error:
        if getattr(error, "winerror", None) == 1314:
            raise unittest.SkipTest("symlink privilege is unavailable")
        raise
    assert main(["--work-dir", str(linked)]) == 2
    assert json.loads(capsys.readouterr().err)["code"] == "COMPOSE_PATH_INVALID"
    outside = tmp_path / "secret.mp4"
    outside.write_bytes(b"secret")
    (real / "output.mp4").symlink_to(outside)
    assert main(["--work-dir", str(real)]) == 2
    assert outside.read_bytes() == b"secret"


def _synthetic_face(family: str, glyphs: dict[int, int]) -> bytes:
    encoded = family.encode("utf-16-be")
    name = struct.pack(">3H6H", 0, 1, 18, 3, 1, 0x0409, 1, len(encoded), 0) + encoded
    groups = b"".join(struct.pack(">3I", point, point, glyph) for point, glyph in sorted(glyphs.items()))
    cmap12 = struct.pack(">HH3I", 12, 0, 16 + len(groups), 0, len(glyphs)) + groups
    cmap = struct.pack(">HHHHI", 0, 1, 3, 10, 12) + cmap12
    return _standalone(b"\0\1\0\0", {b"head": b"\0" * 54, b"maxp": struct.pack(">IH", 0x00005000, 10), b"name": name, b"cmap": cmap})


def _synthetic_ttc(faces: list[bytes]) -> bytes:
    offsets, position = [], 12 + len(faces) * 4
    relocated = []
    for face in faces:
        offsets.append(position)
        moved = bytearray(face)
        count = struct.unpack_from(">H", face, 4)[0]
        for index in range(count):
            record = 12 + index * 16
            location = struct.unpack_from(">I", face, record + 8)[0]
            struct.pack_into(">I", moved, record + 8, location + position)
        relocated.append(bytes(moved))
        position += len(moved)
    return b"ttcf" + struct.pack(">II", 0x00010000, len(faces)) + b"".join(struct.pack(">I", offset) for offset in offsets) + b"".join(relocated)


def _check_explicit_sc_face_and_glyph_coverage(tmp_path: Path) -> None:
    jp = _synthetic_face("Noto Sans CJK JP", {ord("中"): 1, ord("文"): 2})
    sc = _synthetic_face(FAMILY, {ord("中"): 3, ord("文"): 4})
    source = _synthetic_ttc([jp, sc])
    extracted, index = select_font_face(source, "中文")
    assert index == 1
    assert _checksum(extracted) == 0xB1B0AFBA
    assert FAMILY in _families(_tables(extracted, 0)[1][b"name"])
    path = tmp_path / "operator-font.ttc"
    path.write_bytes(source)
    staged = stage_voice_font(tmp_path, "中文", path)
    assert staged.family == FAMILY and staged.source_face_index == 1
    assert staged.path.read_bytes() == extracted
    assert staged.sha256 == hashlib.sha256(extracted).hexdigest()
    for data, text in [(jp, "中文"), (sc, "缺"), (b"invalid-font", "中文")]:
        with unittest.TestCase().assertRaises(ComposeFailure) as failure:
            select_font_face(data, text)
        assert failure.exception.code == "COMPOSE_FONT_UNAVAILABLE"
    with unittest.TestCase().assertRaises(ComposeFailure) as failure:
        stage_voice_font(tmp_path, "中文", tmp_path / "missing-font.otf")
    assert failure.exception.code == "COMPOSE_FONT_UNAVAILABLE"


class _Capture:
    def __init__(self) -> None:
        self.out, self.err = io.StringIO(), io.StringIO()

    def readouterr(self):
        from types import SimpleNamespace
        result = SimpleNamespace(out=self.out.getvalue(), err=self.err.getvalue())
        self.out.seek(0); self.out.truncate(0)
        self.err.seek(0); self.err.truncate(0)
        return result


class VoiceComposeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="voice-compose-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.capture = _Capture()
        self.enterContext(contextlib.redirect_stdout(self.capture.out))
        self.enterContext(contextlib.redirect_stderr(self.capture.err))

    def test_profile_envelope_literal_captions(self) -> None:
        _check_profile_uses_new_fixed_gain_envelope_and_literal_caption_files(self.root)

    def test_adversarial_vtt_and_caption_text_remain_literal(self) -> None:
        raw = "原文 <b>逐字</b> & 保留\r\n\r\n\t \r\n00:00:01.000 --> 00:00:02.000\n{\\pos(20,40)} literal\\N\n%{eif:1+1:d}\n<v speaker>文本</v>\n\n末句\n\n"
        normalized = raw.replace("\r\n", "\n").replace("\r", "\n")
        assert _caption_text(raw) == normalized
        manifest = _manifest()
        manifest["lines"][0]["displayText"] = raw
        manifest["subtitles"]["cues"][0]["text"] = raw
        vtt = _vtt(manifest["subtitles"]["cues"])
        manifest["subtitles"]["checksumSha256"] = hashlib.sha256(vtt.encode()).hexdigest()
        validate_manifest(manifest)
        assert "原文 &lt;b&gt;逐字&lt;/b&gt; &amp; 保留\n\u2060\n\t \u2060\n" in vtt
        assert "00:00:01.000 --&gt; 00:00:02.000" in vtt
        assert "{\\pos(20,40)} literal\\N\n%{eif:1+1:d}" in vtt
        assert "&lt;v speaker&gt;文本&lt;/v&gt;\n\u2060\n末句\n\u2060\n\u2060" in vtt
        assert _vtt([{"startMs": 0, "endMs": 1, "text": "甲\n\ufeff\n\u00a0\n乙"}]).endswith("甲\n\ufeff\n\u00a0\n乙\n")
        paths = _caption_files(self.root, manifest)
        assert paths[0].read_text(encoding="utf-8") == normalized
        result = command(self.root, manifest, True, paths, self.root / "output.mp4", 2)
        graph = result[result.index("-filter_complex") + 1]
        assert graph.count("expansion=none") == len(paths)
        assert all(token not in graph for token in ("逐字", "<b>", "-->", "\\pos", "literal\\N", "%{eif", "<v speaker>"))
        assert all(f"textfile='{path.as_posix()}'" in graph for path in paths)

    def test_silent_shot(self) -> None:
        _check_silent_shot_has_an_explicit_silent_audio_track(self.root)

    def test_invalid_manifest(self) -> None:
        _check_manifest_rejects_overlap_overflow_and_disagreeing_cues()

    @needs_ffmpeg
    def test_render_sentences_pauses_ducking(self) -> None:
        _check_real_render_preserves_sentences_pauses_captions_and_ducks_music(self.root, self.capture)

    @needs_ffmpeg
    def test_actual_audio_mp4_without_caption_evidence(self) -> None:
        _check_actual_audio_mp4_without_caption_evidence(self.root)

    @needs_ffmpeg
    def test_changed_take_subtitles(self) -> None:
        _check_changed_measured_take_or_subtitle_bytes_fail_before_output(self.root, self.capture)

    def test_symlink_boundary(self) -> None:
        _check_symlink_input_and_output_paths_are_rejected(self.root, self.capture)

    def test_sc_font_face_and_coverage(self) -> None:
        _check_explicit_sc_face_and_glyph_coverage(self.root)

    @needs_ffmpeg
    def test_missing_font_blocks_cli(self) -> None:
        _stage(self.root)
        with patch("media_worker.voice_compose._run_tool", wraps=_run_tool) as tool:
            assert main(["--work-dir", str(self.root), "--font-path", str(self.root / "missing-font.otf")]) == 2
        assert all(call.args[0][0] != "ffmpeg" for call in tool.call_args_list)
        assert json.loads(self.capture.readouterr().err)["code"] == "COMPOSE_FONT_UNAVAILABLE"
        assert not (self.root / "output.mp4").exists()


if __name__ == "__main__":
    unittest.main()
