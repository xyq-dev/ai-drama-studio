CREATE TABLE workspace (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE project (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200), premise text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0), created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), archived_at timestamptz,
  UNIQUE (id, workspace_id), FOREIGN KEY (workspace_id) REFERENCES workspace(id)
);

CREATE TABLE provider_configuration (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL,
  provider_key text NOT NULL, capability text NOT NULL, enabled boolean NOT NULL DEFAULT true,
  encrypted_credential_ref text, default_timeout_ms integer NOT NULL CHECK (default_timeout_ms > 0),
  max_attempts smallint NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 3), policy_json jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (id, workspace_id),
  UNIQUE (workspace_id, provider_key, capability), FOREIGN KEY (workspace_id) REFERENCES workspace(id)
);

CREATE TABLE workflow_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, project_id uuid NOT NULL,
  type text NOT NULL, requested_by text NOT NULL, input_snapshot jsonb NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','RUNNING','SUCCEEDED','PARTIAL_FAILED','FAILED','CANCELED')),
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0), created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz, UNIQUE (id, workspace_id),
  UNIQUE (id, project_id, workspace_id),
  FOREIGN KEY (project_id, workspace_id) REFERENCES project(id, workspace_id)
);

CREATE TABLE generation_job (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, project_id uuid NOT NULL,
  workflow_run_id uuid NOT NULL, kind text NOT NULL,
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','QUEUED','RUNNING','WAITING_EXTERNAL','SUCCEEDED','FAILED','CANCELED')),
  input_hash text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'), input_snapshot jsonb NOT NULL,
  dispatch_seq integer NOT NULL DEFAULT 0 CHECK (dispatch_seq >= 0), row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  next_run_at timestamptz, lease_owner text, lease_until timestamptz, cancel_requested_at timestamptz,
  retry_count integer NOT NULL DEFAULT 0 CHECK (retry_count >= 0), is_critical boolean NOT NULL DEFAULT true,
  progress_weight integer NOT NULL DEFAULT 1 CHECK (progress_weight > 0), progress smallint NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  error_code text, error_message text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz, UNIQUE (id, workspace_id), UNIQUE (id, workflow_run_id, workspace_id),
  FOREIGN KEY (workflow_run_id, project_id, workspace_id) REFERENCES workflow_run(id, project_id, workspace_id),
  FOREIGN KEY (project_id, workspace_id) REFERENCES project(id, workspace_id),
  CHECK (state <> 'QUEUED' OR dispatch_seq > 0),
  CHECK ((lease_owner IS NULL) = (lease_until IS NULL)),
  CHECK ((state = 'RUNNING' AND lease_owner IS NOT NULL) OR (state <> 'RUNNING' AND lease_owner IS NULL))
);

CREATE INDEX generation_job_runnable_idx ON generation_job (state, next_run_at);
CREATE INDEX generation_job_lease_idx ON generation_job (lease_until) WHERE lease_until IS NOT NULL;

CREATE TABLE generation_job_dependency (
  workflow_run_id uuid NOT NULL, workspace_id uuid NOT NULL, job_id uuid NOT NULL, depends_on_job_id uuid NOT NULL,
  dependency_condition text NOT NULL DEFAULT 'SUCCEEDED' CHECK (dependency_condition IN ('SUCCEEDED','TERMINAL')),
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (job_id, depends_on_job_id),
  FOREIGN KEY (workflow_run_id, workspace_id) REFERENCES workflow_run(id, workspace_id),
  FOREIGN KEY (job_id, workflow_run_id, workspace_id) REFERENCES generation_job(id, workflow_run_id, workspace_id),
  FOREIGN KEY (depends_on_job_id, workflow_run_id, workspace_id) REFERENCES generation_job(id, workflow_run_id, workspace_id),
  CHECK (job_id <> depends_on_job_id)
);

CREATE TABLE job_attempt (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, generation_job_id uuid NOT NULL,
  attempt_no integer NOT NULL CHECK (attempt_no > 0), provider_configuration_id uuid,
  provider_request_id text, provider_client_request_key text NOT NULL, request_snapshot jsonb NOT NULL,
  response_snapshot jsonb, error_json jsonb, started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
  UNIQUE (generation_job_id, attempt_no), UNIQUE (provider_client_request_key), UNIQUE (id, workspace_id),
  UNIQUE (id, generation_job_id, workspace_id),
  UNIQUE (id, provider_configuration_id, workspace_id),
  FOREIGN KEY (generation_job_id, workspace_id) REFERENCES generation_job(id, workspace_id),
  FOREIGN KEY (provider_configuration_id, workspace_id) REFERENCES provider_configuration(id, workspace_id),
  CHECK (provider_request_id IS NULL OR provider_configuration_id IS NOT NULL)
);
CREATE UNIQUE INDEX job_attempt_provider_request_idx
  ON job_attempt (provider_configuration_id, provider_request_id) WHERE provider_request_id IS NOT NULL;

