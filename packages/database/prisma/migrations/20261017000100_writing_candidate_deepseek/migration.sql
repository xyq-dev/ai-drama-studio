-- DeepSeek online candidates (docs/DEEPSEEK_WRITING.md).
-- Expand only. It widens the provider_key CHECK of writing_candidate_request by 'deepseek'. No row is written,
-- rewritten or deleted, and no other table, column or constraint changes. The application, not this CHECK, decides which
-- providers new requests may use; until this migration is recorded in schema_migration and the live CHECK names
-- deepseek, a DeepSeek candidate is refused before any write, reservation or provider send. Title writing runs and calls
-- need no migration for DeepSeek: their CHECKs have allowed 'deepseek' since 20261008000100_title_writing.
-- Needs 20261016000200_writing_candidate (the table) and the base migrations. It does not depend on, apply or enable
-- 20261012000100_script_breakdown or 20261016000100_writing_provider_anthropic; the order among those does not matter.
-- Locks: ALTER TABLE takes ACCESS EXCLUSIVE on writing_candidate_request for the length of this one migration
-- transaction, and the new CHECK scans that table once while validating. Run it in a quiet window.
-- No down migration. Older code never writes 'deepseek' and keeps reading every row; a code rollback keeps this CHECK.
-- Roll back code, not this migration.

-- The unnamed column CHECK of 20261016000200_writing_candidate is found by its definition, not by a generated name. It
-- is dropped only when it is the one and only CHECK of the table that mentions provider_key and its definition is
-- exactly the released one: a CHECK that also limits another column, or any further CHECK on provider_key, stops the
-- migration (nothing is dropped, so no other limit can be lost) and the whole transaction rolls back.
DO $$
DECLARE
  expected CONSTANT text := 'CHECK ((provider_key = ANY (ARRAY[''openai''::text, ''anthropic''::text])))';
  found text[];
  definition text;
BEGIN
  SELECT array_agg(conname ORDER BY conname), min(pg_get_constraintdef(oid)) INTO found, definition
    FROM pg_constraint
   WHERE conrelid = 'writing_candidate_request'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%provider_key%';
  IF found IS NULL OR array_length(found, 1) <> 1 THEN
    RAISE EXCEPTION 'expected exactly one provider_key CHECK on writing_candidate_request, found %', found;
  END IF;
  IF definition <> expected THEN
    RAISE EXCEPTION 'unexpected provider_key CHECK on writing_candidate_request: %', definition;
  END IF;
  EXECUTE format('ALTER TABLE writing_candidate_request DROP CONSTRAINT %I', found[1]);
END $$;

ALTER TABLE writing_candidate_request ADD CONSTRAINT writing_candidate_request_provider_key_check
  CHECK (provider_key IN ('openai', 'anthropic', 'deepseek'));
