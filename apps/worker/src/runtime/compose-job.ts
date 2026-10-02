import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { lstat, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, sep } from "node:path";
import {
  COMPOSE_RENDER_PROFILE,
  canonicalInputHash,
  type ComposeJobSnapshot,
} from "@ai-drama/domain";
import {
  PersistenceError,
  type JobPersistenceService,
  type MediaAssetStore,
} from "@ai-drama/database";
const MAX_MOCK_INPUT_BYTES = 1024 * 1024;

const OUTPUT_MAX_BYTES = COMPOSE_RENDER_PROFILE.maxOutputBytes;
const activeComposeChildren = new Set<ChildProcess>();
let renderTail: Promise<void> = Promise.resolve();

export function stopActiveComposeChildren(): void {
  for (const child of activeComposeChildren) stopProcess(child);
}

export function withSingleComposeRender<T>(work: () => Promise<T>): Promise<T> {
  const previous = renderTail;
  let release: () => void = () => undefined;
  renderTail = new Promise<void>((done) => { release = done; });
  return previous.then(work, work).finally(release);
}

export function createRenewalQueue(renew: () => Promise<boolean>, stop: () => void): { push(): void; idle(): Promise<void> } {
  let chain = Promise.resolve();
  return {
    push() {
      chain = chain.then(async () => {
        try {
          const renewed = await renew();
          if (!renewed) stop();
        } catch {
          stop();
        }
      });
    },
    idle() { return chain; },
  };
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
    failInsideCommit?: boolean;
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
      failInsideCommit: options.failInsideCommit === true,
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

function readRendererFailure(detail: string): { code?: string } {
  try {
    return JSON.parse(detail.slice(detail.lastIndexOf("{"))) as { code?: string };
  } catch {
    return {};
  }
}

function sameProfile(value: unknown): boolean {
  try {
    return canonicalInputHash({ renderProfile: value }) === canonicalInputHash({ renderProfile: COMPOSE_RENDER_PROFILE });
  } catch {
    return false;
  }
}

async function stageSources(root: string, attemptDir: string, snapshot: ComposeJobSnapshot): Promise<void> {
  const names = { video: "video.mp4", audio: "audio.wav", music: "music.wav", subtitle: "subtitle.vtt" } as const;
  for (const source of snapshot.input.sourceObjects) {
    const absolute = await containedFile(root, source.objectKey, source.byteSize);
    const bytes = await readRegularFile(absolute, source.byteSize);
    if (createHash("sha256").update(bytes).digest("hex") !== source.checksumSha256) {
      throw new PersistenceError("COMPOSE_INPUT_INVALID", "Compose source bytes do not match the frozen checksum");
    }
    await writeExclusive(join(attemptDir, names[source.role]), bytes);
  }
}

async function readRegularFile(absolute: string, byteSize: number): Promise<Buffer> {
  const handle = await open(absolute, "r");
  try {
    const bytes = await handle.readFile();
    if (bytes.length !== byteSize) {
      throw new PersistenceError("COMPOSE_INPUT_INVALID", "Compose source bytes do not match the frozen checksum");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function writeExclusive(target: string, bytes: Buffer): Promise<void> {
  const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error));
  if (existing?.isSymbolicLink()) {
    throw new PersistenceError("COMPOSE_INPUT_INVALID", "Compose source escapes the mock object directory");
  }
  const handle = await open(target, "wx");
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
}

export async function containedFile(root: string, relative: string, byteSize: number): Promise<string> {
  if (!isAbsolute(root) || byteSize <= 0 || byteSize > MAX_MOCK_INPUT_BYTES) {
    throw new PersistenceError("COMPOSE_INPUT_INVALID", "Compose source is outside the mock object limit");
  }
  const absolute = await walkContained(root, relative);
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
  activeComposeChildren.add(child);
  let lostLease = false;
  const renewal = createRenewalQueue(async () => {
    if (lostLease) return false;
    return options.jobs.renewRunningLease({
      workspaceId: execution.workspaceId,
      jobId: execution.jobId,
      attemptId,
      leaseOwner: options.leaseOwner,
      leaseMs: options.leaseMs,
    });
  }, () => {
    lostLease = true;
    stopProcess(child);
  });
  const timer = setInterval(() => renewal.push(), 5000);
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
  const code = await new Promise<number>((done, reject) => {
    child.once("error", reject);
    child.once("close", (status) => done(status ?? 1));
  }).finally(() => {
    clearInterval(timer);
    activeComposeChildren.delete(child);
  });
  await renewal.idle();
  if (lostLease) {
    await stopAfterLeaseLoss(options.jobs, execution, attemptId);
    throw new PersistenceError("COMPOSE_RESULT_DISCARDED", "Compose renderer stopped after losing its lease");
  }
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
  }).catch(() => false);
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
    await publishContainedBytes(objectDir, objectKey, bytes);
    return { objectKey, checksumSha256, byteSize: bytes.length, durationMs: rendered.durationMs, elapsedMs: rendered.elapsedMs };
  } finally {
    await handle.close();
  }
}

