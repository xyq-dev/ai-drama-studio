-- DRAFT. Do not apply. Execution of this migration is not authorized.
-- Candidate expiry clears candidate_json only. The idempotency and audit row stays.

CREATE TABLE qwen_writing_request (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  actor_id text NOT NULL,
  idempotency_key text NOT NULL,
  input_hash text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  frozen_input jsonb NOT NULL,
  mode text NOT NULL CHECK (mode IN ('story', 'episode')),
  episode_no integer CHECK (episode_no IS NULL OR episode_no IN (1, 2, 3)),
  requested_model text NOT NULL,
  state text NOT NULL CHECK (state IN ('reserved', 'submitted', 'completed', 'rejected', 'unknown')),
  server_request_id text,
  error_code text,
  provider_result text CHECK (provider_result IS NULL OR provider_result IN ('completed', 'unknown')),
  candidate_json text,
  candidate_expires_at timestamptz,
  billing_status text NOT NULL DEFAULT 'unknown' CHECK (billing_status = 'unknown'),
  billing_amount numeric,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, actor_id, idempotency_key),
  CHECK (billing_amount IS NULL),
  CHECK ((mode = 'story' AND episode_no IS NULL)
    OR (mode = 'episode' AND episode_no IS NOT NULL AND episode_no IN (1, 2, 3))),
  CHECK (candidate_json IS NULL OR state = 'completed'),
  CHECK (state <> 'unknown' OR (provider_result IS NOT NULL AND provider_result = 'unknown')),
  FOREIGN KEY (project_id, workspace_id) REFERENCES project (id, workspace_id)
);

CREATE INDEX qwen_writing_request_open_idx
  ON qwen_writing_request (workspace_id, state)
  WHERE state IN ('reserved', 'submitted');

-- A future PostgreSQL store must reserve the idempotency key and workspace quota
-- atomically, and fence state transitions by execution ownership. A table alone
-- does not implement that protocol. Do not apply this draft to enable the route.
