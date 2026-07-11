-- I5-3 billing + plan enforcement.
--
-- workspaces.asset_bytes: running total of uploaded asset bytes, incremented
-- by PgStorageAdapter on every assets.put and read by the plan quota check.
-- Approximate by design (content-addressed duplicates still count; deletes
-- don't exist yet) — it is an abuse ceiling, not an invoice.
ALTER TABLE workspaces ADD COLUMN asset_bytes bigint NOT NULL DEFAULT 0;
