import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { copyFile, lstat, mkdir, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import {
  COMPOSE_RENDER_PROFILE,
  type ComposeJobSnapshot,
} from "@ai-drama/domain";
import {
  PersistenceError,
  type JobPersistenceService,
  type MediaAssetStore,
} from "@ai-drama/database";
const MAX_MOCK_INPUT_BYTES = 1024 * 1024;

const OUTPUT_MAX_BYTES = COMPOSE_RENDER_PROFILE.maxOutputBytes;

export interface ComposeExecution {
  workspaceId: string;
  projectId: string;
  shotRevisionId: string;
  jobId: string;
  dispatchSeq: number;
  inputHash: string;
  inputSnapshot: ComposeJobSnapshot;
  traceId: string;
}

export async function runComposeJob(
  execution: ComposeExecution,
  options: {
    jobs: JobPersistenceService;
    assets: MediaAssetStore;
    mockObjectDir: string;
    workDir: string;
    objectDir: string;
    pythonBin: string;
    pythonPath: string;
    leaseOwner: string;
    leaseMs: number;
    holdBeforeCommitMs?: number;
  },
): Promise<void> {
  const acquired = await options.jobs.acquireQueuedJob({
    workspaceId: execution.workspaceId,
    jobId: execution.jobId,
    dispatchSeq: execution.dispatchSeq,
    leaseOwner: options.leaseOwner,
    leaseMs: options.leaseMs,
    traceId: execution.traceId,
    providerConfigurationId: null,
  });
  if (!acquired) return;
  const attemptDir = join(options.workDir, execution.workspaceId, execution.projectId, execution.jobId, acquired.attemptId);
  try {
    if (!sameProfile(execution.inputSnapshot.input?.renderProfile)) {
      throw new PersistenceError("COMPOSE_INPUT_INVALID", "Compose render profile is not the local FFmpeg profile");
    }
    await mkdir(attemptDir, { recursive: true });
    await stageSources(options.mockObjectDir, attemptDir, execution.inputSnapshot);
    const output = join(attemptDir, "output.mp4");
    const rendered = await renderWithFfmpeg(options, execution, acquired.attemptId, attemptDir, output);
    const published = await publishOutput(options.objectDir, execution, acquired.attemptId, output, rendered);
    if ((options.holdBeforeCommitMs ?? 0) > 0 && acquired.attemptNo === 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, options.holdBeforeCommitMs));
    }
    const committed = await options.assets.commitLocalCompose(options.jobs, {
      workspaceId: execution.workspaceId,
      projectId: execution.projectId,
      shotRevisionId: execution.shotRevisionId,
      jobId: execution.jobId,
      attemptId: acquired.attemptId,
      leaseOwner: options.leaseOwner,
      traceId: execution.traceId,
      objectKey: published.objectKey,
      checksumSha256: published.checksumSha256,
      byteSize: published.byteSize,
      width: COMPOSE_RENDER_PROFILE.width,
      height: COMPOSE_RENDER_PROFILE.height,
      durationMs: published.durationMs,
      elapsedMs: published.elapsedMs,
    });
    if (!committed) return;
  } catch (error) {
    if (error instanceof PersistenceError && (error.code === "COMPOSE_RESULT_DISCARDED" || error.code === "JOB_TERMINAL" || error.code === "ATTEMPT_SUPERSEDED" || error.code === "JOB_INVALID_TRANSITION")) {
      return;
    }
    const retryable = error instanceof PersistenceError
      ? error.code === "COMPOSE_RENDER_IO" || error.code === "COMPOSE_RENDER_TIMEOUT" || error.code === "COMPOSE_PROBE_FAILED"
      : false;
    const code = error instanceof PersistenceError ? error.code : "COMPOSE_RENDER_FAILED";
    const message = error instanceof Error ? error.message : "Compose render failed";
    await options.jobs.failJob({
      workspaceId: execution.workspaceId,
      jobId: execution.jobId,
      attemptId: acquired.attemptId,
      traceId: execution.traceId,
      errorCode: code,
      errorMessage: message,
      retryable,
    }).catch((failure: unknown) => {
      if (failure instanceof PersistenceError && (failure.code === "JOB_TERMINAL" || failure.code === "ATTEMPT_SUPERSEDED")) return;
      throw failure;
    });
  } finally {
    await rm(attemptDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function readRendererFailure(detail: string): { code?: string } {
  try {
    return JSON.parse(detail.slice(detail.lastIndexOf("{"))) as { code?: string };
  } catch {
    return {};
  }
}

function sameProfile(value: unknown): boolean {
  return JSON.stringify(value) === JSON.stringify(COMPOSE_RENDER_PROFILE);
}

async function stageSources(root: string, attemptDir: string, snapshot: ComposeJobSnapshot): Promise<void> {
  const names = { video: "video.mp4", audio: "audio.wav", music: "music.wav", subtitle: "subtitle.vtt" } as const;
  for (const source of snapshot.input.sourceObjects) {
    const absolute = await boundedFile(root, source.objectKey, source.byteSize);
    const bytes = await readFile(absolute);
    if (bytes.length !== source.byteSize || createHash("sha256").update(bytes).digest("hex") !== source.checksumSha256) {
      throw new PersistenceError("COMPOSE_INPUT_INVALID", "Compose source bytes do not match the frozen checksum");
    }
    await copyFile(absolute, join(attemptDir, names[source.role]));
  }
}

async function boundedFile(root: string, objectKey: string, byteSize: number): Promise<string> {
  if (!isAbsolute(root) || byteSize <= 0 || byteSize > MAX_MOCK_INPUT_BYTES) {
    throw new PersistenceError("COMPOSE_INPUT_INVALID", "Compose source is outside the mock object limit");
  }
  const base = await realpath(root);
  const absolute = resolve(base, objectKey);
  if (absolute !== base && !absolute.startsWith(base.endsWith(sep) ? base : base + sep)) {
    throw new PersistenceError("COMPOSE_INPUT_INVALID", "Compose source escapes the mock object directory");
  }
  const info = await lstat(absolute);
  if (!info.isFile() || info.isSymbolicLink() || info.size !== byteSize || info.size > MAX_MOCK_INPUT_BYTES) {
    throw new PersistenceError("COMPOSE_INPUT_INVALID", "Compose source is not a regular mock file");
  }
  return absolute;
}

async function renderWithFfmpeg(
  options: { jobs: JobPersistenceService; leaseOwner: string; leaseMs: number; pythonBin: string; pythonPath: string },
  execution: ComposeExecution,
  attemptId: string,
  attemptDir: string,
  output: string,
): Promise<{ durationMs: number; elapsedMs: number }> {
  const child = spawn(options.pythonBin, ["-m", "media_worker.compose_cli", "--input-dir", attemptDir, "--output", output], {
    shell: false,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH ?? "",
      SYSTEMROOT: process.env.SYSTEMROOT,
      LANG: "C.UTF-8",
      PYTHONPATH: options.pythonPath,
      PYTHONNOUSERSITE: "1",
    },
  });
  const timer = setInterval(() => {
    void options.jobs.renewRunningLease({
      workspaceId: execution.workspaceId,
      jobId: execution.jobId,
      attemptId,
      leaseOwner: options.leaseOwner,
      leaseMs: options.leaseMs,
    }).then((renewed) => {
      if (!renewed) stopProcess(child);
    });
  }, 5000);
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
  const code = await new Promise<number>((done, reject) => {
    child.once("error", reject);
    child.once("close", (status) => done(status ?? 1));
  }).finally(() => clearInterval(timer));
  if (code === 0) {
    const payload = JSON.parse(Buffer.concat(stdout).toString("utf8")) as { durationMs?: number; elapsedMs?: number };
    if (!payload.durationMs || payload.durationMs <= 0) {
      throw new PersistenceError("COMPOSE_OUTPUT_INVALID", "Compose renderer did not report a duration");
    }
    return { durationMs: payload.durationMs, elapsedMs: payload.elapsedMs ?? 0 };
  }
  const stillHeld = await options.jobs.renewRunningLease({
    workspaceId: execution.workspaceId,
    jobId: execution.jobId,
    attemptId,
    leaseOwner: options.leaseOwner,
    leaseMs: options.leaseMs,
  });
  if (!stillHeld) {
    await stopAfterLeaseLoss(options.jobs, execution, attemptId);
    throw new PersistenceError("COMPOSE_RESULT_DISCARDED", "Compose renderer stopped after losing its lease");
  }
  const detail = Buffer.concat(stderr).toString("utf8");
  const parsed = readRendererFailure(detail);
  const errorCode = parsed.code ?? (code === 3 ? "COMPOSE_RENDER_IO" : "COMPOSE_MEDIA_INVALID");
  throw new PersistenceError(errorCode, `Local compose renderer exited ${code}`);
}

async function publishOutput(
  objectDir: string,
  execution: ComposeExecution,
  attemptId: string,
  output: string,
  rendered: { durationMs: number; elapsedMs: number },
): Promise<{ objectKey: string; checksumSha256: string; byteSize: number; durationMs: number; elapsedMs: number }> {
  const info = await stat(output);
  if (!info.isFile() || info.size <= 0 || info.size > OUTPUT_MAX_BYTES) {
    throw new PersistenceError("COMPOSE_OUTPUT_INVALID", "Compose output is outside the size limit");
  }
  const handle = await open(output, "r");
  try {
    const bytes = await handle.readFile();
    if (bytes.length !== info.size) throw new PersistenceError("COMPOSE_OUTPUT_INVALID", "Compose output changed while it was read");
    const checksumSha256 = createHash("sha256").update(bytes).digest("hex");
    const objectKey = `compose/${execution.workspaceId}/${execution.projectId}/${execution.jobId}/${attemptId}/${checksumSha256}.mp4`;
    const destination = await destinationPath(objectDir, objectKey);
    await mkdir(resolve(destination, ".."), { recursive: true });
    try {
      await rename(output, destination);
    } catch {
      await copyFile(output, destination);
    }
    const published = await stat(destination);
    if (published.size !== info.size) throw new PersistenceError("COMPOSE_OUTPUT_INVALID", "Published compose output does not match");
    return { objectKey, checksumSha256, byteSize: published.size, durationMs: rendered.durationMs, elapsedMs: rendered.elapsedMs };
  } finally {
    await handle.close();
  }
}

async function destinationPath(root: string, objectKey: string): Promise<string> {
  const base = await realpath(root);
  const absolute = resolve(base, objectKey);
  if (!absolute.startsWith(base.endsWith(sep) ? base : base + sep)) {
    throw new PersistenceError("COMPOSE_OUTPUT_INVALID", "Compose output escapes the object directory");
  }
  return absolute;
}

async function stopAfterLeaseLoss(jobs: JobPersistenceService, execution: ComposeExecution, attemptId: string): Promise<void> {
  const canceling = await jobs.cancelRequested(execution.workspaceId, execution.jobId);
  if (!canceling) return;
  await jobs.confirmCancellation({
    workspaceId: execution.workspaceId,
    jobId: execution.jobId,
    attemptId,
    traceId: execution.traceId,
  }).catch((error: unknown) => {
    if (error instanceof PersistenceError && (error.code === "JOB_TERMINAL" || error.code === "ATTEMPT_SUPERSEDED" || error.code === "JOB_INVALID_TRANSITION")) return;
    throw error;
  });
}

function stopProcess(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { shell: false, stdio: "ignore" });
    return;
  }
  try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
}

export function composeDiscarded(error: unknown): boolean {
  return error instanceof PersistenceError && (error.code === "COMPOSE_RESULT_DISCARDED" || error.code === "JOB_TERMINAL" || error.code === "ATTEMPT_SUPERSEDED");
}
