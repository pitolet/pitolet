-- Private, non-billing entitlements for platform-owned and testing accounts.
-- Paid subscriptions remain limited to free/pro in the subscriptions table.
ALTER TABLE workspaces
  DROP CONSTRAINT workspaces_plan_value;
ALTER TABLE workspaces
  ADD CONSTRAINT workspaces_plan_value
  CHECK (plan IN ('free', 'pro', 'unlimited'));

CREATE TABLE account_entitlements (
  -- Better Auth's user table is migrated after the app migrations, so this
  -- deliberately follows memberships and stores the stable user id without
  -- a database foreign key.
  user_id text PRIMARY KEY,
  plan text NOT NULL CHECK (plan = 'unlimited'),
  granted_at timestamptz NOT NULL DEFAULT now(),
  note text
);
