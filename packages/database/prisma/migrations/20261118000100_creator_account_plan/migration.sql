-- Creator account isolation and configurable usage-plan / ledger skeleton (phase 4 / T-ENG-WEB-ACCOUNT-PLAN).
-- Additive: new tables for independently log-in-able creator accounts, a plan catalog with nullable unit prices,
-- per-account plan entitlements, and an auditable creator usage ledger. project gains owner_account_id so works are
-- scoped to a creator; every existing project is assigned to the designated legacy owner so staging works (including
-- 「最后一枚钥匙」) are neither ownerless nor visible to every new account after deploy.
-- No prices are locked: unit_price_amount may be NULL (尚未计价). No payment channel, cards, top-ups, or settlement.
-- Public self-service registration stays off unless CREATOR_PUBLIC_REGISTRATION_ENABLED=true (process env; default off).
-- Requires the seven base migrations (workspace, project). Independent of script breakdown / writing / auto-creation /
-- series migrations (applied or not). Operator / SITE_AUTH login is unchanged; this only adds creator rows and ownership.
-- Locks: ALTER TABLE takes ACCESS EXCLUSIVE on project while adding the column and validating NOT NULL; new tables'
-- FKs take SHARE ROW EXCLUSIVE on workspace/project. Apply in a quiet window with the guarded single-migration command.
-- Do NOT execute this migration from the phase-4 PR agent; the director's deploy prompt runs it after user approval.
-- No down migration. Forward-fix only: older code ignores the new column and tables.

-- Well-known legacy owner id for the single product workspace (packages/domain creator-account-plan
-- LEGACY_OWNER_ACCOUNT_ID). Status LEGACY: cannot log in via the creator password path; operator SITE_AUTH sessions
-- bind to this ownership for 「我的作品」 of legacy works. Ops listing of every work is a separate operator-only view.

CREATE TABLE creator_account (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  username text NOT NULL CHECK (username ~ '^[A-Za-z0-9._-]{1,64}$'),
  password_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('ACTIVE', 'DISABLED', 'LEGACY')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, username),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (workspace_id) REFERENCES workspace(id)
);
-- Login matches lower(username); uniqueness must follow the same rule so alice/Alice cannot both exist.
CREATE UNIQUE INDEX creator_account_workspace_username_lower_idx
  ON creator_account (workspace_id, lower(username));
CREATE INDEX creator_account_workspace_idx ON creator_account (workspace_id, created_at DESC);

-- Plan catalog: unit prices are configurable and may be empty (NULL = 尚未计价). No committed RMB / membership tiers.
CREATE TABLE usage_plan_catalog (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  code text NOT NULL CHECK (length(code) BETWEEN 1 AND 64),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  description text NOT NULL DEFAULT '',
  -- Soft quota units for display; NULL means quota not configured yet.
  included_units numeric(20,8) CHECK (included_units IS NULL OR included_units >= 0),
  unit_label text NOT NULL DEFAULT 'unit',
  unit_price_amount numeric(20,8) CHECK (unit_price_amount IS NULL OR unit_price_amount >= 0),
  unit_price_currency char(3),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, code),
  UNIQUE (id, workspace_id),
  CHECK ((unit_price_amount IS NULL) = (unit_price_currency IS NULL)),
  FOREIGN KEY (workspace_id) REFERENCES workspace(id)
);

CREATE TABLE creator_plan_entitlement (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  account_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  -- Remaining soft quota; NULL means not configured / not yet priced as a balance.
  remaining_units numeric(20,8) CHECK (remaining_units IS NULL OR remaining_units >= 0),
  status text NOT NULL CHECK (status IN ('active', 'exhausted', 'unpriced')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, account_id),
  FOREIGN KEY (account_id, workspace_id) REFERENCES creator_account(id, workspace_id),
  FOREIGN KEY (plan_id, workspace_id) REFERENCES usage_plan_catalog(id, workspace_id)
);
CREATE INDEX creator_plan_entitlement_plan_idx ON creator_plan_entitlement (workspace_id, plan_id);

-- Auditable creator-facing ledger (distinct from provider cost_ledger). Confirmed posts only; unconfirmed clicks must
-- not insert. Status pending_price = usage recorded, amount not yet priced; posted = amount known and recorded.
CREATE TABLE creator_usage_ledger (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  account_id uuid NOT NULL,
  project_id uuid,
  task_key text CHECK (task_key IS NULL OR length(task_key) BETWEEN 1 AND 200),
  entry_kind text NOT NULL CHECK (entry_kind IN ('debit', 'credit', 'adjustment')),
  status text NOT NULL CHECK (status IN ('pending_price', 'posted')),
  usage_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  amount_decimal numeric(20,8) CHECK (amount_decimal IS NULL OR amount_decimal >= 0),
  currency char(3),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, account_id, idempotency_key),
  CHECK (
    (status = 'pending_price' AND amount_decimal IS NULL AND currency IS NULL)
    OR (status = 'posted' AND amount_decimal IS NOT NULL AND currency IS NOT NULL)
  ),
  FOREIGN KEY (account_id, workspace_id) REFERENCES creator_account(id, workspace_id),
  FOREIGN KEY (project_id, workspace_id) REFERENCES project(id, workspace_id)
);
CREATE INDEX creator_usage_ledger_account_idx
  ON creator_usage_ledger (workspace_id, account_id, occurred_at DESC);
