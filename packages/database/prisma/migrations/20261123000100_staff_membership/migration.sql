-- Staff accounts, invites, and creator membership quotas.
-- Additive. Requires 20261118000100_creator_account_plan (creator_account, usage_plan_catalog, workspace).
-- Does not set a price or a quota. Administrators enter those later. No payment, renewal charge, or refund table.
-- Existing creator accounts, works, tasks, and ledger rows are left in place.
-- Invite tokens, password hashes, TOTP secrets, and recovery codes are stored only as secrets for verification.
-- No down migration.

CREATE TABLE staff_role (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  code text NOT NULL CHECK (code ~ '^[a-z0-9_]{1,64}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  built_in boolean NOT NULL DEFAULT false,
  permissions text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, code),
  FOREIGN KEY (workspace_id) REFERENCES workspace(id)
);

CREATE TABLE staff_account (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  username text NOT NULL CHECK (username ~ '^[A-Za-z0-9._-]{1,64}$'),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 40),
  password_hash text,
  status text NOT NULL CHECK (status IN ('pending', 'active', 'disabled')),
  role_id uuid NOT NULL,
  permission_version integer NOT NULL DEFAULT 1 CHECK (permission_version >= 1),
  totp_secret text,
  totp_enabled boolean NOT NULL DEFAULT false,
  last_login_at timestamptz,
  auth_source text NOT NULL CHECK (auth_source IN ('env', 'invite')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, username),
  FOREIGN KEY (workspace_id) REFERENCES workspace(id),
  FOREIGN KEY (role_id) REFERENCES staff_role(id)
);
CREATE UNIQUE INDEX staff_account_workspace_username_lower_idx
  ON staff_account (workspace_id, lower(username));

CREATE TABLE staff_invite (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  staff_id uuid NOT NULL,
  token_hash text NOT NULL CHECK (length(token_hash) = 64),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (token_hash),
  FOREIGN KEY (workspace_id) REFERENCES workspace(id),
  FOREIGN KEY (staff_id) REFERENCES staff_account(id)
);

CREATE TABLE staff_recovery_code (
  id uuid PRIMARY KEY,
  staff_id uuid NOT NULL,
  code_hash text NOT NULL CHECK (length(code_hash) = 64),
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (staff_id) REFERENCES staff_account(id)
);

CREATE TABLE usage_plan_feature (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  feature text NOT NULL CHECK (feature IN ('writing', 'image', 'voice', 'video')),
  enabled boolean NOT NULL DEFAULT false,
  included_units numeric(20, 4) CHECK (included_units IS NULL OR included_units >= 0),
  UNIQUE (plan_id, feature),
  FOREIGN KEY (plan_id, workspace_id) REFERENCES usage_plan_catalog(id, workspace_id)
);

CREATE TABLE creator_membership (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  account_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'disabled')),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  source text NOT NULL CHECK (source IN ('manual')),
  granted_by uuid,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  FOREIGN KEY (account_id, workspace_id) REFERENCES creator_account(id, workspace_id),
  FOREIGN KEY (plan_id, workspace_id) REFERENCES usage_plan_catalog(id, workspace_id)
);
CREATE INDEX creator_membership_account_idx
  ON creator_membership (workspace_id, account_id, ends_at DESC);

CREATE TABLE creator_feature_balance (
  workspace_id uuid NOT NULL,
  account_id uuid NOT NULL,
  feature text NOT NULL CHECK (feature IN ('writing', 'image', 'voice', 'video')),
  remaining_units numeric(20, 4) NOT NULL CHECK (remaining_units >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, account_id, feature),
  FOREIGN KEY (account_id, workspace_id) REFERENCES creator_account(id, workspace_id)
);

CREATE TABLE creator_quota_hold (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  account_id uuid NOT NULL,
  feature text NOT NULL CHECK (feature IN ('writing', 'image', 'voice', 'video')),
  project_id uuid,
  task_key text,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  units numeric(20, 4) NOT NULL CHECK (units > 0),
  status text NOT NULL CHECK (status IN ('held', 'committed', 'released', 'unknown')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, account_id, idempotency_key),
  FOREIGN KEY (account_id, workspace_id) REFERENCES creator_account(id, workspace_id)
);
CREATE INDEX creator_quota_hold_task_idx
  ON creator_quota_hold (workspace_id, account_id, task_key)
  WHERE task_key IS NOT NULL;

-- Built-in roles only. No prices, no quotas, no staff password.
INSERT INTO staff_role (id, workspace_id, code, name, built_in, permissions)
SELECT gen_random_uuid(), w.id, 'super_admin', '超级管理员', true,
  ARRAY['review_works', 'manage_creators', 'view_usage', 'retry_paid', 'maintain_model_keys', 'probe_models', 'enable_models', 'grant_membership', 'adjust_quota', 'manage_staff']::text[]
FROM workspace w
WHERE NOT EXISTS (
  SELECT 1 FROM staff_role r WHERE r.workspace_id = w.id AND r.code = 'super_admin'
);

INSERT INTO staff_role (id, workspace_id, code, name, built_in, permissions)
SELECT gen_random_uuid(), w.id, 'ops_admin', '运营管理员', true,
  ARRAY['review_works', 'manage_creators', 'view_usage']::text[]
FROM workspace w
WHERE NOT EXISTS (
  SELECT 1 FROM staff_role r WHERE r.workspace_id = w.id AND r.code = 'ops_admin'
);
