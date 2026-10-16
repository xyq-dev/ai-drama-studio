-- Online writing candidates of the workbench writing assistant (docs/OPENAI_CLAUDE_WRITING.md, "工作台在线候选").
-- Expand only: one new table with its keys, checks and indexes. No existing table, column, constraint or row changes,
-- and no row is written. Read by packages/database/src/writing-candidate-store.ts: until this migration is recorded in
-- schema_migration and the table exists with every column, candidate requests are refused before any write,
-- reservation or provider send; title writing, the manual JSON import and saving are unchanged.
-- Needs only the base migrations (project, episode of 20260924000100_m1b_job_core and 20260925000100_m2a_text_chain).
-- It does not depend on, apply or enable 20261012000100_script_breakdown or 20261016000100_writing_provider_anthropic;
-- the order among the three does not matter. A candidate is never a story or script revision: saving one still goes
-- through the editor's own "保存新版本".
-- Locks: CREATE TABLE with its two foreign keys takes SHARE ROW EXCLUSIVE on project and episode for the length of this
-- one migration transaction (writes to them wait, reads do not); nothing is scanned. Run it in a quiet window.
-- No down migration. Older code ignores this table; a code rollback keeps it. Forward-fix only.

CREATE TABLE writing_candidate_request (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  actor_id text NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  input_json jsonb NOT NULL,
  mode text NOT NULL CHECK (mode IN ('story', 'episode')),
  episode_id uuid,
  episode_no smallint,
  source_revision_id uuid,
  if_match integer NOT NULL CHECK (if_match > 0),
  -- New requests use the active providers only; the application refuses retired ones before anything is written.
  provider_key text NOT NULL CHECK (provider_key IN ('openai', 'anthropic')),
  model text NOT NULL CHECK (length(model) BETWEEN 1 AND 128),
  state text NOT NULL CHECK (state IN ('reserved', 'submitted', 'completed', 'rejected', 'unknown')),
  -- Only the executor holding a live lease may change an open request; recovery acts after the lease expired.
  executor_id text,
  lease_until timestamptz,
  error_code text,
  provider_request_id text,
  response_model text,
  usage_json jsonb NOT NULL,
  -- Cost is never written as zero. There is no amount column until a reliable price source is reviewed.
  billing_status text NOT NULL DEFAULT 'unknown' CHECK (billing_status = 'unknown'),
  candidate_json jsonb,
  -- The earlier request of the same target with an unknown result that the person confirmed before this one.
  confirmed_request_id uuid,
  created_at timestamptz NOT NULL,
  finished_at timestamptz,
  UNIQUE (workspace_id, actor_id, idempotency_key),
  CHECK ((mode = 'story' AND episode_id IS NULL AND episode_no IS NULL)
    OR (mode = 'episode' AND episode_id IS NOT NULL AND episode_no BETWEEN 1 AND 6)),
  CHECK ((state IN ('reserved', 'submitted')) = (executor_id IS NOT NULL)),
  CHECK ((executor_id IS NULL) = (lease_until IS NULL)),
  CHECK ((state IN ('reserved', 'submitted')) = (finished_at IS NULL)),
  CHECK ((state = 'completed') = (candidate_json IS NOT NULL)),
  FOREIGN KEY (project_id, workspace_id) REFERENCES project (id, workspace_id),
  FOREIGN KEY (episode_id, project_id, workspace_id) REFERENCES episode (id, project_id, workspace_id)
);

-- At most one open request per target (the story of a work, or one episode of it).
CREATE UNIQUE INDEX writing_candidate_request_one_open_idx ON writing_candidate_request
  (project_id, mode, (COALESCE(episode_id, '00000000-0000-0000-0000-000000000000'::uuid)))
  WHERE state IN ('reserved', 'submitted');
CREATE INDEX writing_candidate_request_target_idx ON writing_candidate_request (workspace_id, project_id, mode, episode_id, created_at DESC);
CREATE INDEX writing_candidate_request_recent_idx ON writing_candidate_request (workspace_id, created_at);
CREATE INDEX writing_candidate_request_lease_idx ON writing_candidate_request (lease_until) WHERE state IN ('reserved', 'submitted');
