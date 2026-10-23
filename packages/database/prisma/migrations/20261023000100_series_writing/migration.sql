-- Series writing (docs/SERIES_WRITING.md): a work of 1–60 episodes planned once, written three episodes at a time with
-- a continuity ledger, every batch reviewed in full and the whole series reviewed for structure and continuity.
-- Expand only. Existing rows keep their meaning:
--   * project gains writing_mode (constant default 'short', metadata only on PostgreSQL 11+). Every existing project is a
--     short-drama work and stays held to 1–6 episodes by the replaced episode-count CHECK; only a series work may have
--     7–60 episodes, and a series work always has a target per episode. Existing rows satisfy the new CHECKs.
--   * the episode number CHECK widens from 1–6 to 1–60 (a superset), and a trigger keeps what the old CHECK held for every
--     short-drama work: an episode past 6 is accepted only for a series work and never past its own episode count. No
--     episode row is written or rewritten.
--   * nine new series_writing_ tables. No existing table, function or row is changed besides the two CHECKs above;
--     title_writing_*, auto_creation_* and writing_candidate_request are untouched, so it is independent of the script
--     breakdown, provider, candidate and automatic creation migrations (applied or not).
-- Media production keeps its 1–6 episode check (domain productionEpisodeNumbers) and refuses series works outright, so
-- this opens no media production for 60 episodes.
-- Read by PostgresSeriesWritingStore (packages/database/src/series-writing-store.ts). Until this migration is recorded in
-- schema_migration and every column exists, the API refuses series writing before any write or provider send.
-- Requires the seven base migrations (project.episode_count, project_episode_count_check and target_episode_seconds come
-- from 20261011000100_episode_plan).
-- Locks: ALTER TABLE takes ACCESS EXCLUSIVE on project and episode for the length of this transaction and the new CHECKs
-- scan those tables once while validating; the new tables' foreign keys take SHARE ROW EXCLUSIVE on project,
-- story_revision and script_revision. Run it in a quiet window, applied alone with the guarded single-migration command.
-- No down migration. A code rollback keeps the column, the wider ranges and the tables (older code never writes a series
-- work and never reads the tables); forward-fix only.

ALTER TABLE project ADD COLUMN writing_mode text NOT NULL DEFAULT 'short';
ALTER TABLE project ADD CONSTRAINT project_writing_mode_check CHECK (writing_mode IN ('short', 'series'));
ALTER TABLE project DROP CONSTRAINT project_episode_count_check;
ALTER TABLE project ADD CONSTRAINT project_episode_count_check
  CHECK (episode_count BETWEEN 1 AND 60 AND (episode_count <= 6 OR writing_mode = 'series'));
ALTER TABLE project ADD CONSTRAINT project_series_plan_check CHECK (writing_mode = 'short' OR target_episode_seconds IS NOT NULL);

ALTER TABLE episode DROP CONSTRAINT episode_episode_no_check;
ALTER TABLE episode ADD CONSTRAINT episode_episode_no_check CHECK (episode_no BETWEEN 1 AND 60);

-- A CHECK cannot read the project, so a trigger does: a short-drama work keeps episodes 1–6 exactly as before.
CREATE FUNCTION series_writing_episode_range() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  mode text;
  total smallint;
BEGIN
  IF NEW.episode_no <= 6 THEN
    RETURN NEW;
  END IF;
  SELECT writing_mode, episode_count INTO mode, total FROM project WHERE id = NEW.project_id;
  IF mode IS DISTINCT FROM 'series' OR NEW.episode_no > total THEN
    RAISE EXCEPTION 'episode_episode_no_check: episode % is outside the episode range of its work', NEW.episode_no
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER series_writing_episode_range BEFORE INSERT OR UPDATE OF episode_no, project_id ON episode
  FOR EACH ROW EXECUTE FUNCTION series_writing_episode_range();

