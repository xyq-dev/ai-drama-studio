"""Offline contract and recovery checks. No model, HTTP, or FFmpeg is called."""
import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import pilot


URL = "https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/result/example?Expires=1&Signature=private"


def fake_probe(path):
    name = path.name.removesuffix(".download")
    values = {"duration": 5.0, "width": 720, "height": 1280,
              "videoCodec": "h264", "audioCodec": "", "format": "mov,mp4,m4a,3gp,3g2,mj2"}
    if name == "image.png":
        values.update(duration=0, videoCodec="png", format="png_pipe")
    elif name == "audio.wav":
        values.update(duration=2.0, width=0, height=0, videoCodec="", audioCodec="pcm_s16le", format="wav")
    elif name == "output.mp4":
        values.update(width=1080, height=1920, audioCodec="aac")
    return values


def fake_compose(root):
    (root / "output.mp4").write_bytes(b"composed")


class FakeTransport:
    def __init__(self):
        self.calls = []
        self.downloads = []
        self.fail_post = None
        self.fail_get = False
        self.fail_download = False
        self.task_status = "SUCCEEDED"
        self.wrong_task = False

    def api(self, method, path, body=None):
        self.calls.append((method, path, body))
        if method == "POST":
            if path == self.fail_post:
                raise TimeoutError("secret-token Authorization Signature=do-not-print")
            if path == pilot.TTS_PATH:
                return {"output": {"audio": {"url": URL}}, "request_id": "tts-request",
                        "usage": {"characters": 22, "secret": "not allowed"}}
            return {"output": {"task_id": "image-task" if path == pilot.IMAGE_PATH else "video-task"},
                    "request_id": "submit-request"}
        if self.fail_get:
            raise TimeoutError("private URL")
        task_id = path.removeprefix(pilot.TASK_PATH)
        output = {"task_id": "wrong" if self.wrong_task else task_id, "task_status": self.task_status}
        if task_id == "image-task":
            output["choices"] = [{"message": {"content": [{"image": URL}]}}]
        else:
            output["video_url"] = URL
        return {"output": output, "request_id": "poll-request",
                "usage": {"video_duration": 5, "image_count": 1, "secret": "not allowed"}}

    def download(self, url, destination, maximum):
        self.downloads.append((url, destination.name, maximum))
        if self.fail_download:
            raise TimeoutError("Signature=do-not-print")
        destination.write_bytes(destination.name.encode())


class Clock:
    def __init__(self):
        self.now = 0

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds


class PilotTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.config = pilot.make_config()
        self.transport = FakeTransport()

    def runner(self, **kwargs):
        defaults = {"allow_paid": True, "maximum": "1.00", "probe_media": fake_probe,
                    "compose_media": fake_compose}
        defaults.update(kwargs)
        return pilot.Runner(self.root, self.config, self.transport, **defaults)

    def test_plan_is_default_and_has_no_network_or_files(self):
        with patch.object(pilot, "DashScopeTransport", side_effect=AssertionError("network")), \
                patch.object(pilot, "preflight", side_effect=AssertionError("preflight")), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(pilot.main([]), 0)
        data = json.loads(output.getvalue())
        self.assertEqual(data["paidRequests"], 0)
        self.assertEqual(data["estimatedCost"]["actualCost"], "unknown")
        self.assertEqual(list(self.root.iterdir()), [])

    def test_estimate_uses_decimal_and_conservative_chinese_billing(self):
        value = pilot.estimate(self.config)
        self.assertEqual(value["ttsBilledCharactersUpperBound"], len(pilot.DEFAULT_NARRATION) * 2)
        self.assertEqual(value["total"], "0.93176")
        self.assertFalse(value["providerSpendingLimit"])

    def test_paid_gate_rejects_missing_or_invalid_authorization_before_post(self):
        for allow, cap in [(False, "1"), (True, None), (True, "NaN"), (True, "Infinity"),
                           (True, "0.1"), (True, "-1"), (True, "")]:
            with self.subTest(allow=allow, cap=cap), self.assertRaises(pilot.PilotError):
                pilot.check_paid_gate(self.config, allow, cap)
        runner = self.runner(allow_paid=False)
        with self.assertRaises(pilot.PilotError):
            runner.run()
        self.assertEqual(self.transport.calls, [])
        self.assertEqual(runner.state["stages"]["image"]["status"], "PENDING")

    def test_full_contract_then_completed_resume_performs_no_network(self):
        runner = self.runner()
        evidence = runner.run()
        posts = [call for call in self.transport.calls if call[0] == "POST"]
        self.assertEqual(len(posts), 3)
        self.assertEqual(posts[0][1:3], (pilot.IMAGE_PATH, self.config["image"]))
        self.assertTrue(posts[1][2]["input"]["img_url"].startswith("data:image/png;base64,"))
        self.assertFalse(posts[1][2]["parameters"]["audio"])
        self.assertEqual(posts[2][1:3], (pilot.TTS_PATH, self.config["tts"]))
        self.assertEqual(evidence["visualReview"], "pending")
        self.assertEqual(evidence["voiceReview"], "pending")
        self.assertEqual(evidence["cost"]["actualCost"], "unknown")
        self.assertEqual(evidence["providerRecords"]["image"]["taskId"], "image-task")
        self.assertEqual(evidence["providerRecords"]["tts"]["submissionRequestId"], "tts-request")
        self.assertNotIn("secret", json.dumps(evidence))
        self.assertNotIn("Signature", (self.root / "state.json").read_text())
        self.transport.calls.clear()
        self.transport.downloads.clear()
        self.runner(resume=True, allow_paid=False).run()
        self.assertEqual(self.transport.calls, [])
        self.assertEqual(self.transport.downloads, [])

    def test_submission_intent_is_saved_before_any_post(self):
        original = self.transport.api

        def checked(method, path, body=None):
            if method == "POST":
                name = {pilot.IMAGE_PATH: "image", pilot.VIDEO_PATH: "video", pilot.TTS_PATH: "tts"}[path]
                state = json.loads((self.root / "state.json").read_text())
                self.assertEqual(state["stages"][name]["status"], "SUBMITTING")
            return original(method, path, body)

        self.transport.api = checked
        self.runner().run()

    def test_unknown_submission_is_never_reposted_and_error_is_redacted(self):
        self.transport.fail_post = pilot.IMAGE_PATH
        with self.assertRaises(pilot.PilotError) as error:
            self.runner().run()
        self.assertNotIn("secret", str(error.exception))
        self.assertEqual(len(self.transport.calls), 1)
        self.transport.fail_post = None
        with self.assertRaisesRegex(pilot.PilotError, "SUBMISSION_UNKNOWN"):
            self.runner(resume=True).run()
        self.assertEqual(len(self.transport.calls), 1)
        self.assertNotIn("secret", (self.root / "state.json").read_text())

    def test_submitting_after_process_interruption_does_not_post(self):
        runner = self.runner()
        runner.state["stages"]["image"]["status"] = "SUBMITTING"
        runner.save()
        with self.assertRaisesRegex(pilot.PilotError, "SUBMISSION_UNKNOWN"):
            self.runner(resume=True).run()
        self.assertEqual(self.transport.calls, [])

    def test_pending_task_timeout_resume_only_polls_same_id(self):
        clock = Clock()
        self.transport.task_status = "RUNNING"
        runner = self.runner(clock=clock, sleep=clock.sleep, poll_timeout=20)
        with self.assertRaisesRegex(pilot.PilotError, "STILL_WAITING"):
            runner.run()
        self.assertEqual(runner.state["stages"]["image"]["taskId"], "image-task")
        self.assertEqual(clock.now, 20)
        self.transport.task_status = "SUCCEEDED"
        start = len(self.transport.calls)
        self.runner(resume=True).run()
        self.assertEqual(self.transport.calls[start][:2], ("GET", pilot.TASK_PATH + "image-task"))
        self.assertEqual(sum(method == "POST" and path == pilot.IMAGE_PATH
                             for method, path, _ in self.transport.calls), 1)

    def test_poll_transport_failure_leaves_waiting_and_no_new_post(self):
        self.transport.fail_get = True
        with self.assertRaisesRegex(pilot.PilotError, "POLL_FAILED"):
            self.runner().run()
        self.transport.fail_get = False
        self.runner(resume=True).run()
        self.assertEqual(sum(call[:2] == ("POST", pilot.IMAGE_PATH) for call in self.transport.calls), 1)

    def test_remote_unknown_keeps_task_and_resume_queries(self):
        self.transport.task_status = "UNKNOWN"
        with self.assertRaisesRegex(pilot.PilotError, "TASK_UNKNOWN"):
            self.runner().run()
        state = json.loads((self.root / "state.json").read_text())
        self.assertEqual(state["stages"]["image"], {"status": "UNKNOWN", "taskId": "image-task",
            "submissionRequestId": "submit-request", "lastQueryRequestId": "poll-request",
            "reportedUsage": {"image_count": 1, "video_duration": 5}})
        self.transport.task_status = "SUCCEEDED"
        start = len(self.transport.calls)
        self.runner(resume=True).run()
        self.assertEqual(self.transport.calls[start][0], "GET")

    def test_terminal_failure_is_not_resubmitted(self):
        self.transport.task_status = "FAILED"
        with self.assertRaises(pilot.PilotError):
            self.runner().run()
        count = len(self.transport.calls)
        with self.assertRaisesRegex(pilot.PilotError, "NO_AUTOMATIC_RESUBMISSION"):
            self.runner(resume=True).run()
        self.assertEqual(len(self.transport.calls), count)

    def test_poll_response_task_identity_must_match(self):
        self.transport.wrong_task = True
        with self.assertRaisesRegex(pilot.PilotError, "TASK_ID_MISMATCH"):
            self.runner().run()
        self.assertEqual(self.transport.downloads, [])

    def test_tts_lost_response_is_not_submitted_again(self):
        self.transport.fail_post = pilot.TTS_PATH
        with self.assertRaises(pilot.PilotError):
            self.runner().run()
        count = len(self.transport.calls)
        self.transport.fail_post = None
        with self.assertRaisesRegex(pilot.PilotError, "TTS_RESULT_UNKNOWN"):
            self.runner(resume=True).run()
        self.assertEqual(len(self.transport.calls), count)

    def test_tts_download_failure_is_not_submitted_again(self):
        original = self.transport.download

        def fail_audio(url, destination, maximum):
            if destination.name == "audio.wav.download":
                raise TimeoutError("secret signed url")
            original(url, destination, maximum)

        self.transport.download = fail_audio
        with self.assertRaisesRegex(pilot.PilotError, "TTS_DELIVERY_UNKNOWN"):
            self.runner().run()
        count = len(self.transport.calls)
        with self.assertRaises(pilot.PilotError):
            self.runner(resume=True).run()
        self.assertEqual(len(self.transport.calls), count)

    def test_long_text_rejected_before_any_files_or_network(self):
        with self.assertRaisesRegex(pilot.PilotError, "NARRATION"):
            pilot.make_config(narration="字" * 19)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_audio_longer_than_video_is_rejected_before_compose(self):
        def long_probe(path):
            result = fake_probe(path)
            if path.name == "audio.wav.download":
                result["duration"] = 5.01
            return result

        with self.assertRaisesRegex(pilot.PilotError, "TTS_DELIVERY_UNKNOWN"):
            self.runner(probe_media=long_probe).run()
        self.assertFalse((self.root / "output.mp4").exists())

    def test_changed_input_is_rejected_on_resume(self):
        self.runner()
        self.config = pilot.make_config(narration="她发现了信封。")
        with self.assertRaisesRegex(pilot.PilotError, "FROZEN_CONFIG_MISMATCH"):
            self.runner(resume=True)
        self.assertEqual(self.transport.calls, [])

    def test_changed_asset_sha_is_rejected_on_resume(self):
        self.runner().run()
        (self.root / "image.png").write_bytes(b"changed")
        with self.assertRaisesRegex(pilot.PilotError, "SHA_CHANGED"):
            self.runner(resume=True)

    def test_recorded_asset_before_status_save_recovers_without_redownload(self):
        runner = self.runner()
        runner.run()
        runner.state["stages"]["image"]["status"] = "WAITING"
        runner.state["stages"]["tts"]["status"] = "SUBMITTING"
        runner.save()
        self.transport.calls.clear()
        self.transport.downloads.clear()
        self.runner(resume=True).run()
        self.assertEqual(self.transport.calls, [])
        self.assertEqual(self.transport.downloads, [])

    def test_unrecorded_asset_requires_manual_check(self):
        self.runner()
        (self.root / "image.png").write_bytes(b"not accounted")
        with self.assertRaisesRegex(pilot.PilotError, "UNRECORDED_ARTIFACT"):
            self.runner(resume=True)

    def test_exclusive_lock_refuses_second_owner_and_releases(self):
        with pilot.run_lock(self.root):
            with self.assertRaisesRegex(pilot.PilotError, "RUN_LOCK_EXISTS"):
                with pilot.run_lock(self.root):
                    self.fail("acquired twice")
            self.assertTrue((self.root / "run.lock").exists())
        self.assertFalse((self.root / "run.lock").exists())

    def test_git_worktree_output_is_rejected(self):
        (self.root / ".git").write_text("gitdir: elsewhere")
        with self.assertRaisesRegex(pilot.PilotError, "OUTSIDE_ANY_GIT"):
            pilot.output_path(self.root / "nested" / "run")

    def test_missing_key_does_not_create_unknown_submission(self):
        runner = self.runner()
        runner.transport = pilot.DashScopeTransport("")
        with self.assertRaisesRegex(pilot.PilotError, "API_KEY_REQUIRED"):
            runner.run()
        self.assertEqual(runner.state["stages"]["image"]["status"], "PENDING")


