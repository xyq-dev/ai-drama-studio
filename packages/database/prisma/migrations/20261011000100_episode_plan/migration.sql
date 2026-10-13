-- Episode plan: a project's episode count (1–6) and per-episode target seconds (60 or 90), and the wider episode and
-- title writing step ranges they need (docs/VARIABLE_EPISODE_WRITING_IMPLEMENTATION_REPORT.md).
-- Expand only. It adds two project columns and widens four CHECK constraints. No row is written, rewritten or deleted.
-- Every existing project keeps episode_count 3 (the column default, metadata only on PostgreSQL 11+) and a NULL
-- target_episode_seconds: its target was never recorded, so it stays unknown and is never guessed. Existing episodes,
-- episode ids, title writing runs, steps, calls and their input hashes are untouched; the old ranges are subsets of
-- the new ones, so every existing row satisfies the new constraints.
-- Read by packages/database/src/episode-plan.ts. Until this migration is recorded in schema_migration and both columns
-- exist, the API refuses projects with an episode plan (before any write and any provider send) and every project
-- keeps the three-episode behavior.
-- Locks: ALTER TABLE takes ACCESS EXCLUSIVE on project, episode and title_writing_step for the length of this one
-- migration transaction; the new CHECKs scan those tables once while validating. Run it in a quiet window.
-- No down migration. A code rollback keeps the columns and the wider ranges; older code never writes outside the old
-- ranges and ignores the columns. Forward-fix only.

ALTER TABLE project ADD COLUMN episode_count smallint NOT NULL DEFAULT 3;
ALTER TABLE project ADD COLUMN target_episode_seconds smallint;
ALTER TABLE project ADD CONSTRAINT project_episode_count_check CHECK (episode_count BETWEEN 1 AND 6);
ALTER TABLE project ADD CONSTRAINT project_target_episode_seconds_check
  CHECK (target_episode_seconds IS NULL OR target_episode_seconds IN (60, 90));
-- A project without a recorded plan is a three-episode project.
ALTER TABLE project ADD CONSTRAINT project_episode_plan_check CHECK (target_episode_seconds IS NOT NULL OR episode_count = 3);

-- The m2a episode CHECK (episode_no BETWEEN 1 AND 3) under its PostgreSQL default name.
ALTER TABLE episode DROP CONSTRAINT episode_episode_no_check;
ALTER TABLE episode ADD CONSTRAINT episode_episode_no_check CHECK (episode_no BETWEEN 1 AND 6);

-- The title writing step CHECKs of 20261008000100_title_writing under their PostgreSQL default names. v1 runs keep
-- their five steps; a v2 run of N episodes has concept, outline and episode:1..N.
ALTER TABLE title_writing_step DROP CONSTRAINT title_writing_step_step_key_check;
ALTER TABLE title_writing_step ADD CONSTRAINT title_writing_step_step_key_check
  CHECK (step_key IN ('concept', 'outline', 'episode:1', 'episode:2', 'episode:3', 'episode:4', 'episode:5', 'episode:6'));
ALTER TABLE title_writing_step DROP CONSTRAINT title_writing_step_ordinal_check;
ALTER TABLE title_writing_step ADD CONSTRAINT title_writing_step_ordinal_check CHECK (ordinal BETWEEN 0 AND 7);
