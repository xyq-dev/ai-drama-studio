import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runMigrations, type MigrationClient } from "./migrations";

describe("runMigrations", () => {
  it("applies ordered migrations transactionally and records checksums", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ai-drama-migrations-"));
    await writeFile(join(directory, "0002_second.sql"), "SELECT 2;\n");
    await writeFile(join(directory, "0001_first.sql"), "SELECT 1;\n");
    const query = vi.fn(async (sql: string) => ({ rows: sql.startsWith("SELECT name") ? [] : [] }));

    const result = await runMigrations({ query } as MigrationClient, directory);

    expect(result.applied).toEqual(["0001_first.sql", "0002_second.sql"]);
    expect(query.mock.calls.map(([sql]) => sql)).toContain("SELECT 1;\n");
    expect(query.mock.calls.filter(([sql]) => sql === "BEGIN")).toHaveLength(2);
    expect(query.mock.calls.filter(([sql]) => sql === "COMMIT")).toHaveLength(2);
  });

  it("rejects modification of an applied migration and releases its lock", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ai-drama-migrations-"));
    await writeFile(join(directory, "0001_first.sql"), "SELECT 1;\n");
    const query = vi.fn(async (sql: string) => ({
      rows: sql.startsWith("SELECT name") ? [{ name: "0001_first.sql", checksum: "wrong" }] : [],
    }));

    await expect(runMigrations({ query } as MigrationClient, directory)).rejects.toThrow("checksum mismatch");
    expect(query.mock.calls.at(-1)?.[0]).toBe("SELECT pg_advisory_unlock($1)");
  });
});
