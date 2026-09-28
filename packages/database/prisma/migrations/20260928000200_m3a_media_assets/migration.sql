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
  source_kind text NOT NULL DEFAULT 'PROVIDER',
  source_job_attempt_id uuid,
  source_generation_job_id uuid,
  source_shot_revision_id uuid,
  provider_configuration_id uuid,
  provider_request_id text,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','STALE','SUPERSEDED','FAILED','DELETED')),
  review_status text NOT NULL DEFAULT 'DRAFT' CHECK (review_status IN ('DRAFT','APPROVED','REJECTED')),
  reviewed_by text,
  reviewed_at timestamptz,
  review_note text,
  reviewed_content_hash text,
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
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
  CHECK ((width IS NULL) = (height IS NULL)),
  CONSTRAINT asset_review_check CHECK (
    (review_status = 'DRAFT' AND reviewed_by IS NULL AND reviewed_at IS NULL
      AND review_note IS NULL AND reviewed_content_hash IS NULL)
    OR (review_status IN ('APPROVED','REJECTED') AND reviewed_by IS NOT NULL
      AND reviewed_at IS NOT NULL AND reviewed_content_hash = checksum_sha256)
  ),
  CONSTRAINT asset_approval_kind_check CHECK (review_status <> 'APPROVED' OR kind = 'COMPOSITE'),
  CONSTRAINT asset_source_kind_check CHECK (
    (source_kind = 'PROVIDER' AND source_job_attempt_id IS NOT NULL
      AND source_generation_job_id IS NOT NULL
      AND provider_configuration_id IS NOT NULL AND provider_request_id IS NOT NULL)
    OR (source_kind = 'LOCAL_JOB' AND source_job_attempt_id IS NOT NULL
      AND source_generation_job_id IS NOT NULL
      AND provider_configuration_id IS NULL AND provider_request_id IS NULL)
    OR (source_kind = 'UPLOAD' AND source_job_attempt_id IS NULL
      AND source_generation_job_id IS NULL
      AND provider_configuration_id IS NULL AND provider_request_id IS NULL)
  )
);

CREATE TABLE asset_dependency (
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  dependent_asset_id uuid NOT NULL,
  source_asset_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (dependent_asset_id, source_asset_id),
  CONSTRAINT asset_dependency_not_self CHECK (dependent_asset_id <> source_asset_id),
  FOREIGN KEY (dependent_asset_id, project_id, workspace_id)
    REFERENCES asset(id, project_id, workspace_id),
  FOREIGN KEY (source_asset_id, project_id, workspace_id)
    REFERENCES asset(id, project_id, workspace_id)
);

CREATE INDEX asset_dependency_source_idx
  ON asset_dependency (workspace_id, project_id, source_asset_id);

-- Each edge points to exactly one typed, immutable source revision. All five
-- composite FKs share project and workspace, preventing cross-project lineage.
CREATE TABLE asset_revision_dependency (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  dependent_asset_id uuid NOT NULL,
  shot_revision_id uuid,
  scene_revision_id uuid,
  script_revision_id uuid,
  character_revision_id uuid,
  location_revision_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT asset_revision_dependency_one_source CHECK (
    num_nonnulls(shot_revision_id, scene_revision_id, script_revision_id,
                 character_revision_id, location_revision_id) = 1
  ),
  FOREIGN KEY (dependent_asset_id, project_id, workspace_id)
    REFERENCES asset(id, project_id, workspace_id),
  FOREIGN KEY (shot_revision_id, project_id, workspace_id)
    REFERENCES shot_revision(id, project_id, workspace_id),
  FOREIGN KEY (scene_revision_id, project_id, workspace_id)
    REFERENCES scene_revision(id, project_id, workspace_id),
  FOREIGN KEY (script_revision_id, project_id, workspace_id)
    REFERENCES script_revision(id, project_id, workspace_id),
  FOREIGN KEY (character_revision_id, project_id, workspace_id)
    REFERENCES character_revision(id, project_id, workspace_id),
  FOREIGN KEY (location_revision_id, project_id, workspace_id)
    REFERENCES location_revision(id, project_id, workspace_id)
);

CREATE UNIQUE INDEX asset_revision_dependency_shot_key
  ON asset_revision_dependency (dependent_asset_id, shot_revision_id)
  WHERE shot_revision_id IS NOT NULL;
CREATE UNIQUE INDEX asset_revision_dependency_scene_key
  ON asset_revision_dependency (dependent_asset_id, scene_revision_id)
  WHERE scene_revision_id IS NOT NULL;
CREATE UNIQUE INDEX asset_revision_dependency_script_key
  ON asset_revision_dependency (dependent_asset_id, script_revision_id)
  WHERE script_revision_id IS NOT NULL;
CREATE UNIQUE INDEX asset_revision_dependency_character_key
  ON asset_revision_dependency (dependent_asset_id, character_revision_id)
  WHERE character_revision_id IS NOT NULL;
CREATE UNIQUE INDEX asset_revision_dependency_location_key
  ON asset_revision_dependency (dependent_asset_id, location_revision_id)
  WHERE location_revision_id IS NOT NULL;

CREATE INDEX asset_revision_dependency_shot_source_idx
  ON asset_revision_dependency (workspace_id, project_id, shot_revision_id);
CREATE INDEX asset_revision_dependency_scene_source_idx
  ON asset_revision_dependency (workspace_id, project_id, scene_revision_id);
CREATE INDEX asset_revision_dependency_script_source_idx
  ON asset_revision_dependency (workspace_id, project_id, script_revision_id);
