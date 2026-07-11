-- I5-2: better-auth owns identity. Its `user` table (created by
-- ensureAuthSchema, outside this migration stream) is the canonical user
-- record; the app-level `users` table from 001 was never written to and is
-- dropped. memberships.user_id switches from uuid to text to match
-- better-auth's string ids.
--
-- No FK from memberships.user_id → "user"(id): that table is managed by
-- better-auth's schema migrator and may not exist yet when this migration
-- runs on a fresh database. Membership cleanup on user deletion is an
-- app-level concern (I6).
ALTER TABLE memberships DROP CONSTRAINT memberships_user_id_fkey;
ALTER TABLE memberships ALTER COLUMN user_id TYPE text USING user_id::text;
DROP TABLE users;
