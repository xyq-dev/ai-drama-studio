-- DRAFT ONLY. Requires the existing shot, asset, and real-media structures.
-- Asset content/provenance and its existing review contract are unchanged.
CREATE TABLE comfyui_shot_image_selection (
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  shot_revision_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  asset_checksum_sha256 text NOT NULL CHECK (asset_checksum_sha256 ~ '^[a-f0-9]{64}$'),
  selected_by text NOT NULL CHECK (length(selected_by) BETWEEN 1 AND 200),
  selected_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, project_id, shot_revision_id),
  FOREIGN KEY (shot_revision_id, project_id, workspace_id) REFERENCES shot_revision(id, project_id, workspace_id),
  FOREIGN KEY (asset_id, project_id, workspace_id) REFERENCES asset(id, project_id, workspace_id)
);
COMMENT ON TABLE comfyui_shot_image_selection IS 'ads.comfyui.shot-image-selection.v1';