export async function publishContainedBytes(root: string, objectKey: string, bytes: Buffer): Promise<void> {
  const destination = await containedNewFile(root, objectKey);
  const temp = join(destination, "..", `.${randomUUID()}.partial.mp4`);
  await writeFile(temp, bytes);
  try {
    const existing = await lstat(destination).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error));
    if (existing) throw new PersistenceError("COMPOSE_OUTPUT_INVALID", "Compose output already exists");
    await rename(temp, destination);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    if (error instanceof PersistenceError) throw error;
    throw new PersistenceError("COMPOSE_OUTPUT_INVALID", "Compose output could not be published");
  }
  const published = await readFile(destination);
  if (published.length !== bytes.length || !published.equals(bytes)) {
    throw new PersistenceError("COMPOSE_OUTPUT_INVALID", "Published compose output does not match");
  }
}

async function containedNewFile(root: string, relative: string): Promise<string> {
  if (!isAbsolute(root)) throw new PersistenceError("COMPOSE_OUTPUT_INVALID", "Compose output escapes the object directory");
  const base = await realpath(root);
  const parts = safeParts(relative);
  let current = base;
  const pending: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index] ?? "";
    const next = join(current, part);
    const info = await lstat(next).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error));
    if (!info) {
      pending.push(...parts.slice(index));
      break;
    }
    if (info.isSymbolicLink()) throw new PersistenceError("COMPOSE_OUTPUT_INVALID", "Compose output escapes the object directory");
    current = next;
  }
  const resolved = await realpath(current);
  if (!insideRoot(base, resolved)) throw new PersistenceError("COMPOSE_OUTPUT_INVALID", "Compose output escapes the object directory");
  if (pending.length > 0) await mkdir(join(resolved, ...pending.slice(0, -1)), { recursive: true });
  const destination = join(resolved, ...pending);
  if (!insideRoot(base, destination) && destination !== base) {
    throw new PersistenceError("COMPOSE_OUTPUT_INVALID", "Compose output escapes the object directory");
  }
  return destination;
}

async function walkContained(root: string, relative: string): Promise<string> {
  const base = await realpath(root);
  let current = base;
  for (const part of safeParts(relative)) {
    current = join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink()) {
      throw new PersistenceError("COMPOSE_INPUT_INVALID", "Compose source escapes the mock object directory");
    }
  }
  const resolved = await realpath(current);
  if (!insideRoot(base, resolved)) {
    throw new PersistenceError("COMPOSE_INPUT_INVALID", "Compose source escapes the mock object directory");
  }
  return resolved;
}

function safeParts(relative: string): string[] {
  const parts = relative.split(/[/\\]/).filter((part) => part.length > 0);
  if (parts.length === 0 || parts.some((part) => part === "." || part === "..")) {
    throw new PersistenceError("COMPOSE_INPUT_INVALID", "Compose source escapes the mock object directory");
  }
  return parts;
}

function insideRoot(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep);
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
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { shell: false, stdio: "ignore" });
    return;
  }
  try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
}

export function composeDiscarded(error: unknown): boolean {
  return error instanceof PersistenceError && (error.code === "COMPOSE_RESULT_DISCARDED" || error.code === "JOB_TERMINAL" || error.code === "ATTEMPT_SUPERSEDED");
}