CREATE INDEX creator_usage_ledger_project_idx
  ON creator_usage_ledger (workspace_id, project_id, occurred_at DESC)
  WHERE project_id IS NOT NULL;

-- Seed one LEGACY owner per workspace (well-known id on the earliest workspace for the single-product deploy).
INSERT INTO creator_account (id, workspace_id, username, password_hash, status)
SELECT CASE
    WHEN w.id = (SELECT id FROM workspace ORDER BY created_at ASC, id ASC LIMIT 1)
      THEN 'a0000000-0000-4000-8000-000000000001'::uuid
    ELSE gen_random_uuid()
  END,
  w.id,
  'legacy-owner',
  'legacy-not-a-password-hash',
  'LEGACY'
FROM workspace w
WHERE NOT EXISTS (
  SELECT 1 FROM creator_account c WHERE c.workspace_id = w.id AND c.username = 'legacy-owner'
);

ALTER TABLE project ADD COLUMN owner_account_id uuid;
UPDATE project p
   SET owner_account_id = c.id
  FROM creator_account c
 WHERE c.workspace_id = p.workspace_id
   AND c.username = 'legacy-owner'
   AND p.owner_account_id IS NULL;
ALTER TABLE project ALTER COLUMN owner_account_id SET NOT NULL;
ALTER TABLE project
  ADD CONSTRAINT project_owner_account_fk
  FOREIGN KEY (owner_account_id, workspace_id) REFERENCES creator_account(id, workspace_id);
CREATE INDEX project_owner_account_idx ON project (workspace_id, owner_account_id, created_at DESC);

-- Raw inserts that omit owner_account_id (legacy tests / older writers) inherit the workspace legacy owner.
-- Workspaces created after this migration also get a LEGACY owner on first project insert so tests and older
-- writers keep working without stamping owner_account_id explicitly.
CREATE FUNCTION project_default_owner_account() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  legacy_id uuid;
BEGIN
  IF NEW.owner_account_id IS NULL THEN
    SELECT id INTO legacy_id
      FROM creator_account
     WHERE workspace_id = NEW.workspace_id AND username = 'legacy-owner'
     LIMIT 1;
    IF legacy_id IS NULL THEN
      -- Prefer the well-known product legacy owner id when still unused, so operator SITE_AUTH
      -- 「我的作品」 (bound to a0000000-0000-4000-8000-000000000001) matches acceptance and single-workspace deploys.
      -- Later workspaces in the same database fall back to a fresh uuid.
      IF NOT EXISTS (
        SELECT 1 FROM creator_account WHERE id = 'a0000000-0000-4000-8000-000000000001'::uuid
      ) THEN
        legacy_id := 'a0000000-0000-4000-8000-000000000001'::uuid;
      ELSE
        legacy_id := gen_random_uuid();
      END IF;
      INSERT INTO creator_account (id, workspace_id, username, password_hash, status)
      VALUES (legacy_id, NEW.workspace_id, 'legacy-owner', 'legacy-not-a-password-hash', 'LEGACY')
      ON CONFLICT (workspace_id, username) DO NOTHING;
      SELECT id INTO legacy_id
        FROM creator_account
       WHERE workspace_id = NEW.workspace_id AND username = 'legacy-owner'
       LIMIT 1;
    END IF;
    NEW.owner_account_id := legacy_id;
  END IF;
  IF NEW.owner_account_id IS NULL THEN
    RAISE EXCEPTION 'project_owner_account_required'
      USING ERRCODE = 'not_null_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER project_default_owner_account
  BEFORE INSERT ON project
  FOR EACH ROW EXECUTE FUNCTION project_default_owner_account();

-- Default unpriced plan per workspace (unit_price_* NULL → 尚未计价). No price list is committed.
INSERT INTO usage_plan_catalog (
  id, workspace_id, code, name, description, included_units, unit_label,
  unit_price_amount, unit_price_currency, active
)
SELECT gen_random_uuid(), w.id, 'default',
  '默认用量计划', '可配置用量计划骨架；单价未配置前显示尚未计价。',
  NULL, 'unit', NULL, NULL, true
FROM workspace w
WHERE NOT EXISTS (
  SELECT 1 FROM usage_plan_catalog p WHERE p.workspace_id = w.id AND p.code = 'default'
);

INSERT INTO creator_plan_entitlement (id, workspace_id, account_id, plan_id, remaining_units, status)
SELECT gen_random_uuid(), a.workspace_id, a.id, p.id, NULL, 'unpriced'
FROM creator_account a
JOIN usage_plan_catalog p ON p.workspace_id = a.workspace_id AND p.code = 'default'
WHERE a.username = 'legacy-owner'
  AND NOT EXISTS (
    SELECT 1 FROM creator_plan_entitlement e
    WHERE e.workspace_id = a.workspace_id AND e.account_id = a.id
  );
