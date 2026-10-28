-- Title-driven writing runs (docs/TITLE_DRIVEN_WRITING.md, docs/TITLE_WRITING_MIGRATION_RELEASE.md).
-- Formal migration of prisma/drafts/20261008000100_title_writing.sql, the draft that passed the isolated store, API,
-- browser and runtime acceptances. Every statement below is the draft's, byte for byte; only this header differs.
-- Additive: four new tables with their keys, checks and indexes. No existing table, column, constraint or row changes.
-- Read by PostgresTitleWritingStore (packages/database/src/title-writing-store.ts). Until all four tables exist with
-- every column below, the store reports storage unavailable and the API refuses before any provider send.
-- Creating the tables enables nothing: the feature stays off unless TITLE_WRITING_ENABLED=true, and is always off
-- when NODE_ENV=production.
-- No down migration. A code rollback keeps these tables; switch TITLE_WRITING_ENABLED off and forward-fix.

CREATE TABLE title_writing_run (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  actor_id text NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  input_hash text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  input_json jsonb NOT NULL,
  provider_key text NOT NULL CHECK (provider_key IN ('qwen', 'openai', 'deepseek')),
  model text NOT NULL,
  state text NOT NULL CHECK (state IN ('running', 'completed', 'partial', 'needs_attention', 'canceled', 'failed')),
  error_code text,
  cancel_requested_at timestamptz,
  -- Only the executor holding a live lease may change a running run; recovery acts after the lease expired.
  executor_id text,
  lease_until timestamptz,
  call_cap integer NOT NULL CHECK (call_cap BETWEEN 1 AND 50),
  calls_used integer NOT NULL DEFAULT 0 CHECK (calls_used >= 0 AND calls_used <= call_cap),
  story_save text NOT NULL DEFAULT 'pending' CHECK (story_save IN ('pending', 'saved', 'conflict')),
  story_revision_id uuid,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (workspace_id, actor_id, idempotency_key),
  UNIQUE (id, workspace_id),
  CHECK ((executor_id IS NULL) = (lease_until IS NULL)),
  CHECK (state = 'running' OR executor_id IS NULL),
  CHECK ((story_save = 'saved') = (story_revision_id IS NOT NULL)),
  FOREIGN KEY (project_id, workspace_id) REFERENCES project (id, workspace_id),
  FOREIGN KEY (story_revision_id, project_id, workspace_id) REFERENCES story_revision (id, project_id, workspace_id)
);

-- One running run per project. Workspace-wide active runs are capped by the store under an advisory lock.
CREATE UNIQUE INDEX title_writing_run_one_running_idx ON title_writing_run (project_id) WHERE state = 'running';
CREATE INDEX title_writing_run_project_idx ON title_writing_run (workspace_id, project_id, created_at DESC);
CREATE INDEX title_writing_run_lease_idx ON title_writing_run (lease_until) WHERE state = 'running';

CREATE TABLE title_writing_step (
  run_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  step_key text NOT NULL CHECK (step_key IN ('concept', 'outline', 'episode:1', 'episode:2', 'episode:3')),
  ordinal smallint NOT NULL CHECK (ordinal BETWEEN 0 AND 4),
  state text NOT NULL CHECK (state IN ('pending', 'reserved', 'submitted', 'completed', 'rejected', 'unknown', 'canceled')),
  attempt_no integer NOT NULL DEFAULT 0 CHECK (attempt_no >= 0),
  error_code text,
  output_json jsonb,
  output_hash text CHECK (output_hash IS NULL OR output_hash ~ '^[0-9a-f]{64}$'),
  script_save text CHECK (script_save IS NULL OR script_save IN ('pending', 'awaiting_story_approval', 'saved', 'conflict')),
  script_revision_id uuid,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (run_id, step_key),
  UNIQUE (run_id, ordinal),
  CHECK ((state = 'completed') = (output_json IS NOT NULL)),
  CHECK ((output_json IS NULL) = (output_hash IS NULL)),
  CHECK ((script_save IS NULL) = (step_key IN ('concept', 'outline'))),
  CHECK ((script_save = 'saved') = (script_revision_id IS NOT NULL)),
  FOREIGN KEY (run_id, workspace_id) REFERENCES title_writing_run (id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (script_revision_id) REFERENCES script_revision (id)
);

CREATE TABLE title_writing_call (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  step_key text NOT NULL,
  attempt_no integer NOT NULL CHECK (attempt_no >= 1),
  provider_key text NOT NULL CHECK (provider_key IN ('qwen', 'openai', 'deepseek')),
  model text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  state text NOT NULL CHECK (state IN ('reserved', 'submitted', 'completed', 'rejected', 'unknown')),
  executor_id text NOT NULL,
  provider_request_id text,
  response_model text,
  usage_json jsonb NOT NULL,
  -- Cost is never written as zero. There is no amount column until a reliable price source is reviewed.
  billing_status text NOT NULL DEFAULT 'unknown' CHECK (billing_status = 'unknown'),
  error_code text,
  created_at timestamptz NOT NULL,
  finished_at timestamptz,
  UNIQUE (run_id, step_key, attempt_no),
  CHECK ((state IN ('reserved', 'submitted')) = (finished_at IS NULL)),
  FOREIGN KEY (run_id, step_key) REFERENCES title_writing_step (run_id, step_key) ON DELETE CASCADE
);

CREATE INDEX title_writing_call_recent_idx ON title_writing_call (workspace_id, created_at);
CREATE INDEX title_writing_call_open_idx ON title_writing_call (run_id) WHERE state IN ('reserved', 'submitted');

-- One row per accepted resume action. The key is the Idempotency-Key of the resume request: a replay with the same key
-- and the same confirmation changes nothing and sends nothing; the same key with another confirmation is refused.
-- confirmed_call_ids are the uncertain calls the person confirmed; they must equal the run's current uncertain calls.
CREATE TABLE title_writing_resume (
  run_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  confirmed_call_ids jsonb NOT NULL CHECK (jsonb_typeof(confirmed_call_ids) = 'array'),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (run_id, idempotency_key),
  FOREIGN KEY (run_id, workspace_id) REFERENCES title_writing_run (id, workspace_id) ON DELETE CASCADE
);
