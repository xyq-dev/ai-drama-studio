-- DRAFT. Do not apply. Execution of this migration is not authorized.
-- Image approval is limited to character reference images. Composite approval stays unchanged.

ALTER TABLE asset ADD COLUMN reference_role text;
ALTER TABLE asset ADD COLUMN source_character_revision_id uuid;

ALTER TABLE asset DROP CONSTRAINT asset_approval_kind_check;
ALTER TABLE asset ADD CONSTRAINT asset_approval_kind_check CHECK (
  review_status <> 'APPROVED'
  OR kind = 'COMPOSITE'
  OR (kind = 'IMAGE' AND reference_role IS NOT NULL
      AND reference_role = 'character_reference' AND source_character_revision_id IS NOT NULL)
);

ALTER TABLE asset ADD CONSTRAINT asset_character_reference_source_check CHECK (
  (reference_role IS NULL AND source_character_revision_id IS NULL)
  OR (reference_role IS NOT NULL AND reference_role = 'character_reference'
      AND source_character_revision_id IS NOT NULL AND kind = 'IMAGE')
);

ALTER TABLE asset ADD CONSTRAINT asset_character_reference_revision_fk
  FOREIGN KEY (source_character_revision_id, project_id, workspace_id)
  REFERENCES character_revision (id, project_id, workspace_id);
ALTER TABLE asset ADD CONSTRAINT asset_character_reference_identity_key
  UNIQUE (id, source_character_revision_id, project_id, workspace_id);

CREATE TABLE character_reference_selection (
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  character_id uuid NOT NULL,
  source_character_revision_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  selected_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, character_id),
  FOREIGN KEY (character_id, project_id, workspace_id)
    REFERENCES character (id, project_id, workspace_id),
  FOREIGN KEY (source_character_revision_id, character_id, workspace_id)
    REFERENCES character_revision (id, character_id, workspace_id),
  FOREIGN KEY (asset_id, source_character_revision_id, project_id, workspace_id)
    REFERENCES asset (id, source_character_revision_id, project_id, workspace_id)
);

-- Before activation the application must also lock and verify the current revision,
-- ACTIVE/APPROVED asset, matching reviewed hash, and source freshness. These FKs
-- protect identity, not dynamic eligibility. This draft does not enable that path.
