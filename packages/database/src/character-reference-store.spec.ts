import { describe, expect, it } from "vitest";
import { characterReferenceStorageReady } from "./character-reference-store";

type Query = (sql: string) => Promise<{ rows: unknown[] }>;

function client(query: Query) {
  return { query } as unknown as Parameters<typeof characterReferenceStorageReady>[0];
}

const ALL_COLUMNS = Array.from({ length: 9 }, (_, index) => ({ table_name: "t", column_name: `c${index}` }));

describe("characterReferenceStorageReady", () => {
  it("rethrows a failed probe instead of reporting the structure missing", async () => {
    const timeout = Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
    await expect(characterReferenceStorageReady(client(async () => { throw timeout; }))).rejects.toBe(timeout);
    const lost = Object.assign(new Error("Connection terminated unexpectedly"), {});
    await expect(characterReferenceStorageReady(client(async (sql) => {
      if (sql.includes("pg_constraint")) throw lost;
      return { rows: ALL_COLUMNS };
    }))).rejects.toBe(lost);
  });

  it("reports missing only when the queries succeeded and showed the structure absent", async () => {
    expect(await characterReferenceStorageReady(client(async () => ({ rows: [] })))).toBe(false);
    expect(await characterReferenceStorageReady(client(async (sql) => (sql.includes("pg_constraint")
      ? { rows: [{ definition: "CHECK (review_status <> 'APPROVED' OR kind = 'COMPOSITE')" }] }
      : { rows: ALL_COLUMNS })))).toBe(false);
    expect(await characterReferenceStorageReady(client(async (sql) => (sql.includes("pg_constraint")
      ? { rows: [{ definition: "CHECK (... reference_role = 'character_reference' ...)" }] }
      : { rows: ALL_COLUMNS })))).toBe(true);
  });
});
