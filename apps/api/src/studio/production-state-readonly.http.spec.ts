import "reflect-metadata";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProductionStateReadonlyController } from "./production-state-readonly.controller";
import { ProductionStateReadonlyService } from "./production-state-readonly.service";
import { PRODUCTION_STATE_READONLY_SERVICE } from "./tokens";

const PROJECT = "fixture-minimal-v1";
const FIXTURE = resolve(__dirname, "../../../../docs/fixtures/hongguo-production-state.v1.minimal.json");

describe("production state readonly HTTP routes", () => {
  let app: INestApplication;
  let url: string;
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(resolve(tmpdir(), "hongguo-readonly-http-"));
    const file = resolve(root, PROJECT, "production-state.json");
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, await readFile(FIXTURE, "utf8"), "utf8");

    const module = await Test.createTestingModule({
      controllers: [ProductionStateReadonlyController],
      providers: [{
        provide: PRODUCTION_STATE_READONLY_SERVICE,
        useValue: new ProductionStateReadonlyService(root),
      }],
    }).compile();
    app = module.createNestApplication({ logger: false });
    app.setGlobalPrefix("api/v1");
    await app.listen(0, "127.0.0.1");
    url = `${await app.getUrl()}/api/v1`;
  });

  afterAll(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });

  it("serves the validated state with private no-store caching", async () => {
    const response = await fetch(`${url}/projects/${PROJECT}/production-state`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual(expect.objectContaining({
      schema: "hongguo-production-state.v1",
      projectId: PROJECT,
    }));
  });

  it("serves domain readiness and preserves blockers as a normal 200 response", async () => {
    const response = await fetch(`${url}/projects/${PROJECT}/episodes/S1/production-readiness`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual(expect.objectContaining({ allowed: true, episodeId: "S1", blockers: [] }));
  });

  it("returns bounded HTTP errors for invalid and missing project ids", async () => {
    const invalid = await fetch(`${url}/projects/bad%25id/production-state`);
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({
      error: { code: "PRODUCTION_STATE_IDENTIFIER_INVALID", message: "Project identifier is invalid." },
    });
    expect((await fetch(`${url}/projects/missing-project/production-state`)).status).toBe(404);
  });
});
