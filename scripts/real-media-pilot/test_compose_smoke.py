"""Offline synthetic media; this is NOT evidence of a real model call."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

import pilot


ROOT = Path(__file__).resolve().parents[2]


def command(*args):
    result = subprocess.run(args, capture_output=True, timeout=120, check=False)
    if result.returncode:
        raise AssertionError(result.stderr.decode("utf-8", errors="replace")[-2000:])
    return result.stdout


class ComposeSmoke(unittest.TestCase):
    def test_pilot_pipeline_and_resume_with_fake_api_and_real_ffmpeg(self):
        """Exercise the executable pipeline, without network or provider credentials."""
        with tempfile.TemporaryDirectory(prefix="pilot-whole-offline-") as tmp:
            fixture_dir = Path(tmp) / "fixtures"
            fixture_dir.mkdir()
            run_dir = Path(tmp) / "run"
            run_dir.mkdir()
            command(
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin",
                "-f", "lavfi", "-i", "testsrc2=size=720x1280:rate=25:duration=5",
                "-c:v", "libx264", "-threads", "2", "-pix_fmt", "yuv420p",
                str(fixture_dir / "video.mp4"),
            )
            command(
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin",
                "-i", str(fixture_dir / "video.mp4"), "-frames:v", "1", "-threads", "1",
                str(fixture_dir / "image.png"),
            )
            command(
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin",
                "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
                "-c:a", "pcm_s16le", str(fixture_dir / "audio.wav"),
            )

            class FakeAPI:
                def __init__(self):
                    self.calls = []

                def api(self, method, path, body=None):
                    self.calls.append((method, path))
                    if method == "POST":
                        if path == pilot.TTS_PATH:
                            return {"request_id": "tts-request-1", "output": {"audio": {
                                "url": "http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/audio.wav"}},
                                "usage": {"characters": 20}}
                        kind = "image" if path == pilot.IMAGE_PATH else "video"
                        return {"request_id": kind + "-request-1", "output": {
                            "task_id": kind + "-task-1", "task_status": "PENDING"}}
                    kind = "image" if path.endswith("image-task-1") else "video"
                    output = {"task_id": kind + "-task-1", "task_status": "SUCCEEDED"}
                    url = "https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/"
                    if kind == "image":
                        output["choices"] = [{"message": {"content": [{"image": url + "image.png"}]}}]
                    else:
                        output["video_url"] = url + "video.mp4"
                    return {"output": output, "usage": {"output_image_count": 1} if kind == "image"
                            else {"output_video_duration": 5, "video_count": 1}}

                def download(self, url, destination, maximum):
                    source = fixture_dir / url.rsplit("/", 1)[-1]
                    assert source.stat().st_size <= maximum
                    shutil.copyfile(source, destination)

            transport = FakeAPI()
            pilot.preflight()
            with pilot.run_lock(run_dir):
                evidence = pilot.Runner(run_dir, pilot.make_config(), transport,
                                        allow_paid=True, maximum="2").run()
            self.assertEqual(evidence["technicalProbe"], "passed")
            self.assertEqual(evidence["visualReview"], "pending")
            self.assertEqual(evidence["voiceReview"], "pending")
            self.assertEqual(evidence["cost"]["actualCost"], "unknown")
            self.assertFalse(evidence["productionIntegration"])
            self.assertEqual(sum(method == "POST" for method, _ in transport.calls), 3)
            first_digest = pilot.sha256(run_dir / "output.mp4")
            call_count = len(transport.calls)
            with pilot.run_lock(run_dir):
                resumed = pilot.Runner(run_dir, pilot.make_config(), transport, resume=True).run()
            self.assertEqual(len(transport.calls), call_count, "Completed resume must stay offline")
            self.assertEqual(pilot.sha256(run_dir / "output.mp4"), first_digest)
            self.assertEqual(resumed["inputSha256"], evidence["inputSha256"])
            public = (run_dir / "evidence.json").read_text(encoding="utf-8")
            self.assertNotIn("aliyuncs.com", public)
            self.assertNotIn("Bearer", public)

    def test_existing_renderer_makes_decodable_portrait_video_and_audio(self):
        self.assertIsNotNone(shutil.which("ffmpeg"), "Install FFmpeg for this smoke test")
        self.assertIsNotNone(shutil.which("ffprobe"), "Install ffprobe for this smoke test")
        with tempfile.TemporaryDirectory(prefix="media-pilot-synthetic-") as tmp:
            output_dir = Path(tmp)
            command(
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin",
                "-f", "lavfi", "-i", "testsrc2=size=360x640:rate=25:duration=5",
                "-c:v", "libx264", "-threads", "2", "-pix_fmt", "yuv420p",
                str(output_dir / "video.mp4"),
            )
            command(
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin",
                "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
                "-c:a", "pcm_s16le", str(output_dir / "audio.wav"),
            )
            env = dict(os.environ)
            env.pop("DASHSCOPE_API_KEY", None)
            env["PYTHONPATH"] = str(ROOT / "services/media-worker/src")
            result = subprocess.run(
                [sys.executable, "-m", "media_worker.compose_cli", "--input-dir", tmp,
                 "--output", str(output_dir / "output.mp4")],
                env=env, capture_output=True, timeout=120, check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr.decode("utf-8", errors="replace"))
            receipt = json.loads(result.stdout)
            self.assertTrue(receipt["ok"])
            self.assertEqual((receipt["width"], receipt["height"]), (1080, 1920))
            self.assertEqual((receipt["videoCodec"], receipt["audioCodec"]), ("h264", "aac"))
            self.assertAlmostEqual(receipt["durationMs"], 5000, delta=100)
            self.assertGreater(receipt["byteSize"], 10000)
            probe = json.loads(command(
                "ffprobe", "-v", "error", "-show_streams", "-of", "json",
                str(output_dir / "output.mp4"),
            ))
            self.assertTrue(any(s.get("codec_type") == "audio" for s in probe["streams"]))
            self.assertTrue(any(s.get("avg_frame_rate") == "25/1" for s in probe["streams"]))
            command("ffmpeg", "-v", "error", "-xerror", "-i", str(output_dir / "output.mp4"),
                    "-f", "null", "-")


if __name__ == "__main__":
    unittest.main()