CREATE TABLE dispatch_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, job_id uuid NOT NULL,
  dispatch_seq integer NOT NULL CHECK (dispatch_seq > 0), payload_version integer NOT NULL DEFAULT 1,
  available_at timestamptz NOT NULL DEFAULT now(), dispatched_at timestamptz, dispatch_attempts integer NOT NULL DEFAULT 0,
  last_error text, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (job_id, dispatch_seq),
  FOREIGN KEY (job_id, workspace_id) REFERENCES generation_job(id, workspace_id)
);
CREATE INDEX dispatch_outbox_pending_idx ON dispatch_outbox (available_at) WHERE dispatched_at IS NULL;

CREATE TABLE domain_event (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, workspace_id uuid NOT NULL, project_id uuid,
  aggregate_type text NOT NULL, aggregate_id uuid NOT NULL, event_type text NOT NULL,
  payload_version integer NOT NULL DEFAULT 1, payload_json jsonb NOT NULL, trace_id text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(), retention_until timestamptz,
  FOREIGN KEY (workspace_id) REFERENCES workspace(id), FOREIGN KEY (project_id, workspace_id) REFERENCES project(id, workspace_id)
);
CREATE INDEX domain_event_replay_idx ON domain_event (workspace_id, id);
CREATE INDEX domain_event_retention_idx ON domain_event (retention_until) WHERE retention_until IS NOT NULL;

CREATE TABLE idempotency_record (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, actor_id text NOT NULL,
  http_method text NOT NULL, route_key text NOT NULL, idempotency_key text NOT NULL, request_hash text NOT NULL,
  response_status integer, response_body jsonb, created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
  UNIQUE (workspace_id, actor_id, http_method, route_key, idempotency_key), FOREIGN KEY (workspace_id) REFERENCES workspace(id),
  CHECK (request_hash ~ '^[0-9a-f]{64}$'), CHECK (response_status IS NOT NULL OR response_body IS NULL)
);

CREATE TABLE provider_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, provider_configuration_id uuid NOT NULL,
  job_attempt_id uuid NOT NULL, provider_request_id text NOT NULL,
  source text NOT NULL CHECK (source IN ('CALLBACK','POLL')), normalized_event_key text NOT NULL,
  external_status text NOT NULL, payload_ref text, received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_configuration_id, provider_request_id, normalized_event_key),
  FOREIGN KEY (provider_configuration_id, workspace_id) REFERENCES provider_configuration(id, workspace_id),
  FOREIGN KEY (job_attempt_id, provider_configuration_id, workspace_id)
    REFERENCES job_attempt(id, provider_configuration_id, workspace_id)
);

CREATE TABLE cost_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, project_id uuid NOT NULL,
  generation_job_id uuid NOT NULL, job_attempt_id uuid, currency char(3) NOT NULL,
  amount_decimal numeric(20,8) NOT NULL CHECK (amount_decimal >= 0), kind text NOT NULL CHECK (kind IN ('ESTIMATED','ACTUAL')),
  basis text NOT NULL CHECK (basis IN ('PROVIDER_REPORTED','LOCALLY_CALCULATED')), unit_type text,
  unit_quantity numeric(20,8), unit_price_snapshot numeric(20,8), provider text NOT NULL, model text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, workspace_id) REFERENCES project(id, workspace_id),
  FOREIGN KEY (generation_job_id, workspace_id) REFERENCES generation_job(id, workspace_id),
  FOREIGN KEY (job_attempt_id, generation_job_id, workspace_id)
    REFERENCES job_attempt(id, generation_job_id, workspace_id)
);
CREATE INDEX cost_ledger_job_idx ON cost_ledger (generation_job_id, occurred_at);

CREATE OR REPLACE FUNCTION validate_dispatch_outbox_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_state text; current_seq integer; current_workspace uuid;
BEGIN
  SELECT state, dispatch_seq, workspace_id INTO current_state, current_seq, current_workspace
  FROM generation_job WHERE id = NEW.job_id FOR KEY SHARE;
  IF current_state IS DISTINCT FROM 'QUEUED'
    OR current_seq IS DISTINCT FROM NEW.dispatch_seq
    OR current_workspace IS DISTINCT FROM NEW.workspace_id THEN
    RAISE EXCEPTION 'outbox dispatch must match the current queued job generation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER dispatch_outbox_matches_job BEFORE INSERT ON dispatch_outbox
FOR EACH ROW EXECUTE FUNCTION validate_dispatch_outbox_insert();

-- Enforce that every outbox signal represents the exact dispatch generation that
-- was committed for its job; old rows remain immutable audit facts.
CREATE OR REPLACE FUNCTION reject_dispatch_outbox_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.job_id <> OLD.job_id OR NEW.dispatch_seq <> OLD.dispatch_seq OR NEW.workspace_id <> OLD.workspace_id THEN
    RAISE EXCEPTION 'dispatch identity is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER dispatch_outbox_identity_immutable BEFORE UPDATE ON dispatch_outbox
FOR EACH ROW EXECUTE FUNCTION reject_dispatch_outbox_mutation();
