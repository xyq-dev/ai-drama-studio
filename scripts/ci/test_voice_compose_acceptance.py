"""Pure stdlib tests of the CI gate. No real composition, ffprobe, database or provider is run."""

from __future__ import annotations

import hashlib
import importlib.util
import io
import json
import os
import struct
import sys
import tempfile
import unittest
from copy import deepcopy
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("voice_compose_acceptance_ci", Path(__file__).with_name("run-voice-compose-acceptance.py"))
assert SPEC is not None and SPEC.loader is not None
RUNNER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUNNER)


def _result(*cases):
    class SyntheticCase(unittest.TestCase):
        def __init__(self, identity: str, outcome: str):
            super().__init__("runTest")
            self.identity, self.outcome = identity, outcome

        def id(self):
            return self.identity

        def runTest(self):
            if self.outcome == "skip":
                self.skipTest("Synthetic missing-font skip")
            if self.outcome == "failure":
                self.fail("Synthetic failure")
            if self.outcome == "error":
                raise RuntimeError("Synthetic error")

    if not cases:
        cases = [(RUNNER.REQUIRED_TEST_ID, "success")]
    suite = unittest.TestSuite(SyntheticCase(identity, outcome) for identity, outcome in cases)
    return unittest.TextTestRunner(stream=io.StringIO(), resultclass=RUNNER.EvidenceResult).run(suite)


def _evidence(directory: Path) -> tuple[dict, dict]:
    output = b"synthetic unit-only MP4 fixture; ffprobe is mocked"
    (directory / "voice-output.mp4").write_bytes(output)
    (directory / "voice-proof.png").write_bytes(b"\x89PNG\r\n\x1a\n" + struct.pack(">I", 13) + b"IHDR" + struct.pack(">II", 1080, 1920))
    evidence = {
        "schema": RUNNER.EVIDENCE_SCHEMA,
        "fixture": "Synthetic unit-only metadata",
        "aiVoiceQualityVerified": False,
        "visualReview": "pending",
        "chineseFontGlyphCoverageVerified": True,
        "bottomRegionWhiteGlyphPixels": 800,
        "renderResult": {
            "ok": True, "profileId": "local-ffmpeg-voice-v1", "width": 1080, "height": 1920, "durationMs": 2000,
            "videoCodec": "h264", "audioCodec": "aac", "fontFamily": "Noto Sans CJK SC",
            "fontSha256": "ab" * 32, "fontSourceSha256": "cd" * 32, "fontSourceFaceIndex": 2,
            "fontStyleVersion": "m4-voice-subtitle-style-v1", "byteSize": len(output),
            "checksumSha256": hashlib.sha256(output).hexdigest(),
        },
    }
    (directory / "voice-proof.json").write_text(json.dumps(evidence), encoding="utf-8")
    probed = {
        "streams": [
            {"codec_type": "video", "codec_name": "h264", "width": 1080, "height": 1920, "pix_fmt": "yuv420p", "avg_frame_rate": "25/1", "duration": "2.000000"},
            {"codec_type": "audio", "codec_name": "aac", "sample_rate": "48000", "channels": 2, "duration": "2.000000"},
        ],
        "format": {"format_name": "mov,mp4,m4a,3gp,3g2,mj2", "duration": "2.000000", "size": str(len(output))},
    }
    return evidence, probed


class VoiceComposeAcceptanceRunnerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="voice-ci-unit-")
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.stream = io.StringIO()

    def _main(self, result=None, produce=True, mutate=None):
        probed = {}

        def execute(_repo, _stream):
            if produce:
                evidence, metadata = _evidence(self.directory)
                probed.update(metadata)
                if mutate:
                    mutate(evidence, probed)
                    (self.directory / "voice-proof.json").write_text(json.dumps(evidence), encoding="utf-8")
            return _result() if result is None else result

        with patch.object(RUNNER, "execute_tests", side_effect=execute) as tests, patch.object(RUNNER, "probe_media", side_effect=lambda _path: probed) as probe:
            code = RUNNER.main({"VOICE_COMPOSE_TEST_EVIDENCE_DIR": str(self.directory)}, self.directory / "fake-repo", self.stream)
        summary = json.loads((self.directory / "test-summary.json").read_text(encoding="utf-8"))
        return code, summary, tests, probe

    def test_success_requires_the_real_cjk_test_id_and_independent_retained_media_checks(self):
        code, summary, tests, probe = self._main()
        self.assertEqual(code, 0)
        self.assertTrue(summary["ok"])
        self.assertEqual(summary["schema"], RUNNER.SUMMARY_SCHEMA)
        self.assertTrue(summary["tests"]["requiredTestSucceeded"])
        self.assertIn(RUNNER.REQUIRED_TEST_ID, summary["tests"]["successIds"])
        self.assertEqual(summary["tests"]["skipped"], [])
        self.assertEqual(summary["evidence"]["font"]["fontSourceFaceIndex"], 2)
        self.assertEqual(summary["evidence"]["output"]["video"]["width"], 1080)
        tests.assert_called_once()
        probe.assert_called_once_with(self.directory / "voice-output.mp4")

    def test_any_skipped_case_fails_even_if_the_required_render_case_succeeded(self):
        result = _result((RUNNER.REQUIRED_TEST_ID, "success"), ("test_voice_compose.Other.skipped", "skip"))
        code, summary, _, _ = self._main(result)
        self.assertEqual(code, 1)
        self.assertFalse(summary["ok"])
        self.assertEqual(summary["tests"]["skipped"], [{"id": "test_voice_compose.Other.skipped", "reason": "Synthetic missing-font skip"}])

    def test_skipped_required_render_case_cannot_pass_with_old_looking_successful_metadata(self):
        code, summary, _, _ = self._main(_result((RUNNER.REQUIRED_TEST_ID, "skip")))
        self.assertEqual(code, 1)
        self.assertFalse(summary["tests"]["requiredTestSucceeded"])
        self.assertTrue(summary["evidence"]["ok"])

    def test_required_render_case_must_actually_be_collected_and_succeed(self):
        code, summary, _, _ = self._main(_result(("test_voice_compose.Other.passes", "success")))
        self.assertEqual(code, 1)
        self.assertFalse(summary["tests"]["requiredTestSucceeded"])

    def test_records_success_failure_error_and_skip_ids_without_executing_real_media_tests(self):
        result = _result((RUNNER.REQUIRED_TEST_ID, "success"), ("unit.fail", "failure"), ("unit.error", "error"), ("unit.skip", "skip"))
        code, summary, _, _ = self._main(result)
        self.assertEqual(code, 1)
        self.assertEqual(summary["tests"]["testsRun"], 4)
        self.assertEqual(summary["tests"]["failures"][0]["id"], "unit.fail")
        self.assertEqual(summary["tests"]["errors"][0]["id"], "unit.error")
        self.assertEqual(summary["tests"]["skipped"][0]["id"], "unit.skip")
        self.assertTrue((self.directory / "test-summary.json").is_file())

    def test_missing_evidence_fails_and_keeps_the_test_summary(self):
        code, summary, _, probe = self._main(produce=False)
        self.assertEqual(code, 1)
        self.assertEqual(len(summary["evidence"]["problems"]), 3)
        probe.assert_not_called()

    def test_a_preexisting_artifact_refuses_execution_so_stale_evidence_cannot_pass(self):
        _evidence(self.directory)
        with patch.object(RUNNER, "execute_tests") as tests, patch.object(RUNNER, "probe_media") as probe:
            code = RUNNER.main({"VOICE_COMPOSE_TEST_EVIDENCE_DIR": str(self.directory)}, self.directory, self.stream)
        self.assertEqual(code, 1)
        tests.assert_not_called()
        probe.assert_not_called()
        summary = json.loads((self.directory / "test-summary.json").read_text())
        self.assertIn("stale artifacts", summary["problems"][0])

    def test_import_or_runner_errors_still_preserve_a_failure_summary(self):
        with patch.object(RUNNER, "execute_tests", side_effect=ImportError("synthetic module failure")):
            code = RUNNER.main({"VOICE_COMPOSE_TEST_EVIDENCE_DIR": str(self.directory)}, self.directory, self.stream)
        self.assertEqual(code, 1)
        self.assertIn("ImportError", json.loads((self.directory / "test-summary.json").read_text())["problems"][0])

    def test_missing_or_relative_evidence_directory_refuses_before_loading_any_tests(self):
        for env in ({}, {"VOICE_COMPOSE_TEST_EVIDENCE_DIR": "relative-evidence"}):
            with self.subTest(env=env), patch.object(RUNNER, "execute_tests") as tests:
                self.assertEqual(RUNNER.main(env, self.directory, self.stream), 2)
                tests.assert_not_called()
        self.assertFalse((self.directory / "test-summary.json").exists())

    def test_requires_font_provenance_real_chinese_glyph_coverage_and_unreviewed_fixture_claims(self):
        original, probed = _evidence(self.directory)
        mutations = [
            lambda item: item.update(schema="old-schema"),
            lambda item: item.update(chineseFontGlyphCoverageVerified=False),
            lambda item: item.update(bottomRegionWhiteGlyphPixels=300),
            lambda item: item.update(bottomRegionWhiteGlyphPixels=True),
            lambda item: item.update(aiVoiceQualityVerified=True),
            lambda item: item.update(visualReview="approved"),
            lambda item: item["renderResult"].update(fontFamily="Noto Sans CJK JP"),
            lambda item: item["renderResult"].update(fontSha256="missing"),
            lambda item: item["renderResult"].update(fontSourceSha256="missing"),
            lambda item: item["renderResult"].update(fontSourceFaceIndex=-1),
            lambda item: item["renderResult"].update(fontSourceFaceIndex=True),
            lambda item: item["renderResult"].update(fontStyleVersion="legacy"),
        ]
        for mutate in mutations:
            item = deepcopy(original)
            mutate(item)
            (self.directory / "voice-proof.json").write_text(json.dumps(item), encoding="utf-8")
            with self.subTest(mutation=mutations.index(mutate)), patch.object(RUNNER, "probe_media", return_value=probed):
                self.assertFalse(RUNNER.validate_evidence(self.directory)["ok"])

    def test_independently_checks_actual_mp4_streams_fps_audio_channels_and_duration(self):
        _, original = _evidence(self.directory)
        mutations = [
            lambda item: item["streams"][0].update(codec_name="mpeg4"),
            lambda item: item["streams"][0].update(width=720),
            lambda item: item["streams"][0].update(height=1280),
            lambda item: item["streams"][0].update(pix_fmt="yuv444p"),
            lambda item: item["streams"][0].update(avg_frame_rate="0/0"),
            lambda item: item["streams"][0].update(duration="1.0"),
            lambda item: item["streams"][1].update(codec_name="mp3"),
            lambda item: item["streams"][1].update(sample_rate="44100"),
            lambda item: item["streams"][1].update(channels=1),
            lambda item: item["streams"][1].update(duration="nan"),
            lambda item: item["format"].update(format_name="matroska"),
            lambda item: item["format"].update(duration="inf"),
            lambda item: item["format"].update(size="123456"),
            lambda item: item["streams"].append({"codec_type": "subtitle"}),
        ]
        for mutate in mutations:
            item = deepcopy(original)
            mutate(item)
            with self.subTest(mutation=mutations.index(mutate)), patch.object(RUNNER, "probe_media", return_value=item):
                self.assertFalse(RUNNER.validate_evidence(self.directory)["ok"])

    def test_retained_media_bytes_must_match_the_renderer_checksum_size_and_png_dimensions(self):
        _, probed = _evidence(self.directory)
        (self.directory / "voice-output.mp4").write_bytes(b"changed output")
        (self.directory / "voice-proof.png").write_bytes(b"not-a-png")
        with patch.object(RUNNER, "probe_media", return_value=probed):
            checked = RUNNER.validate_evidence(self.directory)
        self.assertFalse(checked["ok"])
        self.assertTrue(any("checksum" in message for message in checked["problems"]))
        self.assertTrue(any("PNG" in message for message in checked["problems"]))

    def test_probe_failure_is_not_treated_as_verified_output(self):
        _evidence(self.directory)
        with patch.object(RUNNER, "probe_media", side_effect=RUNNER.AcceptanceFailure("synthetic probe refusal")):
            checked = RUNNER.validate_evidence(self.directory)
        self.assertFalse(checked["ok"])
        self.assertTrue(any("probe refusal" in message for message in checked["problems"]))

    def test_loader_adds_only_the_media_paths_and_loads_only_the_named_module(self):
        repo = self.directory / "repo"
        tests = repo / "services/media-worker/tests"
        source = repo / "services/media-worker/src"
        tests.mkdir(parents=True)
        source.mkdir()
        (tests / "test_voice_compose.py").write_text("import unittest\nclass VoiceComposeTests(unittest.TestCase):\n def test_render_sentences_pauses_ducking(self): pass\n", encoding="utf-8")
        (tests / "test_unrelated.py").write_text("raise AssertionError('must not be imported')\n", encoding="utf-8")
        previous = sys.modules.get(RUNNER.MODULE_NAME)
        try:
            with patch.object(sys, "path", list(sys.path)):
                suite = RUNNER.load_voice_suite(repo)
                self.assertIn(str(source), sys.path)
                self.assertIn(str(tests), sys.path)
                self.assertEqual([test.id() for test in suite._tests[0]], [RUNNER.REQUIRED_TEST_ID])
        finally:
            if previous is None:
                sys.modules.pop(RUNNER.MODULE_NAME, None)
            else:
                sys.modules[RUNNER.MODULE_NAME] = previous

    def test_probe_command_is_bounded_and_never_uses_a_shell(self):
        completed = type("Completed", (), {"returncode": 0, "stdout": '{"streams": [], "format": {}}'})()
        with patch.object(RUNNER.subprocess, "run", return_value=completed) as run:
            self.assertEqual(RUNNER.probe_media(self.directory / "voice-output.mp4"), {"streams": [], "format": {}})
        args, kwargs = run.call_args
        self.assertEqual(args[0][0], "ffprobe")
        self.assertEqual(kwargs["timeout"], 30)
        self.assertNotIn("shell", kwargs)

    def test_evidence_environment_is_restored_after_the_synthetic_test_run(self):
        with patch.dict(os.environ, {"VOICE_COMPOSE_TEST_EVIDENCE_DIR": "original-parent-value"}):
            code, _, _, _ = self._main()
            self.assertEqual(code, 0)
            self.assertEqual(os.environ["VOICE_COMPOSE_TEST_EVIDENCE_DIR"], "original-parent-value")


if __name__ == "__main__":
    unittest.main()
