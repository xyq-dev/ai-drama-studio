import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { lstat, mkdir, open, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DomainError, VOICE_COMPOSE_RENDER_PROFILE, assertVoiceComposeSnapshot, assertVoiceMixManifest,
  type VoiceComposeJobSnapshot } from "@ai-drama/domain";
import { PersistenceError, type JobPersistenceService, type PostgresVoiceComposeStore } from "@ai-drama/database";
import { createRenewalQueue, publishContainedBytes, registerComposeChild, stageVerifiedComposeSource, type ComposeObjectReader } from "./compose-job";

export interface VoiceComposeExecution {
  workspaceId: string; projectId: string; shotRevisionId: string; jobId: string; dispatchSeq: number;
  inputHash: string; inputSnapshot: VoiceComposeJobSnapshot; traceId: string;
}
export interface VoiceComposeJobOptions {
  jobs: JobPersistenceService; voiceStore: Pick<PostgresVoiceComposeStore, "commit">; objectReader?: ComposeObjectReader; mockObjectDir?: string;
  workDir: string; objectDir: string; pythonBin: string; pythonPath: string; leaseOwner: string; leaseMs: number; fontPath?: string;
}

/** Stage immutable takes, locally encode the new profile, then atomically finish its existing Job/Attempt/Asset. */
export async function runVoiceComposeJob(execution: VoiceComposeExecution, options: VoiceComposeJobOptions): Promise<void> {
  const acquired = await options.jobs.acquireQueuedJob({ workspaceId: execution.workspaceId, jobId: execution.jobId,
    dispatchSeq: execution.dispatchSeq, leaseOwner: options.leaseOwner, leaseMs: options.leaseMs, traceId: execution.traceId,
    providerConfigurationId: null });
  if (!acquired) return;
  const attemptDir = join(options.workDir, execution.workspaceId, execution.projectId, execution.jobId, acquired.attemptId);
  let lostLease = false;
  let child: ChildProcess | undefined;
  const renewal = createRenewalQueue(async () => {
    if (lostLease) return false;
    return options.jobs.renewRunningLease({ workspaceId: execution.workspaceId, jobId: execution.jobId,
      attemptId: acquired.attemptId, leaseOwner: options.leaseOwner, leaseMs: options.leaseMs });
  }, () => { lostLease = true; if (child) stopChild(child); });
  const timer = setInterval(() => renewal.push(), Math.max(250, Math.min(5000, Math.floor(options.leaseMs / 3))));
  const checkLease = () => { if (lostLease) throw new PersistenceError("COMPOSE_RESULT_DISCARDED", "Voice compose attempt lost its lease"); };
  try {
    const snapshot = assertVoiceComposeSnapshot(execution.inputSnapshot, execution.inputHash);
    const manifest = snapshot.input.manifest;
    if (manifest.workspaceId !== execution.workspaceId || manifest.projectId !== execution.projectId || manifest.shotRevisionId !== execution.shotRevisionId) {
      throw new PersistenceError("COMPOSE_INPUT_INVALID", "Voice compose snapshot is outside its job scope");
    }
    await mkdir(attemptDir, { recursive: true });
    await stageVoiceComposeSources(attemptDir, snapshot, options);
    checkLease();
    const output = join(attemptDir, "output.mp4");
    const rendered = await renderVoiceCompose(options, attemptDir, output, (active) => { child = active; }, checkLease);
    await renewal.idle();
    checkLease();
    const published = await publishVoiceOutput(options.objectDir, execution, acquired.attemptId, output, rendered);
    checkLease();
    await options.voiceStore.commit({ workspaceId: execution.workspaceId, projectId: execution.projectId,
      shotRevisionId: execution.shotRevisionId, jobId: execution.jobId, attemptId: acquired.attemptId,
      leaseOwner: options.leaseOwner, traceId: execution.traceId, ...published, width: 1080, height: 1920 });
  } catch (error) {
    if (lostLease || (error instanceof PersistenceError && ["COMPOSE_RESULT_DISCARDED", "JOB_TERMINAL", "ATTEMPT_SUPERSEDED", "JOB_INVALID_TRANSITION"].includes(error.code))) {
      if (await options.jobs.cancelRequested(execution.workspaceId, execution.jobId).catch(() => false)) {
        await options.jobs.confirmCancellation({ workspaceId: execution.workspaceId, jobId: execution.jobId, attemptId: acquired.attemptId,
          traceId: execution.traceId }).catch((failure: unknown) => {
          if (failure instanceof PersistenceError && ["JOB_TERMINAL", "ATTEMPT_SUPERSEDED", "JOB_INVALID_TRANSITION"].includes(failure.code)) return;
          throw failure;
        });
      }
      return;
    }
    const code = error instanceof PersistenceError || error instanceof DomainError ? error.code : "COMPOSE_RENDER_FAILED";
    await options.jobs.failJob({ workspaceId: execution.workspaceId, jobId: execution.jobId, attemptId: acquired.attemptId,
      traceId: execution.traceId, errorCode: code, errorMessage: "Voice composition could not complete",
      retryable: ["COMPOSE_RENDER_IO", "COMPOSE_RENDER_TIMEOUT", "COMPOSE_PROBE_FAILED"].includes(code) }).catch((failure: unknown) => {
      if (failure instanceof PersistenceError && ["JOB_TERMINAL", "ATTEMPT_SUPERSEDED"].includes(failure.code)) return;
      throw failure;
    });
  } finally {
    clearInterval(timer);
    await renewal.idle();
    if (child) stopChild(child);
    await rm(attemptDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function stageVoiceComposeSources(attemptDir: string, snapshot: VoiceComposeJobSnapshot,
  options: { mockObjectDir?: string; objectReader?: ComposeObjectReader }): Promise<void> {
  const manifest = snapshot.input.manifest;
  const vtt = assertVoiceMixManifest(manifest);
  let speechIndex = 0;
  for (const source of snapshot.input.sourceObjects) {
    const filename = source.role === "speech" ? `speech-${String(speechIndex++).padStart(3, "0")}.wav` : source.role === "video" ? "video.mp4" : "music.wav";
    await stageVerifiedComposeSource(options.mockObjectDir, join(attemptDir, filename), {
      ...source, role: source.role === "speech" ? "audio" : source.role,
    }, { workspaceId: manifest.workspaceId, projectId: manifest.projectId, objectReader: options.objectReader });
  }
  await writeFile(join(attemptDir, "subtitles.vtt"), vtt, { encoding: "utf8", flag: "wx" });
  await writeFile(join(attemptDir, "voice-plan.json"), JSON.stringify(manifest), { encoding: "utf8", flag: "wx" });
}

interface RenderedVoiceOutput { durationMs: number; elapsedMs: number; byteSize: number; checksumSha256: string; fontSha256: string; fontFamily: string; fontSourceSha256: string; fontSourceFaceIndex: number }
async function renderVoiceCompose(options: VoiceComposeJobOptions, attemptDir: string, output: string,
  onChild: (child: ChildProcess) => void, checkLease: () => void): Promise<RenderedVoiceOutput> {
  const child = spawn(options.pythonBin, ["-m", "media_worker.voice_compose", "--input-dir", attemptDir, "--output", output,
    ...(options.fontPath ? ["--font-path", options.fontPath] : [])], {
    shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH ?? "", SYSTEMROOT: process.env.SYSTEMROOT, LANG: "C.UTF-8", PYTHONPATH: options.pythonPath, PYTHONNOUSERSITE: "1" },
  });
  onChild(child);
  const unregister = registerComposeChild(child);
  let size = 0;
  let exceeded = false;
  let timedOut = false;
  const stdout: Buffer[] = [], stderr: Buffer[] = [];
  const receive = (target: Buffer[]) => (chunk: Buffer) => {
    size += chunk.length;
    if (size > 64 * 1024) { exceeded = true; stopChild(child); return; }
    target.push(chunk);
  };
  child.stdout?.on("data", receive(stdout));
  child.stderr?.on("data", receive(stderr));
  const timer = setTimeout(() => { timedOut = true; stopChild(child); }, (VOICE_COMPOSE_RENDER_PROFILE.renderTimeoutSec + 60) * 1000);
  let code: number;
  try {
    code = await new Promise<number>((resolve, reject) => { child.once("error", reject); child.once("close", (value) => resolve(value ?? 1)); });
  } catch {
    throw new PersistenceError("COMPOSE_RENDER_IO", "Voice renderer could not start");
  } finally { clearTimeout(timer); unregister(); }
  checkLease();
  if (timedOut) throw new PersistenceError("COMPOSE_RENDER_TIMEOUT", "Voice renderer exceeded its deadline");
  if (exceeded) throw new PersistenceError("COMPOSE_OUTPUT_INVALID", "Voice renderer response exceeded its limit");
  let payload: Record<string, unknown>;
  try { payload = JSON.parse(Buffer.concat(code === 0 ? stdout : stderr).toString("utf8")) as Record<string, unknown>; }
  catch { throw new PersistenceError("COMPOSE_OUTPUT_INVALID", "Voice renderer response was invalid"); }
  if (code !== 0) {
    const retryable = code === 3;
    const known = ["COMPOSE_RENDER_IO", "COMPOSE_RENDER_TIMEOUT", "COMPOSE_PROBE_FAILED", "COMPOSE_MEDIA_INVALID", "COMPOSE_INPUT_INVALID", "COMPOSE_OUTPUT_INVALID",
      "SPEECH_AUDIO_OVERFLOW", "COMPOSE_SPEECH_DURATION_CHANGED", "COMPOSE_SUBTITLE_INVALID", "COMPOSE_SUBTITLE_LAYOUT_INVALID", "COMPOSE_VOICE_MANIFEST_INVALID",
      "COMPOSE_PATH_INVALID", "COMPOSE_OUTPUT_CONFLICT", "COMPOSE_FONT_UNAVAILABLE"];
    const errorCode = typeof payload.code === "string" && known.includes(payload.code) ? payload.code : retryable ? "COMPOSE_RENDER_IO" : "COMPOSE_MEDIA_INVALID";
    throw new PersistenceError(errorCode, "Voice renderer rejected the measured composition");
  }
  if (payload.ok !== true || payload.profileId !== VOICE_COMPOSE_RENDER_PROFILE.id || payload.width !== 1080 || payload.height !== 1920 ||
    payload.videoCodec !== "h264" || payload.audioCodec !== "aac" || !Number.isSafeInteger(payload.durationMs) || Number(payload.durationMs) <= 0 ||
    !Number.isSafeInteger(payload.byteSize) || Number(payload.byteSize) <= 0 || !Number.isSafeInteger(payload.elapsedMs) || Number(payload.elapsedMs) < 0 ||
    typeof payload.checksumSha256 !== "string" || !/^[a-f0-9]{64}$/.test(payload.checksumSha256) || typeof payload.fontSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(payload.fontSha256) || payload.fontFamily !== "Noto Sans CJK SC" ||
    typeof payload.fontSourceSha256 !== "string" || !/^[a-f0-9]{64}$/.test(payload.fontSourceSha256) ||
    !Number.isSafeInteger(payload.fontSourceFaceIndex) || Number(payload.fontSourceFaceIndex) < 0 || Number(payload.fontSourceFaceIndex) > 63 ||
    payload.fontStyleVersion !== VOICE_COMPOSE_RENDER_PROFILE.fontStyleVersion) throw new PersistenceError("COMPOSE_OUTPUT_INVALID", "Voice renderer output does not match its profile");
  return { durationMs: Number(payload.durationMs), elapsedMs: Number(payload.elapsedMs), byteSize: Number(payload.byteSize), checksumSha256: payload.checksumSha256,
    fontSha256: payload.fontSha256, fontFamily: payload.fontFamily, fontSourceSha256: payload.fontSourceSha256, fontSourceFaceIndex: Number(payload.fontSourceFaceIndex) };
}

async function publishVoiceOutput(root: string, execution: VoiceComposeExecution, attemptId: string, output: string,
  rendered: RenderedVoiceOutput): Promise<RenderedVoiceOutput & { objectKey: string }> {
  const info = await lstat(output);
  if (!info.isFile() || info.isSymbolicLink() || info.size !== rendered.byteSize || info.size <= 0 || info.size > VOICE_COMPOSE_RENDER_PROFILE.maxOutputBytes) throw new PersistenceError("COMPOSE_OUTPUT_INVALID", "Voice output is outside its frozen size");
  const handle = await open(output, "r");
  try {
    const bytes = await handle.readFile();
    if (bytes.length !== rendered.byteSize || createHash("sha256").update(bytes).digest("hex") !== rendered.checksumSha256) throw new PersistenceError("COMPOSE_OUTPUT_INVALID", "Voice output checksum changed");
    const objectKey = `compose/${execution.workspaceId}/${execution.projectId}/${execution.jobId}/${attemptId}/${rendered.checksumSha256}.mp4`;
    await publishContainedBytes(root, objectKey, bytes);
    return { ...rendered, objectKey };
  } finally { await handle.close(); }
}

function stopChild(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") { spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { shell: false, stdio: "ignore" }); return; }
  try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
}
