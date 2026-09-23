import { describe, expect, it, vi } from "vitest";
import { checkPostgres, createPostgresPool } from "./index";

describe("postgres health", () => {
  it("returns ok when SELECT 1 succeeds", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ "?column?": 1 }] });
    await expect(checkPostgres({ query }, 50)).resolves.toBe("ok");
    expect(query).toHaveBeenCalledWith("SELECT 1");
  });

  it("returns down when the query fails", async () => {
    const query = vi.fn().mockRejectedValue(new Error("connection refused"));
    await expect(checkPostgres({ query }, 50)).resolves.toBe("down");
  });

  it("returns down when the check times out", async () => {
    const query = vi.fn().mockImplementation(() => new Promise(() => undefined));
    await expect(checkPostgres({ query }, 20)).resolves.toBe("down");
  });

  it("does not connect or log the password when the pool is created", async () => {
    const logs: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map((value) => String(value)).join(" "));
    };
    try {
      const pool = createPostgresPool({
        connectionString: "postgresql://ai_drama:super-secret-password@127.0.0.1:1/ai_drama",
        connectionTimeoutMs: 200,
        statementTimeoutMs: 200,
        queryTimeoutMs: 200,
      });
      expect(pool.totalCount).toBe(0);
      expect(logs.join("\n")).not.toContain("super-secret-password");
      await pool.end();
    } finally {
      console.log = original;
    }
  });
});
