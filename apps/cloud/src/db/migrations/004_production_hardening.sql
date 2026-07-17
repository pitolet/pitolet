-- Security and accounting invariants used by the production hardening pass.

-- A document id is globally unique already. The composite key lets dependent
-- tables also prove that the workspace id belongs to that document.
ALTER TABLE documents
  ADD CONSTRAINT documents_id_workspace_unique UNIQUE (id, workspace_id);

ALTER TABLE share_links
  ADD CONSTRAINT share_links_document_workspace_fkey
  FOREIGN KEY (doc_id, workspace_id)
  REFERENCES documents (id, workspace_id)
  ON DELETE CASCADE;

-- Browser share credentials are exchanged for short-lived, hashed sessions.
-- The raw session value only exists in an HttpOnly cookie.
CREATE TABLE share_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text UNIQUE NOT NULL,
  share_token text NOT NULL REFERENCES share_links(token) ON DELETE CASCADE,
  doc_id text NOT NULL,
  workspace_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz,
  CONSTRAINT share_sessions_document_workspace_fkey
    FOREIGN KEY (doc_id, workspace_id)
    REFERENCES documents (id, workspace_id)
    ON DELETE CASCADE
);
CREATE INDEX share_sessions_expiry_idx ON share_sessions (expires_at);

-- Content-addressed files count once per workspace, even when uploaded more
-- than once or by concurrent import requests.
CREATE TABLE workspace_assets (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  asset_id text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, asset_id)
);

-- asset_bytes was already maintained before this table existed. Mark assets
-- referenced by existing documents as accounted without changing that
-- historical counter, so their next content-addressed upload is not charged
-- a second time.
INSERT INTO workspace_assets (workspace_id, asset_id, size_bytes)
SELECT DISTINCT d.workspace_id, asset.asset_id, 0
FROM documents d
CROSS JOIN LATERAL jsonb_object_keys(
  CASE
    WHEN jsonb_typeof(d.doc->'assets') = 'object' THEN d.doc->'assets'
    ELSE '{}'::jsonb
  END
) AS asset(asset_id)
ON CONFLICT DO NOTHING;

-- Bound fields at the database boundary as well as the HTTP boundary.
ALTER TABLE workspaces
  ADD CONSTRAINT workspaces_name_length CHECK (char_length(name) BETWEEN 1 AND 100),
  ADD CONSTRAINT workspaces_slug_length CHECK (char_length(slug::text) BETWEEN 2 AND 40),
  ADD CONSTRAINT workspaces_plan_value CHECK (plan IN ('free', 'pro')),
  ADD CONSTRAINT workspaces_asset_bytes_nonnegative CHECK (asset_bytes >= 0);

ALTER TABLE agent_tokens
  ADD CONSTRAINT agent_tokens_name_length CHECK (char_length(name) BETWEEN 1 AND 100),
  ADD CONSTRAINT agent_tokens_scopes_value
    CHECK (scopes <@ ARRAY['read', 'write']::text[] AND scopes @> ARRAY['read']::text[]);

ALTER TABLE doc_snapshots
  ADD CONSTRAINT doc_snapshots_label_length CHECK (label IS NULL OR char_length(label) <= 200);

ALTER TABLE subscriptions
  ADD CONSTRAINT subscriptions_plan_value CHECK (plan IN ('free', 'pro'));
