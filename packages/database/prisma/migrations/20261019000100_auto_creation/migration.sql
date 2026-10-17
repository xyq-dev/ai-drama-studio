-- AI automatic creation runs (docs/AI_AUTO_CREATION.md).
-- Additive only: four new tables with their keys, checks and indexes. No existing table, column, constraint, function
-- or row is changed, so it is independent of 20261012000100_script_breakdown (applied or not) and of the writing
-- provider and candidate migrations. Requires the seven base migrations (project, story_revision, script_revision).
-- Read by PostgresAutoCreationStore (packages/database/src/auto-creation-store.ts). Until this migration is recorded in
-- schema_migration and every column exists, the API refuses automatic creation before any write or provider send.
-- Creating the tables enables nothing: the feature stays off unless AUTO_CREATION_ENABLED=true and title writing is on.
-- Locks: CREATE TABLE only; the foreign keys take SHARE ROW EXCLUSIVE on project, story_revision and script_revision for
-- the length of this transaction (no table scan, no rewrite). Applied alone with the guarded single-migration command.
-- No down migration. A code rollback keeps these tables (older code never reads them); forward-fix only.

CREATE TABLE auto_creation_run (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  actor_id text NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  input_hash text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  input_json jsonb NOT NULL,
  provider_key text NOT NULL CHECK (provider_key IN ('openai', 'anthropic', 'deepseek')),
  model text NOT NULL,
  state text NOT NULL CHECK (state IN ('running', 'completed', 'partial', 'needs_attention', 'canceled', 'failed')),
  error_code text,
  cancel_requested_at timestamptz,
  executor_id text,
  lease_until timestamptz,
  call_cap integer NOT NULL CHECK (call_cap BETWEEN 1 AND 60),
  calls_used integer NOT NULL DEFAULT 0 CHECK (calls_used >= 0 AND calls_used <= call_cap),
  revision_rounds_used smallint NOT NULL DEFAULT 0 CHECK (revision_rounds_used BETWEEN 0 AND 2),
  -- Machine quality check of the run's own output. Never a person's review and never a publication decision.
  quality text NOT NULL DEFAULT 'pending' CHECK (quality IN ('pending', 'passed', 'needs_work')),
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

CREATE UNIQUE INDEX auto_creation_run_one_running_idx ON auto_creation_run (project_id) WHERE state = 'running';
CREATE INDEX auto_creation_run_project_idx ON auto_creation_run (workspace_id, project_id, created_at DESC);
CREATE INDEX auto_creation_run_lease_idx ON auto_creation_run (lease_until) WHERE state = 'running';

CREATE TABLE auto_creation_stage (
  run_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  stage_key text NOT NULL CHECK (stage_key ~ '^(sources|research|directions|bible|outline|episode:[1-6]|review:[1-3]|revise:[1-2]:episode:[1-6])$'),
  ordinal smallint NOT NULL CHECK (ordinal BETWEEN 0 AND 30),
  state text NOT NULL CHECK (state IN ('pending', 'reserved', 'submitted', 'completed', 'rejected', 'unknown', 'canceled')),
  attempt_no integer NOT NULL DEFAULT 0 CHECK (attempt_no >= 0),
  error_code text,
  output_json jsonb,
  output_hash text CHECK (output_hash IS NULL OR output_hash ~ '^[0-9a-f]{64}$'),
  -- Output hashes of the stages this one was built from (upstream change detection).
  depends_on_json jsonb CHECK (depends_on_json IS NULL OR jsonb_typeof(depends_on_json) = 'object'),
  script_save text CHECK (script_save IS NULL OR script_save IN ('pending', 'saved', 'conflict')),
  script_revision_id uuid,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (run_id, stage_key),
  UNIQUE (run_id, ordinal),
  CHECK ((state = 'completed') = (output_json IS NOT NULL)),
  CHECK ((output_json IS NULL) = (output_hash IS NULL)),
  CHECK ((script_save IS NULL) = (stage_key !~ '^episode:')),
  CHECK ((script_save = 'saved') = (script_revision_id IS NOT NULL)),
  FOREIGN KEY (run_id, workspace_id) REFERENCES auto_creation_run (id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (script_revision_id) REFERENCES script_revision (id)
);

CREATE TABLE auto_creation_call (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  stage_key text NOT NULL,
  attempt_no integer NOT NULL CHECK (attempt_no >= 1),
  provider_key text NOT NULL CHECK (provider_key IN ('openai', 'anthropic', 'deepseek')),
  model text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  state text NOT NULL CHECK (state IN ('reserved', 'submitted', 'completed', 'rejected', 'unknown')),
  executor_id text NOT NULL,
  provider_request_id text,
  response_model text,
  usage_json jsonb NOT NULL,
  -- Cost is never written as zero: there is no amount column. Call outcome (state) and cost (billing) are separate.
  billing_status text NOT NULL DEFAULT 'unknown' CHECK (billing_status = 'unknown'),
  error_code text,
  created_at timestamptz NOT NULL,
  finished_at timestamptz,
  UNIQUE (run_id, stage_key, attempt_no),
  CHECK ((state IN ('reserved', 'submitted')) = (finished_at IS NULL)),
  FOREIGN KEY (run_id, stage_key) REFERENCES auto_creation_stage (run_id, stage_key) ON DELETE CASCADE
);

CREATE INDEX auto_creation_call_recent_idx ON auto_creation_call (workspace_id, created_at);
CREATE INDEX auto_creation_call_open_idx ON auto_creation_call (run_id) WHERE state IN ('reserved', 'submitted');

CREATE TABLE auto_creation_resume (
  run_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  confirmed_call_ids jsonb NOT NULL CHECK (jsonb_typeof(confirmed_call_ids) = 'array'),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (run_id, idempotency_key),
  FOREIGN KEY (run_id, workspace_id) REFERENCES auto_creation_run (id, workspace_id) ON DELETE CASCADE
);
