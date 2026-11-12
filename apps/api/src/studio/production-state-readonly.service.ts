import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  DomainError,
  productionReadiness,
  readProductionStateFile,
  type ProductionGateResult,
  type ProductionState,
} from "@ai-drama/domain";

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const INVALID_STATE_CODES = new Set([
  "PRODUCTION_STATE_JSON_INVALID",
  "PRODUCTION_STATE_SCHEMA_INVALID",
  "PRODUCTION_STATE_SEMANTIC_INVALID",
]);

export interface ProductionStateReadonlyResult {
  status: number;
  body: unknown;
}

type LoadedState =
  | { kind: "ok"; state: ProductionState }
  | { kind: "error"; result: ProductionStateReadonlyResult };

function failure(status: number, code: string, message: string): ProductionStateReadonlyResult {
  return { status, body: { error: { code, message } } };
}

function validIdentifier(value: string): boolean {
  return SAFE_IDENTIFIER.test(value) && !value.includes("..");
}

/** Read-only adapter around the production-state domain core. It never writes, locks, or mutates state files. */
export class ProductionStateReadonlyService {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async getState(projectId: string): Promise<ProductionStateReadonlyResult> {
    const loaded = await this.load(projectId);
    return loaded.kind === "ok" ? { status: 200, body: loaded.state } : loaded.result;
  }

  async getReadiness(projectId: string, episodeId: string): Promise<ProductionStateReadonlyResult> {
    if (!validIdentifier(episodeId)) {
      return failure(400, "PRODUCTION_STATE_IDENTIFIER_INVALID", "Episode identifier is invalid.");
    }
    const loaded = await this.load(projectId);
    if (loaded.kind === "error") return loaded.result;
    try {
      const result: ProductionGateResult = productionReadiness(loaded.state, episodeId);
      return { status: 200, body: result };
    } catch (error) {
      if (error instanceof DomainError && error.code === "PRODUCTION_EPISODE_NOT_FOUND") {
        return failure(404, "PRODUCTION_EPISODE_NOT_FOUND", "Production episode was not found.");
      }
      throw error;
    }
  }

  private async load(projectId: string): Promise<LoadedState> {
    if (!validIdentifier(projectId)) {
      return { kind: "error", result: failure(400, "PRODUCTION_STATE_IDENTIFIER_INVALID", "Project identifier is invalid.") };
    }
    const filePath = this.statePath(projectId);
    if (filePath === null) {
      return { kind: "error", result: failure(400, "PRODUCTION_STATE_IDENTIFIER_INVALID", "Project identifier is invalid.") };
    }
    try {
      const state = await readProductionStateFile(filePath);
      if (state.projectId !== projectId) {
        return { kind: "error", result: failure(422, "PRODUCTION_STATE_PROJECT_MISMATCH", "Production state projectId does not match the requested project.") };
      }
      return { kind: "ok", state };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { kind: "error", result: failure(404, "PRODUCTION_STATE_NOT_FOUND", "Production state was not found.") };
      }
      if (error instanceof DomainError && INVALID_STATE_CODES.has(error.code)) {
        return { kind: "error", result: failure(422, "PRODUCTION_STATE_INVALID", "Production state is invalid.") };
      }
      throw error;
    }
  }

  private statePath(projectId: string): string | null {
    const target = resolve(this.root, projectId, "production-state.json");
    const child = relative(this.root, target);
    if (child === "" || child === ".." || child.startsWith(".." + sep) || isAbsolute(child)) return null;
    return target;
  }
}
