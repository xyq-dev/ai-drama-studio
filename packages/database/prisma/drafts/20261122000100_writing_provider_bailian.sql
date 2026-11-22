-- DRAFT. Do not apply. Execution of this migration is not authorized.
-- This file is not under prisma/migrations and is not discovered by runMigrations.
-- After authorization, copy it to prisma/migrations/20261122000100_writing_provider_bailian/migration.sql
-- and apply only that migration with --only. Do not run the full migration set for this change.
--
-- Widens title_writing_run and title_writing_call provider_key CHECKs to include 'bailian'
-- for new AI SDK writing runs (bailian.ai-sdk.v1, model qwen-plus).
-- Historical 'qwen' stays allowed and is not rewritten. No row is inserted, updated, or deleted.
-- Does not touch auto_creation, series, or writing_candidate.

DO $$
DECLARE
  target text;
  found text[];
BEGIN
  FOREACH target IN ARRAY ARRAY['title_writing_run', 'title_writing_call'] LOOP
    SELECT array_agg(conname ORDER BY conname) INTO found
      FROM pg_constraint
     WHERE conrelid = target::regclass AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%provider_key%'
       AND pg_get_constraintdef(oid) LIKE '%''qwen''%'
       AND pg_get_constraintdef(oid) LIKE '%''openai''%'
       AND pg_get_constraintdef(oid) LIKE '%''deepseek''%'
       AND pg_get_constraintdef(oid) LIKE '%''anthropic''%'
       AND pg_get_constraintdef(oid) NOT LIKE '%bailian%';
    IF found IS NULL OR array_length(found, 1) <> 1 THEN
      RAISE EXCEPTION 'expected exactly one provider_key CHECK on %, found %', target, found;
    END IF;
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', target, found[1]);
  END LOOP;
END $$;

ALTER TABLE title_writing_run ADD CONSTRAINT title_writing_run_provider_key_check
  CHECK (provider_key IN ('qwen', 'openai', 'deepseek', 'anthropic', 'bailian'));
ALTER TABLE title_writing_call ADD CONSTRAINT title_writing_call_provider_key_check
  CHECK (provider_key IN ('qwen', 'openai', 'deepseek', 'anthropic', 'bailian'));
