-- DRAFT ONLY: requires the normal M1 schema. Never run at startup or during a GET.
-- Existing assets remain on a frozen legacy configuration. No existing row is rewritten.
CREATE TABLE storage_configuration_revision (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspace(id),
  source text NOT NULL CHECK(source IN ('environment','managed')),
  encrypted_configuration text NOT NULL CHECK(octet_length(encrypted_configuration) BETWEEN 32 AND 8192),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,workspace_id)
);
CREATE TABLE storage_settings_state (
  workspace_id uuid PRIMARY KEY REFERENCES workspace(id),
  revision bigint NOT NULL DEFAULT 0 CHECK(revision BETWEEN 0 AND 9007199254740991),
  legacy_id uuid NOT NULL,
  active_id uuid NOT NULL,
  draft_id uuid,
  tested_id uuid,
  test_status text NOT NULL DEFAULT 'not_tested' CHECK(test_status IN ('not_tested','passed','failed')),
  tested_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(legacy_id,workspace_id) REFERENCES storage_configuration_revision(id,workspace_id),
  FOREIGN KEY(active_id,workspace_id) REFERENCES storage_configuration_revision(id,workspace_id),
  FOREIGN KEY(draft_id,workspace_id) REFERENCES storage_configuration_revision(id,workspace_id),
  FOREIGN KEY(tested_id,workspace_id) REFERENCES storage_configuration_revision(id,workspace_id),
  CHECK((test_status='not_tested')=(tested_at IS NULL)),
  CHECK((test_status='not_tested')=(tested_id IS NULL)),
  CHECK(tested_id IS NULL OR tested_id=draft_id)
);
CREATE TABLE storage_object_binding (
  workspace_id uuid NOT NULL REFERENCES workspace(id),
  object_key text NOT NULL CHECK(length(object_key) BETWEEN 1 AND 1024),
  configuration_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,object_key),
  FOREIGN KEY(configuration_id,workspace_id) REFERENCES storage_configuration_revision(id,workspace_id)
);
CREATE INDEX storage_object_binding_revision_idx ON storage_object_binding(configuration_id,workspace_id);
CREATE TABLE storage_settings_audit (
  id bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspace(id),
  revision bigint NOT NULL,
  action text NOT NULL CHECK(action IN ('saved','tested_passed','tested_failed','activated')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION storage_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'storage history is immutable'; END $$;
CREATE TRIGGER storage_configuration_immutable BEFORE UPDATE OR DELETE ON storage_configuration_revision
 FOR EACH ROW EXECUTE FUNCTION storage_immutable_guard();
CREATE TRIGGER storage_binding_immutable BEFORE UPDATE OR DELETE ON storage_object_binding
 FOR EACH ROW EXECUTE FUNCTION storage_immutable_guard();
CREATE TRIGGER storage_audit_immutable BEFORE UPDATE OR DELETE ON storage_settings_audit
 FOR EACH ROW EXECUTE FUNCTION storage_immutable_guard();
CREATE FUNCTION storage_state_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'storage state cannot be removed'; END IF;
  IF NEW.workspace_id<>OLD.workspace_id OR NEW.legacy_id<>OLD.legacy_id OR NEW.revision<>OLD.revision+1 THEN
    RAISE EXCEPTION 'invalid storage revision';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER storage_state_version_guard BEFORE UPDATE OR DELETE ON storage_settings_state
 FOR EACH ROW EXECUTE FUNCTION storage_state_guard();
