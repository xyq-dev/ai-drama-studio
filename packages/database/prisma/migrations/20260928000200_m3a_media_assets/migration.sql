CREATE TABLE asset (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('IMAGE','VIDEO','AUDIO','SUBTITLE','MUSIC','COMPOSITE')),
  storage_provider text NOT NULL,
  object_key text NOT NULL,
  mime_type text NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size >= 0),
  checksum_sha256 text NOT NULL CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
  width integer CHECK (width IS NULL OR width > 0),
  height integer CHECK (height IS NULL OR height > 0),
  duration_ms bigint CHECK (duration_ms IS NULL OR duration_ms > 0),
  source_job_attempt_id uuid NOT NULL,
  source_generation_job_id uuid NOT NULL,
  source_shot_revision_id uuid,
  provider_configuration_id uuid NOT NULL,
  provider_request_id text NOT NULL,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (storage_provider, object_key),
  UNIQUE (id, workspace_id),
  UNIQUE (id, project_id, workspace_id),
  FOREIGN KEY (project_id, workspace_id)
    REFERENCES project(id, workspace_id),
  FOREIGN KEY (source_job_attempt_id, provider_configuration_id, provider_request_id, workspace_id)
    REFERENCES job_attempt(id, provider_configuration_id, provider_request_id, workspace_id),
  FOREIGN KEY (source_job_attempt_id, source_generation_job_id, workspace_id)
    REFERENCES job_attempt(id, generation_job_id, workspace_id),
  FOREIGN KEY (source_generation_job_id, project_id, workspace_id)
    REFERENCES generation_job(id, project_id, workspace_id),
  FOREIGN KEY (source_shot_revision_id, project_id, workspace_id)
    REFERENCES shot_revision(id, project_id, workspace_id),
  CHECK ((width IS NULL) = (height IS NULL))
);

CREATE INDEX asset_project_kind_created_idx
  ON asset (workspace_id, project_id, kind, created_at DESC);

CREATE INDEX asset_shot_revision_idx
  ON asset (workspace_id, source_shot_revision_id, created_at DESC);

CREATE INDEX asset_content_lookup_idx
  ON asset (workspace_id, project_id, checksum_sha256, kind);

CREATE OR REPLACE FUNCTION m3_reject_asset_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'asset records are immutable';
END $$;

CREATE TRIGGER asset_immutable
BEFORE UPDATE OR DELETE ON asset
FOR EACH ROW EXECUTE FUNCTION m3_reject_asset_mutation();

ALTER TABLE cost_ledger
  ADD COLUMN idempotency_key text,
  ADD COLUMN provider_configuration_id uuid,
  ADD COLUMN provider_request_id text,
  ADD COLUMN supersedes_cost_id uuid,
  ADD CONSTRAINT cost_ledger_supersedes_fk
    FOREIGN KEY (supersedes_cost_id) REFERENCES cost_ledger(id),
  ADD CONSTRAINT cost_ledger_provider_attempt_fk
    FOREIGN KEY (job_attempt_id, provider_configuration_id, provider_request_id, workspace_id)
    REFERENCES job_attempt(id, provider_configuration_id, provider_request_id, workspace_id),
  ADD CONSTRAINT cost_ledger_provider_lineage_check
    CHECK (
      (provider_request_id IS NULL AND provider_configuration_id IS NULL)
      OR
      (
        provider_request_id IS NOT NULL
        AND provider_configuration_id IS NOT NULL
        AND job_attempt_id IS NOT NULL
        AND idempotency_key IS NOT NULL
      )
    );

CREATE UNIQUE INDEX cost_ledger_provider_idempotency_idx
  ON cost_ledger (workspace_id, provider_configuration_id, idempotency_key)
  WHERE provider_configuration_id IS NOT NULL AND idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX cost_ledger_internal_idempotency_idx
  ON cost_ledger (workspace_id, idempotency_key)
  WHERE provider_configuration_id IS NULL AND idempotency_key IS NOT NULL;

CREATE INDEX cost_ledger_provider_request_idx
  ON cost_ledger (workspace_id, provider_request_id);

CREATE OR REPLACE FUNCTION m3_validate_cost_supersession() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  previous cost_ledger%ROWTYPE;
BEGIN
  IF NEW.supersedes_cost_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT *
    INTO previous
    FROM cost_ledger
   WHERE id = NEW.supersedes_cost_id
   FOR KEY SHARE;

  IF previous.id IS NULL THEN
    RAISE EXCEPTION 'superseded cost record not found';
  END IF;

  IF NEW.kind <> 'ACTUAL'
     OR previous.kind <> 'ESTIMATED'
     OR NEW.workspace_id IS DISTINCT FROM previous.workspace_id
     OR NEW.project_id IS DISTINCT FROM previous.project_id
     OR NEW.generation_job_id IS DISTINCT FROM previous.generation_job_id
     OR NEW.job_attempt_id IS DISTINCT FROM previous.job_attempt_id
     OR NEW.provider IS DISTINCT FROM previous.provider
     OR NEW.model IS DISTINCT FROM previous.model THEN
    RAISE EXCEPTION 'actual cost must supersede an estimate with matching lineage';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER cost_ledger_supersession_valid
BEFORE INSERT OR UPDATE OF supersedes_cost_id ON cost_ledger
FOR EACH ROW EXECUTE FUNCTION m3_validate_cost_supersession();