class FakeOpener:
    def __init__(self, content):
        self.content = content
        self.requests = []

    def open(self, request, timeout):
        self.requests.append(request)
        return io.BytesIO(self.content)


class DownloadTransportTests(unittest.TestCase):
    def test_http_official_url_upgrades_without_losing_signature(self):
        self.assertEqual(pilot.safe_download_url(URL.replace("https:", "http:")), URL)
        for region in ("bj.oss-cn-beijing", "sh.oss-cn-shanghai", "sz.oss-cn-shenzhen"):
            self.assertTrue(pilot.safe_download_url("https://dashscope-result-" + region + ".aliyuncs.com/a"))

    def test_disallowed_urls_are_rejected(self):
        urls = ["https://example.com/x", "http://127.0.0.1/x", "file:///tmp/a", "https://aliyuncs.com/x",
                URL.replace("aliyuncs.com", "aliyuncs.com.evil.example"),
                URL.replace("https://", "https://user:password@"), URL + "#fragment",
                URL.replace(".com/", ".com:8443/")]
        for url in urls:
            with self.subTest(url=url), self.assertRaisesRegex(pilot.PilotError, "UNTRUSTED"):
                pilot.safe_download_url(url)

    def test_api_key_only_sent_to_fixed_api_not_download_host(self):
        opener = FakeOpener(b'{"output":{"task_id":"task"}}')
        transport = pilot.DashScopeTransport("private-key", opener)
        transport.api("POST", pilot.IMAGE_PATH, {})
        api_request = opener.requests[0]
        self.assertEqual(api_request.full_url, pilot.API_HOST + pilot.IMAGE_PATH)
        self.assertEqual(api_request.get_header("Authorization"), "Bearer private-key")
        self.assertEqual(api_request.get_header("X-dashscope-async"), "enable")
        with tempfile.TemporaryDirectory() as folder:
            destination = Path(folder) / "image"
            transport.download(URL.replace("https:", "http:"), destination, 1000)
        request = opener.requests[1]
        self.assertEqual(request.full_url, URL)
        self.assertIsNone(request.get_header("Authorization"))
        self.assertNotIn("private-key", repr(request.header_items()))

    def test_redirect_is_refused_even_to_other_official_host(self):
        with self.assertRaisesRegex(pilot.PilotError, "REDIRECT_REFUSED"):
            pilot.NoRedirect().redirect_request(None, None, 302, "", {}, URL)

    def test_download_limit_cleans_only_own_partial_file(self):
        transport = pilot.DashScopeTransport("secret", FakeOpener(b"x" * 10))
        with tempfile.TemporaryDirectory() as folder:
            destination = Path(folder) / "image"
            with self.assertRaises(pilot.PilotError):
                transport.download(URL, destination, 5)
            self.assertFalse(destination.exists())
            destination.write_bytes(b"existing")
            with self.assertRaises(pilot.PilotError):
                transport.download(URL, destination, 20)
            self.assertEqual(destination.read_bytes(), b"existing")

    def test_api_path_injection_is_rejected_before_network(self):
        opener = FakeOpener(b"{}")
        transport = pilot.DashScopeTransport("key", opener)
        with self.assertRaises(pilot.PilotError):
            transport.api("GET", "https://evil.example/")
        with self.assertRaises(pilot.PilotError):
            transport.api("GET", pilot.TASK_PATH + "../../credentials")
        self.assertEqual(opener.requests, [])


if __name__ == "__main__":
    unittest.main()
