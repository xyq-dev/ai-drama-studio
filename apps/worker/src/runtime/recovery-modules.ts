/**
 * Runs the media recovery modules one after another, so a fault in one cannot skip the others. They run in
 * sequence, never in parallel: they share the job, attempt and lease tables. A module's own fault is reported under
 * its name and the next module still runs; the next pass retries it. Two things stop the pass instead:
 * the process stopping (shutdown has begun or the database pool was closed) and a fault the caller classifies as
 * fatal. Those are rethrown at once, untouched.
 */
export interface RecoveryModule {
  name: string;
  run: () => Promise<void>;
}

export interface RecoveryModuleOptions {
  /** False once shutdown has begun. No module starts after that. */
  running: () => boolean;
  /** Reports a module's own fault. Called once per failed module per pass. */
  report: (module: string, error: unknown) => void;
  /** Faults that end the whole pass, for example a closed pool. */
  fatal?: (error: unknown) => boolean;
}

export class RecoveryStopped extends Error {
  constructor() {
    super("Recovery pass stopped because the worker is shutting down");
    this.name = "RecoveryStopped";
  }
}

/** pg reports a pool used after end() with this message; nothing in this process can recover from it. */
export function isProcessStopping(error: unknown): boolean {
  return error instanceof RecoveryStopped
    || (error instanceof Error && /Cannot use a pool after calling end on the pool/.test(error.message));
}

/** Returns the names of the modules that failed this pass; throws only for a stop or a fatal fault. */
export async function runRecoveryModules(modules: readonly RecoveryModule[], options: RecoveryModuleOptions): Promise<string[]> {
  const failed: string[] = [];
  for (const module of modules) {
    if (!options.running()) throw new RecoveryStopped();
    try {
      await module.run();
    } catch (error) {
      if (!options.running() || isProcessStopping(error) || options.fatal?.(error)) throw error;
      options.report(module.name, error);
      failed.push(module.name);
    }
  }
  return failed;
}

/** Names only: messages can carry identifiers or paths, and the attempts already record their own errors. */
export function describeRecoveryError(module: string, error: unknown): string {
  const nested = error instanceof AggregateError
    ? error.errors.map((item: unknown) => (item instanceof Error ? item.name : "unknown")).join(",")
    : null;
  const name = error instanceof Error ? error.name : "unknown";
  return `${module} recovery failed: ${name}${nested ? ` (${nested})` : ""}`;
}
