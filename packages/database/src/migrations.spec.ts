import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runMigrations, type MigrationClient, type MigrationPool } from "./migrations";

function createPool(query: MigrationClient["query"]): {
  pool: MigrationPool;
  release: ReturnType<typeof vi.fn>;
} {
  const release = vi.fn();
  return {
    pool: {
      connect: vi.fn(async () => ({ query, release })),
    },
    release,
  };
}

describe("runMigrations", () => {
  it("applies Prisma-layout migrations in order on one checked-out client", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ai-drama-migrations-"));
    const first = join(directory, "0001_first");
    const second = join(directory, "0002_second");
    await mkdir(first);
    await mkdir(second);
    await writeFile(join(first, "migration.sql"), "SELECT 1;\n");
    await writeFile(join(second, "migration.sql"), "SELECT 2;\n");

    const query = vi.fn(async (sql: string) => ({ rows: sql.startsWith("SELECT name") ? [] : [] }));
    const { pool, release } = createPool(query);

    const result = await runMigrations(pool, directory);

    expect(result.applied).toEqual(["0001_first", "0002_second"]);
    expect(query.mock.calls.map(([sql]) => sql)).toContain("SELECT 1;\n");
    expect(query.mock.calls.filter(([sql]) => sql === "BEGIN")).toHaveLength(2);
    expect(query.mock.calls.filter(([sql]) => sql === "COMMIT")).toHaveLength(2);
    expect(release).toHaveBeenCalledOnce();
  });

  it("rejects modification of an applied migration and releases its session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ai-drama-migrations-"));
    await writeFile(join(directory, "0001_first.sql"), "SELECT 1;\n");
    const query = vi.fn(async (sql: string) => ({
      rows: sql.startsWith("SELECT name") ? [{ name: "0001_first.sql", checksum: "wrong" }] : [],
    }));
    const { pool, release } = createPool(query);

    await expect(runMigrations(pool, directory)).rejects.toThrow("checksum mismatch");
    expect(query.mock.calls.at(-1)?.[0]).toBe("SELECT pg_advisory_unlock($1)");
    expect(release).toHaveBeenCalledOnce();
  });

  it("releases the dedicated connection when advisory locking fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ai-drama-migrations-"));
    const query = vi.fn(async () => {
      throw new Error("connection closed");
    });
    const { pool, release } = createPool(query);

    await expect(runMigrations(pool, directory)).rejects.toThrow("connection closed");
    expect(query).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });
});
