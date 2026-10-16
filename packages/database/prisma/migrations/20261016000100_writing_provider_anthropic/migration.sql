-- Writing providers: OpenAI and Claude (docs/OPENAI_CLAUDE_WRITING.md).
-- Expand only. It widens the provider_key CHECK of title_writing_run and title_writing_call by 'anthropic' (Claude).
-- The retired values 'qwen' and 'deepseek' stay allowed, so every stored run and call keeps its real provider; no row is
-- written, rewritten or deleted. The application, not this CHECK, limits new runs to openai and anthropic.
-- Needs only 20261008000100_title_writing. It does not depend on, apply or enable 20261012000100_script_breakdown, and
-- that migration does not touch these two constraints, so the two can be applied in either order.
-- Locks: ALTER TABLE takes ACCESS EXCLUSIVE on title_writing_run and title_writing_call for the length of this one
-- migration transaction, and each new CHECK scans its table once while validating. Run it in a quiet window.
-- No down migration. Old code keeps reading every row but has no anthropic provider: its engine fails on such a run
-- (repeatedly, without any send) and leaves it running. Before a code rollback, let Claude runs finish or keep
-- TITLE_WRITING_ENABLED off on the old code. Roll back code, not this migration.

-- The unnamed column CHECKs of 20261008000100_title_writing are found by their definition, not by a generated name; the
-- migration stops unless each table has exactly one provider_key CHECK of the three original values.
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
       AND pg_get_constraintdef(oid) NOT LIKE '%anthropic%';
    IF found IS NULL OR array_length(found, 1) <> 1 THEN
      RAISE EXCEPTION 'expected exactly one provider_key CHECK on %, found %', target, found;
    END IF;
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', target, found[1]);
  END LOOP;
END $$;

ALTER TABLE title_writing_run ADD CONSTRAINT title_writing_run_provider_key_check
  CHECK (provider_key IN ('qwen', 'openai', 'deepseek', 'anthropic'));
ALTER TABLE title_writing_call ADD CONSTRAINT title_writing_call_provider_key_check
  CHECK (provider_key IN ('qwen', 'openai', 'deepseek', 'anthropic'));
