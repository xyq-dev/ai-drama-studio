#!/usr/bin/env python3
"""Opt-in, single-shot DashScope pilot. `plan` is entirely offline.

Only the Python standard library is required. Paid submissions are never retried.
This is an isolated acceptance tool, not a production provider or billing ledger.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from contextlib import contextmanager
from decimal import Decimal, InvalidOperation
from pathlib import Path


API_HOST = "https://dashscope.aliyuncs.com"
IMAGE_PATH = "/api/v1/services/aigc/image-generation/generation"
VIDEO_PATH = "/api/v1/services/aigc/video-generation/video-synthesis"
TTS_PATH = "/api/v1/services/aigc/multimodal-generation/generation"
TASK_PATH = "/api/v1/tasks/"
DEFAULT_IMAGE = (
    "竖屏写实电影画面。一个约三十岁的成年女性，穿深蓝色日常外套，在安静的书房里，"
    "发现木桌上的一封未署名信封。中近景，人物、双手和信封清晰，自然暖光，"
    "克制的惊讶表情。只有一个成年人，没有文字、标志或未成年人。"
)
DEFAULT_VIDEO = (
    "保持参考图中成年人物的外貌、服装和书房一致。一个连续五秒竖屏中近景镜头，"
    "镜头缓慢推进；她低头发现信封，轻轻拿起信封，神情从疑惑变成恍然大悟。"
    "动作自然克制，不切镜，不出现第二个人，不说话。"
)
DEFAULT_NARRATION = "原来，真相一直在这里。"
MAX_NARRATION = 18
LIMITS = {"image.png": 10 * 1024 * 1024, "video.mp4": 100 * 1024 * 1024,
          "audio.wav": 20 * 1024 * 1024}
KNOWN_ASSETS = {*LIMITS, "output.mp4", "narration.txt"}
OSS_HOST = re.compile(r"dashscope-result-[a-z0-9-]+\.oss-cn-[a-z0-9-]+\.aliyuncs\.com\Z")
TASK_ID = re.compile(r"[A-Za-z0-9_-]{1,200}\Z")
STATES = {"PENDING", "SUBMITTING", "UNKNOWN", "WAITING", "FAILED", "COMPLETED"}


class PilotError(Exception):
    """A fixed, safe code; never includes provider errors, headers or URLs."""


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def make_config(image_prompt=DEFAULT_IMAGE, video_prompt=DEFAULT_VIDEO, narration=DEFAULT_NARRATION):
    if not narration.strip() or len(narration) > MAX_NARRATION:
        raise PilotError("NARRATION_MUST_HAVE_1_TO_18_CHARACTERS")
    if any(not text.strip() or len(text) > 1000 for text in (image_prompt, video_prompt)):
        raise PilotError("PROMPT_MUST_HAVE_1_TO_1000_CHARACTERS")
    return {
        "schema": 1, "region": "beijing", "apiHost": API_HOST,
        "image": {"model": "qwen-image-3.0", "input": {"messages": [
            {"role": "user", "content": [{"text": image_prompt}]}]},
            "parameters": {"n": 1, "size": "720*1280", "prompt_extend": False,
                           "watermark": True, "seed": 20261014}},
        "video": {"model": "wan2.6-i2v-flash", "input": {"prompt": video_prompt},
                  "parameters": {"resolution": "720P", "duration": 5, "audio": False,
                                 "prompt_extend": True, "shot_type": "single",
                                 "watermark": True, "seed": 20261014}},
        "tts": {"model": "qwen3-tts-flash", "input": {"text": narration,
                                                        "voice": "Cherry", "language_type": "Chinese"}},
        "prices": {"snapshotDate": "2026-10-14", "currency": "CNY", "image": "0.18",
                   "videoSecond": "0.15", "ttsCharacter": "0.00008"},
    }


def estimate(config):
    # Chinese characters are billed as two; counting EVERY codepoint twice is
    # deliberately conservative, including punctuation, for this short narration.
    characters = 2 * len(config["tts"]["input"]["text"])
    prices = config["prices"]
    image = Decimal(prices["image"])
    video = Decimal(prices["videoSecond"]) * config["video"]["parameters"]["duration"]
    tts = Decimal(prices["ttsCharacter"]) * characters
    return {"status": "ESTIMATED", "currency": "CNY", "total": str(image + video + tts),
            "image": str(image), "video": str(video), "tts": str(tts),
            "ttsBilledCharactersUpperBound": characters, "actualCost": "unknown",
            "providerSpendingLimit": False, "snapshotDate": prices["snapshotDate"]}


def check_paid_gate(config, allow_paid, maximum):
    try:
        cap = Decimal(str(maximum))
    except (InvalidOperation, ValueError):
        raise PilotError("EXPLICIT_FINITE_COST_CAP_REQUIRED") from None
    if not allow_paid:
        raise PilotError("ALLOW_PAID_REQUIRED")
    if not cap.is_finite() or cap <= 0 or cap < Decimal(estimate(config)["total"]):
        raise PilotError("ESTIMATE_EXCEEDS_CAP_OR_CAP_INVALID")


def atomic_json(path, value):
    temporary = path.with_name(path.name + ".tmp")
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
    fd = os.open(temporary, flags, 0o600)
    with os.fdopen(fd, "wb") as target:
        target.write(canonical(value) + b"\n")
        target.flush()
        os.fsync(target.fileno())
    os.replace(temporary, path)
    if os.name != "nt":
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)


def output_path(path):
    root = Path(path).expanduser().resolve()
    if any((parent / ".git").exists() for parent in (root, *root.parents)):
        raise PilotError("OUTPUT_MUST_BE_OUTSIDE_ANY_GIT_WORKTREE")
    return root


@contextmanager
def run_lock(root):
    path = root / "run.lock"
    try:
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        raise PilotError("RUN_LOCK_EXISTS_CHECK_OWNER_BEFORE_MANUAL_REMOVAL") from None
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as lock:
            json.dump({"pid": os.getpid(), "createdUnix": int(time.time())}, lock)
        yield
    finally:
        path.unlink(missing_ok=True)


def safe_download_url(url):
    try:
        parts = urllib.parse.urlsplit(url)
        allowed = (parts.scheme in {"https", "http"} and parts.hostname is not None
                   and OSS_HOST.fullmatch(parts.hostname) and parts.username is None
                   and parts.password is None and parts.port in {None, 443}
                   and not parts.fragment and bool(parts.path))
    except (ValueError, TypeError):
        allowed = False
    if not allowed:
        raise PilotError("UNTRUSTED_DOWNLOAD_URL")
    # Historical official TTS responses use http:// for the same OSS object.
    # Upgrade ONLY an allowlisted host; never make a plaintext request.
    return urllib.parse.urlunsplit(("https", parts.netloc, parts.path, parts.query, ""))


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise PilotError("HTTP_REDIRECT_REFUSED")


class DashScopeTransport:
    def __init__(self, key, opener=None):
        self._key = key
        self._opener = opener or urllib.request.build_opener(NoRedirect())

    def check_ready(self):
        if not self._key or not self._key.strip() or "\n" in self._key or "\r" in self._key:
            raise PilotError("DASHSCOPE_API_KEY_REQUIRED")

    def api(self, method, path, body=None):
        if path not in {IMAGE_PATH, VIDEO_PATH, TTS_PATH} and not (
                method == "GET" and path.startswith(TASK_PATH) and TASK_ID.fullmatch(path[len(TASK_PATH):])):
            raise PilotError("INVALID_API_PATH")
        self.check_ready()
        if method not in {"POST", "GET"}:
            raise PilotError("INVALID_API_METHOD")
        headers = {"Authorization": "Bearer " + self._key, "Content-Type": "application/json"}
        if path in {IMAGE_PATH, VIDEO_PATH}:
            headers["X-DashScope-Async"] = "enable"
        request = urllib.request.Request(API_HOST + path, data=canonical(body) if body is not None else None,
                                         headers=headers, method=method)
        try:
            with self._opener.open(request, timeout=90) as response:
                raw = response.read(1024 * 1024 + 1)
                if len(raw) > 1024 * 1024:
                    raise PilotError("API_RESPONSE_TOO_LARGE")
                result = json.loads(raw)
                if not isinstance(result, dict):
                    raise PilotError("API_RESPONSE_INVALID")
                return result
        except Exception:
            raise PilotError("API_REQUEST_FAILED_RESPONSE_NOT_RECORDED") from None

    def download(self, url, destination, maximum):
        url = safe_download_url(url)
        # A fresh request carries NO DashScope authorization headers.
        request = urllib.request.Request(url, headers={"Accept": "application/octet-stream"}, method="GET")
        start = time.monotonic()
        owned = False
        try:
            with self._opener.open(request, timeout=30) as response, destination.open("xb") as target:
                owned = True
                total = 0
                while True:
                    if time.monotonic() - start > 120:
                        raise PilotError("DOWNLOAD_TIME_LIMIT")
                    block = response.read(64 * 1024)
                    if not block:
                        break
                    total += len(block)
                    if total > maximum:
                        raise PilotError("DOWNLOAD_SIZE_LIMIT")
                    target.write(block)
                if not total:
                    raise PilotError("EMPTY_DOWNLOAD")
        except Exception:
            if owned:
                destination.unlink(missing_ok=True)
            raise PilotError("DOWNLOAD_FAILED_NO_URL_RECORDED") from None


def preflight():
    for executable in ("ffmpeg", "ffprobe"):
        try:
            result = subprocess.run([executable, "-version"], capture_output=True, timeout=15, check=False)
        except (OSError, subprocess.TimeoutExpired):
            raise PilotError("FFMPEG_AND_FFPROBE_REQUIRED_BEFORE_PAID_CALLS") from None
        if result.returncode:
            raise PilotError("FFMPEG_AND_FFPROBE_REQUIRED_BEFORE_PAID_CALLS")
    if not (compose_source() / "media_worker" / "compose_cli.py").is_file():
        raise PilotError("EXISTING_COMPOSE_MODULE_NOT_FOUND")
    try:
        result = subprocess.run([
            "ffmpeg", "-hide_banner", "-nostdin", "-v", "error", "-f", "lavfi", "-i",
            "color=c=black:s=16x16:r=25:d=0.12", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
            "-t", "0.12", "-threads", "1", "-c:v", "libx264", "-c:a", "aac", "-f", "null", "-",
        ], capture_output=True, timeout=20, check=False)
        if result.returncode:
            raise ValueError()
    except (OSError, subprocess.TimeoutExpired, ValueError):
        raise PilotError("LIBX264_AND_AAC_ENCODERS_REQUIRED_BEFORE_PAID_CALLS") from None


def compose_source():
    return Path(__file__).resolve().parents[2] / "services" / "media-worker" / "src"


def probe(path):
    try:
        result = subprocess.run(["ffprobe", "-v", "error", "-protocol_whitelist", "file,pipe",
                                 "-show_streams", "-show_format", "-of", "json", str(path)],
                                capture_output=True, timeout=30, check=False)
        if result.returncode:
            raise ValueError()
        parsed = json.loads(result.stdout)
        streams = parsed.get("streams", [])
        video = next((s for s in streams if s.get("codec_type") == "video"), {})
        audio = next((s for s in streams if s.get("codec_type") == "audio"), {})
        duration = (video or audio).get("duration") or parsed.get("format", {}).get("duration") or "0"
        value = float(duration)
        if not (0 <= value < 600):
            raise ValueError()
        return {"duration": value, "width": int(video.get("width", 0)), "height": int(video.get("height", 0)),
                "videoCodec": str(video.get("codec_name", "")), "audioCodec": str(audio.get("codec_name", "")),
                "format": str(parsed.get("format", {}).get("format_name", ""))}
    except Exception:
        raise PilotError("LOCAL_MEDIA_PROBE_FAILED") from None


def validate_media(name, result, video_duration=None):
    if name == "image.png":
        valid = result["videoCodec"] == "png" and (result["width"], result["height"]) == (720, 1280)
    elif name in {"video.mp4", "output.mp4"}:
        valid = ("mp4" in result["format"].split(",") and result["videoCodec"] == "h264"
                 and 4.8 <= result["duration"] <= 5.2 and result["height"] > result["width"] > 0)
        if name == "output.mp4":
            valid = valid and result["audioCodec"] == "aac" and (result["width"], result["height"]) == (1080, 1920)
    else:
        valid = (result["format"] == "wav" and result["audioCodec"].startswith("pcm_")
                 and video_duration is not None and 0 < result["duration"] <= video_duration)
    if not valid:
        raise PilotError("MEDIA_FORMAT_DURATION_OR_DIMENSIONS_REJECTED_" + name.replace(".", "_").upper())


def compose(root):
    environment = os.environ.copy()
    # The local encoder never needs the API key.
    environment.pop("DASHSCOPE_API_KEY", None)
    environment["PYTHONPATH"] = str(compose_source())
    try:
        result = subprocess.run([sys.executable, "-m", "media_worker.compose_cli", "--input-dir", str(root),
                                 "--output", str(root / "output.mp4")], env=environment,
                                capture_output=True, timeout=360, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise PilotError("LOCAL_COMPOSE_FAILED") from None
    if result.returncode:
        raise PilotError("LOCAL_COMPOSE_FAILED")


class Runner:
    def __init__(self, root, config, transport, *, resume=False, allow_paid=False, maximum=None,
                 probe_media=probe, compose_media=compose, clock=time.monotonic, sleep=time.sleep,
                 poll_timeout=900):
        self.root, self.config, self.transport = root, config, transport
        self.allow_paid, self.maximum = allow_paid, maximum
        self.probe, self.compose = probe_media, compose_media
        self.clock, self.sleep, self.poll_timeout = clock, sleep, poll_timeout
        digest = hashlib.sha256(canonical(config)).hexdigest()
        if resume:
            try:
                self.state = json.loads((root / "state.json").read_text(encoding="utf-8"))
                if self.state["inputSha256"] != digest or self.state["config"] != config:
                    raise PilotError("INPUT_OR_FROZEN_CONFIG_MISMATCH")
                if set(self.state["stages"]) != {"image", "video", "tts"}:
                    raise ValueError()
                for stage in self.state["stages"].values():
                    if stage["status"] not in STATES:
                        raise ValueError()
                    if "taskId" in stage and not TASK_ID.fullmatch(stage["taskId"]):
                        raise ValueError()
                    if stage["status"] == "PENDING" and "taskId" in stage:
                        raise ValueError()
            except PilotError:
                raise
            except Exception:
                raise PilotError("STATE_INVALID") from None
        else:
            if (root / "state.json").exists():
                raise PilotError("STATE_EXISTS_USE_RESUME")
            self.state = {"schema": 1, "inputSha256": digest, "config": config, "estimate": estimate(config),
                          "stages": {key: {"status": "PENDING"} for key in ("image", "video", "tts")},
                          "assets": {}}
            self.save()
            narration = root / "narration.txt"
            with narration.open("x", encoding="utf-8", newline="\n") as target:
                target.write(config["tts"]["input"]["text"] + "\n")
            self.record_asset("narration.txt")
        self.verify_assets()

    def save(self):
        atomic_json(self.root / "state.json", self.state)

    def record_asset(self, name, media=None):
        self.state["assets"][name] = {"sha256": sha256(self.root / name), "bytes": (self.root / name).stat().st_size}
        if media is not None:
            self.state["assets"][name]["probe"] = media
        self.save()

    def verify_assets(self):
        assets = self.state["assets"]
        if not isinstance(assets, dict) or set(assets) - KNOWN_ASSETS:
            raise PilotError("INVALID_ASSET_RECORD")
        for name in KNOWN_ASSETS:
            path = self.root / name
            if name in assets:
                if path.is_symlink() or not path.is_file() or sha256(path) != assets[name]["sha256"]:
                    raise PilotError("ARTIFACT_MISSING_OR_SHA_CHANGED")
            elif path.exists():
                raise PilotError("UNRECORDED_ARTIFACT_REQUIRES_MANUAL_CHECK")

    def accept_download(self, name, url):
        safe_download_url(url)  # enforce even with a test/custom transport
        temporary = self.root / (name + ".download")
        if temporary.exists():
            raise PilotError("PARTIAL_DOWNLOAD_REQUIRES_MANUAL_CHECK")
        try:
            self.transport.download(url, temporary, LIMITS[name])
            if not temporary.is_file() or not 0 < temporary.stat().st_size <= LIMITS[name]:
                raise PilotError("DOWNLOAD_SIZE_INVALID")
            media = self.probe(temporary)
            duration = self.state["assets"].get("video.mp4", {}).get("probe", {}).get("duration")
            validate_media(name, media, duration)
            os.replace(temporary, self.root / name)
            self.record_asset(name, media)
        except BaseException:
            temporary.unlink(missing_ok=True)
            raise

    def submit(self, name, path, body):
        check_paid_gate(self.config, self.allow_paid, self.maximum)
        readiness = getattr(self.transport, "check_ready", None)
        if readiness is not None:
            readiness()  # local configuration failure is not an unknown submission
        stage = self.state["stages"][name]
        stage["status"] = "SUBMITTING"
        self.save()  # commit intent BEFORE the request; no vendor idempotency assumed
        try:
            return self.transport.api("POST", path, body)
        except BaseException:
            stage["status"] = "UNKNOWN"
            self.save()
            raise PilotError("SUBMISSION_UNKNOWN_DO_NOT_RESUBMIT_CHECK_PROVIDER") from None

    def metadata(self, stage, response, phase):
        request_id = response.get("request_id")
        if isinstance(request_id, str) and TASK_ID.fullmatch(request_id):
            stage[phase + "RequestId"] = request_id
        usage = response.get("usage", {})
        if isinstance(usage, dict):
            allowed = {"image_count", "input_image_count", "output_image_count", "image_tokens", "input_tokens",
                       "output_tokens", "total_tokens", "video_duration", "output_video_duration",
                       "input_video_duration", "output_width", "output_height", "video_count",
                       "duration", "seconds", "characters"}
            clean = {}
            for key in allowed & usage.keys():
                value = usage[key]
                if (isinstance(value, (int, float)) and not isinstance(value, bool)
                        and Decimal(str(value)).is_finite() and value >= 0):
                    clean[key] = value
            if clean:
                stage["reportedUsage"] = clean

    def async_stage(self, name, path, body, filename):
        stage = self.state["stages"][name]
        if filename in self.state["assets"] and stage.get("taskId") and stage["status"] != "FAILED":
            # A verified file and its SHA may have been saved just before a crash
            # between record_asset() and the final stage status write.
            stage["status"] = "COMPLETED"
            self.save()
        if stage["status"] == "COMPLETED":
            if filename not in self.state["assets"]:
                raise PilotError("COMPLETED_STAGE_MISSING_ARTIFACT")
            return
        if stage["status"] == "FAILED":
            raise PilotError("PROVIDER_TASK_FAILED_NO_AUTOMATIC_RESUBMISSION")
        if stage["status"] in {"UNKNOWN", "SUBMITTING"} and not stage.get("taskId"):
            raise PilotError("SUBMISSION_UNKNOWN_DO_NOT_RESUBMIT_CHECK_PROVIDER")
        if stage["status"] == "PENDING":
            response = self.submit(name, path, body)
            task_id = response.get("output", {}).get("task_id")
            if not isinstance(task_id, str) or not TASK_ID.fullmatch(task_id):
                stage["status"] = "UNKNOWN"
                self.save()
                raise PilotError("SUBMISSION_UNKNOWN_DO_NOT_RESUBMIT_CHECK_PROVIDER")
            stage.update(status="WAITING", taskId=task_id)
            self.metadata(stage, response, "submission")
            self.save()
        task_id = stage.get("taskId")
        if not task_id:
            raise PilotError("WAITING_TASK_ID_MISSING")
        stage["status"] = "WAITING"
        self.save()
        deadline = self.clock() + self.poll_timeout
        while self.clock() < deadline:
            try:
                response = self.transport.api("GET", TASK_PATH + task_id)
                output = response.get("output", {})
                status = output.get("task_status")
            except Exception:
                raise PilotError("POLL_FAILED_RESUME_WITH_EXISTING_TASK_ID") from None
            if output.get("task_id") != task_id:
                raise PilotError("POLL_TASK_ID_MISMATCH")
            self.metadata(stage, response, "lastQuery")
            self.save()
            if status == "SUCCEEDED":
                try:
                    if name == "image":
                        content = output["choices"][0]["message"]["content"]
                        url = next(item["image"] for item in content if "image" in item)
                    else:
                        url = output["video_url"]
                except (KeyError, IndexError, StopIteration, TypeError):
                    raise PilotError("TASK_RESULT_INVALID_RESUME_OR_CHECK_PROVIDER") from None
                self.accept_download(filename, url)
                stage["status"] = "COMPLETED"
                self.save()
                return
            if status == "UNKNOWN":
                stage["status"] = "UNKNOWN"
                self.save()
                raise PilotError("PROVIDER_TASK_UNKNOWN_RESUME_QUERY_OR_CHECK_PROVIDER")
            if status in {"FAILED", "CANCELED", "CANCELLED"}:
                stage["status"] = "FAILED"
                self.save()
                raise PilotError("PROVIDER_TASK_FAILED_OR_EXPIRED_NO_RESUBMISSION")
            if status not in {"PENDING", "RUNNING"}:
                raise PilotError("UNRECOGNIZED_TASK_STATUS_CHECK_PROVIDER")
            self.sleep(min(10, max(0, deadline - self.clock())))
        raise PilotError("TASK_STILL_WAITING_RESUME_WITH_EXISTING_TASK_ID")

    def tts_stage(self):
        stage = self.state["stages"]["tts"]
        if "audio.wav" in self.state["assets"]:
            stage["status"] = "COMPLETED"
            self.save()
        if stage["status"] == "COMPLETED":
            if "audio.wav" not in self.state["assets"]:
                raise PilotError("COMPLETED_STAGE_MISSING_ARTIFACT")
            return
        if stage["status"] != "PENDING":
            raise PilotError("TTS_RESULT_UNKNOWN_NO_AUTOMATIC_RESUBMISSION")
        response = self.submit("tts", TTS_PATH, self.config["tts"])
        try:
            self.metadata(stage, response, "submission")
            self.accept_download("audio.wav", response["output"]["audio"]["url"])
            used = response.get("usage", {}).get("characters")
            if isinstance(used, int) and not isinstance(used, bool) and used >= 0:
                stage["reportedUsageCharacters"] = used
            stage["status"] = "COMPLETED"
            self.save()
        except BaseException:
            stage["status"] = "UNKNOWN"
            self.save()
            raise PilotError("TTS_DELIVERY_UNKNOWN_NO_AUTOMATIC_RESUBMISSION") from None

    def run(self):
        self.verify_assets()
        self.async_stage("image", IMAGE_PATH, self.config["image"], "image.png")
        self.verify_assets()
        video = json.loads(json.dumps(self.config["video"]))
        video["input"]["img_url"] = "data:image/png;base64," + base64.b64encode((self.root / "image.png").read_bytes()).decode("ascii")
        self.async_stage("video", VIDEO_PATH, video, "video.mp4")
        self.verify_assets()
        self.tts_stage()
        self.verify_assets()
        if "output.mp4" not in self.state["assets"]:
            self.compose(self.root)
            media = self.probe(self.root / "output.mp4")
            validate_media("output.mp4", media)
            self.record_asset("output.mp4", media)
        evidence = {"schema": 1, "inputSha256": self.state["inputSha256"],
                    "models": {key: self.config[key]["model"] for key in ("image", "video", "tts")},
                    "cost": self.state["estimate"], "assets": self.state["assets"],
                    "providerRecords": self.state["stages"],
                    "technicalProbe": "passed", "visualReview": "pending", "voiceReview": "pending",
                    "productionIntegration": False, "subtitles": False, "music": False, "lipSync": False}
        atomic_json(self.root / "evidence.json", evidence)
        return evidence


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", nargs="?", choices=("plan", "run", "resume"), default="plan")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--allow-paid", action="store_true")
    parser.add_argument("--max-estimated-cny")
    parser.add_argument("--image-prompt", default=DEFAULT_IMAGE)
    parser.add_argument("--video-prompt", default=DEFAULT_VIDEO)
    parser.add_argument("--narration", default=DEFAULT_NARRATION)
    args = parser.parse_args(argv)
    try:
        config = make_config(args.image_prompt, args.video_prompt, args.narration)
        if args.command == "plan":
            print(json.dumps({"mode": "offline_plan", "estimatedCost": estimate(config), "config": config,
                              "paidRequests": 0}, ensure_ascii=False, indent=2))
            return 0
        if args.output is None:
            raise PilotError("OUTPUT_DIRECTORY_REQUIRED")
        root = output_path(args.output)
        if args.command == "run":
            check_paid_gate(config, args.allow_paid, args.max_estimated_cny)
            DashScopeTransport(os.environ.get("DASHSCOPE_API_KEY", "")).check_ready()
            if root.exists():
                raise PilotError("RUN_REQUIRES_NEW_OUTPUT_DIRECTORY")
        elif not root.is_dir():
            raise PilotError("RESUME_DIRECTORY_NOT_FOUND")
        preflight()
        if args.command == "run":
            root.mkdir(parents=True, exist_ok=False, mode=0o700)
        with run_lock(root):
            runner = Runner(root, config, DashScopeTransport(os.environ.get("DASHSCOPE_API_KEY", "")),
                            resume=args.command == "resume", allow_paid=args.allow_paid,
                            maximum=args.max_estimated_cny)
            runner.run()
        print("TECHNICAL_PROBE_PASSED; visualReview=pending; voiceReview=pending; actualCost=unknown")
        return 0
    except PilotError as error:
        print(str(error), file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("INTERRUPTED_USE_RESUME_NEVER_REPEAT_UNKNOWN_SUBMISSION", file=sys.stderr)
        return 130
    except Exception:
        print("UNEXPECTED_LOCAL_FAILURE_CHECK_STATE_NO_AUTOMATIC_RESUBMISSION", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
