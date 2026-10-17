-- DeepSeek online candidates (docs/OPENAI_CLAUDE_WRITING.md, "DeepSeek 重新接入（2026-10-17）").
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

-- The unnamed column CHECK of 20261016000200_writing_candidate is found by its definition, not by a generated name; the
-- migration stops unless the table has exactly one provider_key CHECK of the two original values.
DO $$
DECLARE
  found text[];
BEGIN
  SELECT array_agg(conname ORDER BY conname) INTO found
    FROM pg_constraint
   WHERE conrelid = 'writing_candidate_request'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%provider_key%'
     AND pg_get_constraintdef(oid) LIKE '%''openai''%'
     AND pg_get_constraintdef(oid) LIKE '%''anthropic''%'
     AND pg_get_constraintdef(oid) NOT LIKE '%deepseek%';
  IF found IS NULL OR array_length(found, 1) <> 1 THEN
    RAISE EXCEPTION 'expected exactly one provider_key CHECK on writing_candidate_request, found %', found;
  END IF;
  EXECUTE format('ALTER TABLE writing_candidate_request DROP CONSTRAINT %I', found[1]);
END $$;

ALTER TABLE writing_candidate_request ADD CONSTRAINT writing_candidate_request_provider_key_check
  CHECK (provider_key IN ('openai', 'anthropic', 'deepseek'));