CREATE INDEX asset_revision_dependency_character_source_idx
  ON asset_revision_dependency (workspace_id, project_id, character_revision_id);
CREATE INDEX asset_revision_dependency_location_source_idx
  ON asset_revision_dependency (workspace_id, project_id, location_revision_id);

CREATE INDEX asset_project_kind_created_idx
  ON asset (workspace_id, project_id, kind, created_at DESC);

CREATE INDEX asset_shot_revision_idx
  ON asset (workspace_id, source_shot_revision_id, created_at DESC);

CREATE INDEX asset_content_lookup_idx
  ON asset (workspace_id, project_id, checksum_sha256, kind);

CREATE INDEX asset_status_idx
  ON asset (workspace_id, project_id, status);

CREATE OR REPLACE FUNCTION m3_reject_asset_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'asset records are immutable';
END $$;

CREATE OR REPLACE FUNCTION m3_guard_asset_lifecycle() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'ACTIVE' OR NEW.review_status <> 'DRAFT' OR NEW.row_version <> 1 THEN
      RAISE EXCEPTION 'new asset must start ACTIVE and DRAFT at version one';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'asset records are immutable';
  END IF;

  IF (to_jsonb(NEW) - ARRAY['status','review_status','reviewed_by','reviewed_at',
                           'review_note','reviewed_content_hash','row_version'])
     IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['status','review_status','reviewed_by','reviewed_at',
                           'review_note','reviewed_content_hash','row_version']) THEN
    RAISE EXCEPTION 'asset records are immutable: content and provenance';
  END IF;

  IF NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION 'asset row_version must advance by one';
  END IF;

  IF NEW.status <> OLD.status AND NOT (
    (OLD.status = 'ACTIVE' AND NEW.status IN ('STALE','SUPERSEDED','FAILED','DELETED'))
    OR (OLD.status = 'STALE' AND NEW.status IN ('SUPERSEDED','DELETED'))
    OR (OLD.status IN ('SUPERSEDED','FAILED') AND NEW.status = 'DELETED')
  ) THEN
    RAISE EXCEPTION 'invalid asset status transition';
  END IF;

  IF (NEW.review_status, NEW.reviewed_by, NEW.reviewed_at, NEW.review_note,
      NEW.reviewed_content_hash) IS DISTINCT FROM
     (OLD.review_status, OLD.reviewed_by, OLD.reviewed_at, OLD.review_note,
      OLD.reviewed_content_hash) THEN
    IF OLD.review_status <> 'DRAFT' OR NEW.review_status NOT IN ('APPROVED','REJECTED')
       OR NEW.status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'invalid asset review transition';
    END IF;
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER asset_lifecycle_guard
BEFORE INSERT OR UPDATE OR DELETE ON asset
FOR EACH ROW EXECUTE FUNCTION m3_guard_asset_lifecycle();

CREATE TRIGGER asset_dependency_immutable
BEFORE UPDATE OR DELETE ON asset_dependency
FOR EACH ROW EXECUTE FUNCTION m3_reject_asset_mutation();

CREATE TRIGGER asset_revision_dependency_immutable
BEFORE UPDATE OR DELETE ON asset_revision_dependency
FOR EACH ROW EXECUTE FUNCTION m3_reject_asset_mutation();

ALTER TABLE cost_ledger
  ADD COLUMN idempotency_key text,
  ADD COLUMN provider_configuration_id uuid,
  ADD COLUMN provider_request_id text,
  ADD COLUMN supersedes_cost_id uuid,
  ADD COLUMN supersedes_estimate_key text,
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
  IF NEW.supersedes_estimate_key IS NOT NULL THEN
    IF NEW.idempotency_key IS NULL THEN
      RAISE EXCEPTION 'superseding cost requires an idempotency key';
    END IF;

    SELECT * INTO previous
      FROM cost_ledger
     WHERE workspace_id = NEW.workspace_id
       AND provider_configuration_id IS NOT DISTINCT FROM NEW.provider_configuration_id
       AND idempotency_key = NEW.supersedes_estimate_key
     FOR KEY SHARE;

    IF previous.id IS NULL THEN
      RAISE EXCEPTION 'superseded estimate key not found';
    END IF;
    IF NEW.supersedes_cost_id IS NOT NULL AND NEW.supersedes_cost_id <> previous.id THEN
      RAISE EXCEPTION 'superseded estimate key does not match cost id';
    END IF;
    NEW.supersedes_cost_id := previous.id;
  END IF;

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
     OR NEW.provider_configuration_id IS DISTINCT FROM previous.provider_configuration_id
     OR NEW.provider_request_id IS DISTINCT FROM previous.provider_request_id
     OR NEW.provider IS DISTINCT FROM previous.provider
     OR NEW.model IS DISTINCT FROM previous.model THEN
    RAISE EXCEPTION 'actual cost must supersede an estimate with matching lineage';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER cost_ledger_supersession_valid
BEFORE INSERT OR UPDATE OF supersedes_cost_id, supersedes_estimate_key ON cost_ledger
FOR EACH ROW EXECUTE FUNCTION m3_validate_cost_supersession();

-- Supersession checks the estimate at insertion time. Keep both sides of that
-- relationship immutable so a later edit or deletion cannot invalidate it.
CREATE OR REPLACE FUNCTION m3_reject_cost_ledger_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'cost_ledger entries are immutable';
END $$;

CREATE TRIGGER cost_ledger_immutable
BEFORE UPDATE OR DELETE ON cost_ledger
FOR EACH ROW EXECUTE FUNCTION m3_reject_cost_ledger_mutation();
