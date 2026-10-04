export const WRITING_HTTP_DATABASE = "ai_drama_writing";
export const WRITING_WEB_DATABASE = "ai_drama_writing_web";

const DEDICATED_DATABASES = new Set([WRITING_HTTP_DATABASE, WRITING_WEB_DATABASE]);

export function assertWritingAcceptanceDatabase(input: {
  expectedName: string | undefined;
  currentName: string;
  businessTables: readonly string[];
}): void {
  const expected = input.expectedName ?? "";
  if (!DEDICATED_DATABASES.has(expected)) {
    throw new Error(`WRITING_ACCEPTANCE_DATABASE must be ${WRITING_HTTP_DATABASE} or ${WRITING_WEB_DATABASE}`);
  }
  if (input.currentName !== expected) {
    throw new Error(`connected to ${input.currentName}; refusing to initialize anything except the dedicated database ${expected}`);
  }
  if (input.businessTables.length > 0) {
    throw new Error(`dedicated database ${expected} already has business tables (${input.businessTables.join(", ")}); refusing to reset`);
  }
}

export async function assertEmptyWritingAcceptanceDatabase(pool: {
  query(sql: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}): Promise<void> {
  const current = await pool.query("SELECT current_database() AS name");
  const tables = await pool.query(
    `SELECT c.relname AS name
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
     ORDER BY c.relname`,
  );
  assertWritingAcceptanceDatabase({
    expectedName: process.env.WRITING_ACCEPTANCE_DATABASE,
    currentName: String(current.rows[0]?.name ?? ""),
    businessTables: tables.rows.map((row) => String(row.name)),
  });
}
