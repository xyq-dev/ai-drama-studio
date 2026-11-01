-- DRAFT ONLY. Not in the migration directory; never executed by application startup.
-- Single-operation authorizations and provider receipts supplement existing jobs/attempts/assets.
CREATE TABLE real_media_authorization (
  quote_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  shot_revision_id uuid NOT NULL,
  actor_id text NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 200),
  input_hash text NOT NULL CHECK(input_hash ~ '^[a-f0-9]{64}$'),
  input_snapshot jsonb NOT NULL CHECK(jsonb_typeof(input_snapshot) IS NOT DISTINCT FROM 'object'
    AND input_snapshot->>'schema' IS NOT DISTINCT FROM 'real-media.v1' AND octet_length(input_snapshot::text)<=131072),
  configuration_snapshot jsonb NOT NULL CHECK(jsonb_typeof(configuration_snapshot) IS NOT DISTINCT FROM 'object'
    AND octet_length(configuration_snapshot::text)<=16384),
  currency text NOT NULL CHECK(currency IN ('CNY','USD')),
  estimated_amount numeric(20,8) NOT NULL CHECK(estimated_amount>=0),
  maximum_amount numeric(20,8) NOT NULL CHECK(maximum_amount>=estimated_amount),
  quote_limit_amount numeric(20,8) NOT NULL CHECK(quote_limit_amount>=maximum_amount),
  uncertain_job_ids uuid[] NOT NULL DEFAULT '{}' CHECK(cardinality(uncertain_job_ids)<=20),
  confirmed_uncertain_job_ids uuid[],
  expires_at timestamptz NOT NULL,
  authorization_id uuid UNIQUE,
  authorized_at timestamptz,
  job_id uuid UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK((authorization_id IS NULL)=(authorized_at IS NULL)),
  CHECK((authorization_id IS NULL)=(confirmed_uncertain_job_ids IS NULL)),
  CHECK(confirmed_uncertain_job_ids IS NULL OR confirmed_uncertain_job_ids=uncertain_job_ids),
  CHECK(job_id IS NULL OR authorization_id IS NOT NULL),
  CHECK(expires_at>created_at),
  CHECK(input_snapshot->>'shotRevisionId' IS NOT DISTINCT FROM shot_revision_id::text
    AND input_snapshot->'configuration' IS NOT DISTINCT FROM configuration_snapshot
    AND configuration_snapshot->>'currency' IS NOT DISTINCT FROM currency
    AND input_snapshot->>'capability' IS NOT DISTINCT FROM configuration_snapshot->>'capability'),
  FOREIGN KEY(project_id,workspace_id) REFERENCES project(id,workspace_id),
  FOREIGN KEY(shot_revision_id,project_id,workspace_id) REFERENCES shot_revision(id,project_id,workspace_id),
  FOREIGN KEY(job_id,project_id,workspace_id) REFERENCES generation_job(id,project_id,workspace_id)
);
CREATE TABLE real_media_submission (
  job_attempt_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  generation_job_id uuid NOT NULL UNIQUE,
  provider_configuration_id uuid NOT NULL,
  provider_request_id text CHECK(length(provider_request_id) BETWEEN 1 AND 240),
  input_hash text NOT NULL CHECK(input_hash ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK(state IN ('INTENT','ACKNOWLEDGED','UNKNOWN','SUCCEEDED','FAILED','REJECTED')),
  estimated_amount numeric(20,8) NOT NULL CHECK(estimated_amount>=0),
  currency text NOT NULL CHECK(currency IN ('CNY','USD')),
  -- Only authenticated ciphertext. No signed URLs, data URLs, raw errors or credentials in public records.
  outputs_ciphertext text CHECK(octet_length(outputs_ciphertext)<=8388608),
  usage_json jsonb CHECK(octet_length(usage_json::text)<=8192),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(state NOT IN ('ACKNOWLEDGED','SUCCEEDED','FAILED') OR provider_request_id IS NOT NULL),
  CHECK(state<>'SUCCEEDED' OR outputs_ciphertext IS NOT NULL),
  CHECK(state<>'REJECTED' OR (provider_request_id IS NULL AND outputs_ciphertext IS NULL)),
  FOREIGN KEY(job_attempt_id,generation_job_id,workspace_id) REFERENCES job_attempt(id,generation_job_id,workspace_id),
  FOREIGN KEY(generation_job_id,project_id,workspace_id) REFERENCES generation_job(id,project_id,workspace_id),
  FOREIGN KEY(provider_configuration_id,workspace_id) REFERENCES provider_configuration(id,workspace_id)
  ,FOREIGN KEY(job_attempt_id,provider_configuration_id,provider_request_id,workspace_id)
    REFERENCES job_attempt(id,provider_configuration_id,provider_request_id,workspace_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX real_media_submission_scope_idx ON real_media_submission(workspace_id,project_id,state);
CREATE FUNCTION real_media_authorization_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'media authorization is permanent'; END IF;
  IF (to_jsonb(NEW)-'authorization_id'-'authorized_at'-'job_id'-'maximum_amount'-'confirmed_uncertain_job_ids') IS DISTINCT FROM
     (to_jsonb(OLD)-'authorization_id'-'authorized_at'-'job_id'-'maximum_amount'-'confirmed_uncertain_job_ids') THEN RAISE EXCEPTION 'media quote is immutable'; END IF;
  IF OLD.authorization_id IS NULL AND NEW.maximum_amount IS DISTINCT FROM OLD.maximum_amount AND NEW.authorization_id IS NULL THEN RAISE EXCEPTION 'maximum changes only with explicit confirmation'; END IF;
  IF OLD.authorization_id IS NOT NULL AND (NEW.authorization_id IS DISTINCT FROM OLD.authorization_id OR NEW.authorized_at IS DISTINCT FROM OLD.authorized_at OR NEW.maximum_amount IS DISTINCT FROM OLD.maximum_amount OR NEW.confirmed_uncertain_job_ids IS DISTINCT FROM OLD.confirmed_uncertain_job_ids)
     THEN RAISE EXCEPTION 'media authorization is immutable'; END IF;
  IF OLD.job_id IS NOT NULL AND NEW.job_id IS DISTINCT FROM OLD.job_id THEN RAISE EXCEPTION 'media authorization already consumed'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER real_media_authorization_immutable BEFORE UPDATE OR DELETE ON real_media_authorization
 FOR EACH ROW EXECUTE FUNCTION real_media_authorization_guard();
CREATE FUNCTION real_media_submission_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'INTENT' OR NEW.provider_request_id IS NOT NULL OR NEW.outputs_ciphertext IS NOT NULL OR NEW.acknowledged_at IS NOT NULL
      OR NOT EXISTS (SELECT 1 FROM generation_job j JOIN real_media_authorization a ON a.job_id=j.id
        WHERE j.id=NEW.generation_job_id AND j.workspace_id=NEW.workspace_id AND j.input_hash=NEW.input_hash
          AND (j.input_snapshot-'budget')=a.input_snapshot
          AND j.input_snapshot#>>'{budget,authorizationId}'=a.authorization_id::text
          AND COALESCE(j.input_snapshot#>'{budget,confirmedUncertainJobIds}','[]'::jsonb)=to_jsonb(a.confirmed_uncertain_job_ids)
          AND NEW.estimated_amount=a.estimated_amount AND NEW.currency=a.currency
          AND NEW.provider_configuration_id::text=a.configuration_snapshot->>'id')
    THEN RAISE EXCEPTION 'media submission must bind the exact authorized intent'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'media submission is permanent'; END IF;
  IF (to_jsonb(NEW)-'state'-'provider_request_id'-'outputs_ciphertext'-'usage_json'-'acknowledged_at'-'updated_at') IS DISTINCT FROM
     (to_jsonb(OLD)-'state'-'provider_request_id'-'outputs_ciphertext'-'usage_json'-'acknowledged_at'-'updated_at')
    THEN RAISE EXCEPTION 'media submission identity is immutable'; END IF;
  IF OLD.provider_request_id IS NOT NULL AND NEW.provider_request_id IS DISTINCT FROM OLD.provider_request_id THEN RAISE EXCEPTION 'provider request is immutable'; END IF;
  IF OLD.state IN ('SUCCEEDED','FAILED','REJECTED') THEN RAISE EXCEPTION 'terminal media receipt is immutable'; END IF;
  IF NEW.state='REJECTED' AND OLD.state NOT IN ('INTENT','UNKNOWN') THEN RAISE EXCEPTION 'only a definitive initial refusal releases exposure'; END IF;
  IF OLD.state='INTENT' AND NEW.state NOT IN ('ACKNOWLEDGED','UNKNOWN','REJECTED') THEN RAISE EXCEPTION 'invalid media receipt transition'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER real_media_submission_immutable BEFORE INSERT OR UPDATE OR DELETE ON real_media_submission
 FOR EACH ROW EXECUTE FUNCTION real_media_submission_guard();
COMMENT ON TABLE real_media_authorization IS 'ads.real-media.authorization.v1';
COMMENT ON TABLE real_media_submission IS 'ads.real-media.submission.v1';