CREATE TABLE series_writing_series (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL UNIQUE,
  actor_id text NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  input_hash text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  input_json jsonb NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 60),
  episode_count smallint NOT NULL CHECK (episode_count BETWEEN 1 AND 60),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (workspace_id, actor_id, idempotency_key),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (project_id, workspace_id) REFERENCES project (id, workspace_id)
);

-- A grant is one authorization: the scope, normal calls and budget the confirmation card froze, with its provider and model.
CREATE TABLE series_writing_grant (
  id uuid PRIMARY KEY,
  series_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  actor_id text NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  input_json jsonb NOT NULL,
  provider_key text NOT NULL CHECK (provider_key IN ('openai', 'anthropic', 'deepseek')),
  model text NOT NULL,
  call_budget integer NOT NULL CHECK (call_budget BETWEEN 1 AND 202),
  calls_used integer NOT NULL DEFAULT 0 CHECK (calls_used >= 0 AND calls_used <= call_budget),
  state text NOT NULL CHECK (state IN ('running', 'completed', 'stopped', 'canceled')),
  stop_reason text,
  cancel_requested_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (workspace_id, actor_id, idempotency_key),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (series_id, workspace_id) REFERENCES series_writing_series (id, workspace_id)
);

CREATE UNIQUE INDEX series_writing_grant_one_running_idx ON series_writing_grant (series_id) WHERE state = 'running';

-- A job is one sub-task of a grant (the plan, one batch, the final review), held to the per-run cap of 60 calls.
CREATE TABLE series_writing_run (
  id uuid PRIMARY KEY,
  -- 1, 2, … in creation order within the series (timestamps may tie): the order the state reads jobs in.
  job_seq integer NOT NULL CHECK (job_seq > 0),
  series_id uuid NOT NULL,
  grant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  job_kind text NOT NULL CHECK (job_kind IN ('plan', 'batch', 'final')),
  batch_no smallint CHECK (batch_no IS NULL OR batch_no BETWEEN 1 AND 20),
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
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (id, workspace_id),
  UNIQUE (series_id, job_seq),
  CHECK ((executor_id IS NULL) = (lease_until IS NULL)),
  CHECK (state = 'running' OR executor_id IS NULL),
  CHECK ((job_kind = 'batch') = (batch_no IS NOT NULL)),
  FOREIGN KEY (grant_id, workspace_id) REFERENCES series_writing_grant (id, workspace_id),
  FOREIGN KEY (series_id, workspace_id) REFERENCES series_writing_series (id, workspace_id)
);

CREATE UNIQUE INDEX series_writing_run_one_running_idx ON series_writing_run (project_id) WHERE state = 'running';
CREATE INDEX series_writing_run_series_idx ON series_writing_run (series_id, created_at);
CREATE INDEX series_writing_run_lease_idx ON series_writing_run (lease_until) WHERE state = 'running';

