import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  WRITING_HTTP_DATABASE,
  WRITING_WEB_DATABASE,
  assertWritingAcceptanceDatabase,
} from "./writing-acceptance-database";

describe("writing acceptance database guard", () => {
  it("allows only an empty dedicated database and never clears existing tables", () => {
    expect(() => assertWritingAcceptanceDatabase({
      expectedName: WRITING_HTTP_DATABASE,
      currentName: WRITING_HTTP_DATABASE,
      businessTables: [],
    })).not.toThrow();
    expect(() => assertWritingAcceptanceDatabase({
      expectedName: WRITING_WEB_DATABASE,
      currentName: WRITING_WEB_DATABASE,
      businessTables: [],
    })).not.toThrow();
    expect(() => assertWritingAcceptanceDatabase({
      expectedName: "ai_drama",
      currentName: "ai_drama",
      businessTables: [],
    })).toThrow(/WRITING_ACCEPTANCE_DATABASE/);
    expect(() => assertWritingAcceptanceDatabase({
      expectedName: WRITING_HTTP_DATABASE,
      currentName: "postgres",
      businessTables: [],
    })).toThrow(/refusing to initialize/);
    expect(() => assertWritingAcceptanceDatabase({
      expectedName: WRITING_WEB_DATABASE,
      currentName: WRITING_WEB_DATABASE,
      businessTables: ["project", "story_revision"],
    })).toThrow(/refusing to reset/);
  });

  it("keeps DROP SCHEMA out of the writing acceptance paths", () => {
    const http = readFileSync(join(__dirname, "writing-assistant.acceptance.integration.spec.ts"), "utf8");
    const web = readFileSync(join(__dirname, "../../../../scripts/writing-assistant-web-acceptance.mjs"), "utf8");
    expect(http).not.toContain("DROP SCHEMA");
    expect(web).not.toContain("DROP SCHEMA");
    expect(http).toContain("does not open a browser");
    expect(web).toContain("real Web, API, and PostgreSQL");
  });
});
