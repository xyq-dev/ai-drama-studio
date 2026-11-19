-- UploadSession for storyboard (and general) image uploads (T-ENG-WEB-STORYBOARD-SOURCE).
-- Additive: creates upload_session only. Temporary object staging is never an Asset until complete verifies
-- MIME, size and SHA-256 and inserts source_kind='UPLOAD'. Independent of script breakdown / writing /
-- auto-creation / series / creator-plan migrations beyond the seven base ones (workspace, project, asset,
-- shot_revision). Apply with the guarded single-migration command. Do NOT execute from the storyboard PR
-- agent; the director's deploy prompt runs it after approval. No down migration.

CREATE TABLE upload_session (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  storage_provider text NOT NULL,
  temporary_storage_key text NOT NULL,
  expected_mime_type text NOT NULL CHECK (expected_mime_type IN ('image/png', 'image/jpeg', 'image/webp')),
  expected_byte_size bigint NOT NULL CHECK (expected_byte_size > 0 AND expected_byte_size <= 8388608),
  expected_content_hash text CHECK (expected_content_hash IS NULL OR expected_content_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'UPLOADED', 'COMPLETED', 'EXPIRED', 'FAILED')),
  expires_at timestamptz NOT NULL,
  created_by text NOT NULL CHECK (length(created_by) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  completed_asset_id uuid,
  source_shot_revision_id uuid,
  UNIQUE (id, workspace_id),
  UNIQUE (id, project_id, workspace_id),
  UNIQUE (storage_provider, temporary_storage_key),
  CHECK (expires_at > created_at),
  CHECK (
    (status = 'COMPLETED' AND completed_at IS NOT NULL AND completed_asset_id IS NOT NULL)
    OR (status <> 'COMPLETED' AND completed_at IS NULL AND completed_asset_id IS NULL)
  ),
  FOREIGN KEY (project_id, workspace_id)
    REFERENCES project(id, workspace_id),
  FOREIGN KEY (completed_asset_id, project_id, workspace_id)
    REFERENCES asset(id, project_id, workspace_id),
  FOREIGN KEY (source_shot_revision_id, project_id, workspace_id)
    REFERENCES shot_revision(id, project_id, workspace_id)
);

CREATE INDEX upload_session_project_created_idx
  ON upload_session (workspace_id, project_id, created_at DESC);

CREATE INDEX upload_session_status_expires_idx
  ON upload_session (workspace_id, status, expires_at);

COMMENT ON TABLE upload_session IS 'ads.upload-session.v1';