CREATE TABLE series_writing_stage (
  run_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  stage_key text NOT NULL CHECK (stage_key ~ '^(sources|research|directions|setting|arc|outline:([1-9]|10)|plan_review|episode:([1-9]|[1-5][0-9]|60)|batch_review:([1-9]|1[0-9]|20)|final_review)$'),
  ordinal smallint NOT NULL CHECK (ordinal BETWEEN 0 AND 30),
  state text NOT NULL CHECK (state IN ('pending', 'reserved', 'submitted', 'completed', 'rejected', 'unknown', 'canceled')),
  attempt_no integer NOT NULL DEFAULT 0 CHECK (attempt_no >= 0),
  error_code text,
  output_json jsonb,
  output_hash text CHECK (output_hash IS NULL OR output_hash ~ '^[0-9a-f]{64}$'),
  depends_on_json jsonb CHECK (depends_on_json IS NULL OR jsonb_typeof(depends_on_json) = 'object'),
  -- The stopped job a completed stage was taken over from (no call was made for it here).
  reused_from uuid,
  script_save text CHECK (script_save IS NULL OR script_save IN ('pending', 'saved', 'conflict')),
  script_revision_id uuid,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (run_id, stage_key),
  UNIQUE (run_id, ordinal),
  CHECK ((state = 'completed') = (output_json IS NOT NULL)),
  CHECK ((output_json IS NULL) = (output_hash IS NULL)),
  CHECK ((script_save IS NULL) = (stage_key !~ '^episode:')),
  CHECK ((script_save = 'saved') = (script_revision_id IS NOT NULL)),
  CHECK (reused_from IS NULL OR state = 'completed'),
  FOREIGN KEY (run_id, workspace_id) REFERENCES series_writing_run (id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (script_revision_id) REFERENCES script_revision (id)
);

CREATE TABLE series_writing_call (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL,
  grant_id uuid NOT NULL,
  series_id uuid NOT NULL,
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
  FOREIGN KEY (run_id, stage_key) REFERENCES series_writing_stage (run_id, stage_key) ON DELETE CASCADE,
  FOREIGN KEY (grant_id, workspace_id) REFERENCES series_writing_grant (id, workspace_id)
);

CREATE INDEX series_writing_call_recent_idx ON series_writing_call (workspace_id, created_at);
CREATE INDEX series_writing_call_open_idx ON series_writing_call (run_id) WHERE state IN ('reserved', 'submitted');

-- Plan revisions are never updated: a person's edit is a new revision, the model's plan stays as it was.
CREATE TABLE series_writing_plan_revision (
  id uuid PRIMARY KEY,
  series_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  revision_no integer NOT NULL CHECK (revision_no > 0),
  origin text NOT NULL CHECK (origin IN ('model', 'manual')),
  source_run_id uuid,
  parent_revision_id uuid,
  content_json jsonb NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  review_json jsonb,
  story_revision_id uuid,
  story_save text NOT NULL CHECK (story_save IN ('pending', 'saved', 'conflict')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (series_id, revision_no),
  CHECK ((origin = 'model') = (source_run_id IS NOT NULL)),
  CHECK ((story_save = 'saved') = (story_revision_id IS NOT NULL)),
  FOREIGN KEY (series_id, workspace_id) REFERENCES series_writing_series (id, workspace_id),
  FOREIGN KEY (story_revision_id) REFERENCES story_revision (id)
);

-- Ledger revisions are never updated: each is bound to the plan, the previous ledger and the episode versions it describes.
CREATE TABLE series_writing_ledger_revision (
  id uuid PRIMARY KEY,
  series_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  batch_no smallint NOT NULL CHECK (batch_no BETWEEN 1 AND 20),
  revision_no integer NOT NULL CHECK (revision_no > 0),
  origin text NOT NULL CHECK (origin IN ('program', 'manual')),
  content_json jsonb NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  summaries_json jsonb NOT NULL CHECK (jsonb_typeof(summaries_json) = 'array'),
  basis_json jsonb NOT NULL CHECK (jsonb_typeof(basis_json) = 'object'),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (series_id, batch_no, revision_no),
  FOREIGN KEY (series_id, workspace_id) REFERENCES series_writing_series (id, workspace_id)
);

-- A person's decision on a machine finding or an upstream change, bound to the hashes of the versions it covers.
CREATE TABLE series_writing_decision (
  id uuid PRIMARY KEY,
  series_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  target text NOT NULL CHECK (target ~ '^(plan|batch:([1-9]|1[0-9]|20)|final)$'),
  basis_json jsonb NOT NULL CHECK (jsonb_typeof(basis_json) = 'object'),
  note text NOT NULL CHECK (length(note) BETWEEN 1 AND 300),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  FOREIGN KEY (series_id, workspace_id) REFERENCES series_writing_series (id, workspace_id)
);

CREATE TABLE series_writing_resume (
  grant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  confirmed_call_ids jsonb NOT NULL CHECK (jsonb_typeof(confirmed_call_ids) = 'array'),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (grant_id, idempotency_key),
  FOREIGN KEY (grant_id, workspace_id) REFERENCES series_writing_grant (id, workspace_id)
);
