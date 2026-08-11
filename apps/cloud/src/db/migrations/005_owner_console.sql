-- Owner feedback, limited product analytics, and grouped application problems.

ALTER TABLE share_links
  ADD COLUMN purpose text NOT NULL DEFAULT 'public'
    CHECK (purpose IN ('public', 'support'));

CREATE TABLE product_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL CHECK (name IN (
    'dashboard_opened',
    'workspace_opened',
    'editor_opened',
    'prompt_copied',
    'manual_setup_opened',
    'document_imported'
  )),
  source text NOT NULL CHECK (source IN ('dashboard', 'editor', 'server')),
  user_id text NOT NULL,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  document_id text,
  properties jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX product_events_occurred_at_idx ON product_events (occurred_at DESC);
CREATE INDEX product_events_user_activity_idx
  ON product_events (user_id, occurred_at DESC);
CREATE INDEX product_events_workspace_activity_idx
  ON product_events (workspace_id, occurred_at DESC)
  WHERE workspace_id IS NOT NULL;

CREATE TABLE feedback_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  document_id text,
  category text NOT NULL CHECK (category IN ('broken', 'confusing', 'feature', 'general')),
  message text NOT NULL CHECK (char_length(message) BETWEEN 1 AND 5000),
  wants_reply boolean NOT NULL DEFAULT true,
  route text,
  browser text,
  release text,
  diagnostics jsonb NOT NULL DEFAULT '{}'::jsonb,
  screenshot_mime text CHECK (
    screenshot_mime IS NULL OR screenshot_mime IN ('image/png', 'image/jpeg', 'image/webp')
  ),
  screenshot_data bytea,
  support_share_token text REFERENCES share_links(token) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'reviewing', 'resolved')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((screenshot_mime IS NULL) = (screenshot_data IS NULL))
);
CREATE INDEX feedback_items_status_created_idx
  ON feedback_items (status, created_at DESC);
CREATE INDEX feedback_items_user_created_idx
  ON feedback_items (user_id, created_at DESC);

CREATE TABLE feedback_replies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feedback_id uuid NOT NULL REFERENCES feedback_items(id) ON DELETE CASCADE,
  sent_by text NOT NULL,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 5000),
  sent_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX feedback_replies_feedback_sent_idx
  ON feedback_replies (feedback_id, sent_at ASC);

CREATE TABLE problem_groups (
  fingerprint text PRIMARY KEY CHECK (char_length(fingerprint) = 64),
  source text NOT NULL CHECK (source IN ('dashboard', 'editor', 'server', 'runtime', 'storage')),
  severity text NOT NULL DEFAULT 'error' CHECK (severity IN ('warning', 'error', 'fatal')),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 1000),
  stack text,
  occurrence_count bigint NOT NULL DEFAULT 1 CHECK (occurrence_count > 0),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'ignored')),
  resolved_at timestamptz,
  release text,
  route text,
  last_user_id text,
  last_workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  last_document_id text,
  context jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX problem_groups_status_seen_idx
  ON problem_groups (status, last_seen_at DESC);
