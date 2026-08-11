import type { Pool } from 'pg';
import { createShareLink } from '../cloud/shareLinks.js';
import { roleFor, type Role } from '../cloud/workspaces.js';
import { feedbackNotificationEmails } from './access.js';
import { sendMail } from './mail.js';
import { recordProblem, redactDiagnostic, safeClientProblemTitle } from './telemetry.js';

export type FeedbackCategory = 'broken' | 'confusing' | 'feature' | 'general';
export type FeedbackStatus = 'new' | 'reviewing' | 'resolved';

const CATEGORIES = new Set<FeedbackCategory>(['broken', 'confusing', 'feature', 'general']);
const STATUSES = new Set<FeedbackStatus>(['new', 'reviewing', 'resolved']);
const SCREENSHOT_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class FeedbackInputError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 = 400,
  ) {
    super(message);
  }
}

export interface FeedbackSubmission {
  category: FeedbackCategory;
  message: string;
  wantsReply: boolean;
  workspaceId: string | null;
  documentId: string | null;
  route: string | null;
  browser: string | null;
  release: string | null;
  diagnostics: Record<string, unknown>;
  screenshot: { mime: string; data: Buffer } | null;
  grantSupportAccess: boolean;
}

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text ? text.slice(0, max) : null;
}

function parseDiagnostics(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  if (Array.isArray(raw.clientErrors)) {
    result.clientErrors = raw.clientErrors
      .filter((entry): entry is string => typeof entry === 'string')
      .slice(-5)
      .map((entry) => safeClientProblemTitle(entry));
  }
  if (typeof raw.viewportWidth === 'number' && Number.isFinite(raw.viewportWidth)) {
    result.viewportWidth = Math.round(raw.viewportWidth);
  }
  if (typeof raw.viewportHeight === 'number' && Number.isFinite(raw.viewportHeight)) {
    result.viewportHeight = Math.round(raw.viewportHeight);
  }
  return result;
}

function hasImageSignature(mime: string, data: Buffer): boolean {
  if (mime === 'image/png') {
    return (
      data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    );
  }
  if (mime === 'image/jpeg')
    return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  if (mime === 'image/webp')
    return (
      data.length >= 12 &&
      data.subarray(0, 4).toString('ascii') === 'RIFF' &&
      data.subarray(8, 12).toString('ascii') === 'WEBP'
    );
  return false;
}

export function parseFeedbackSubmission(raw: unknown): FeedbackSubmission {
  if (!raw || typeof raw !== 'object') throw new FeedbackInputError('invalid feedback');
  const body = raw as Record<string, unknown>;
  if (typeof body.category !== 'string' || !CATEGORIES.has(body.category as FeedbackCategory)) {
    throw new FeedbackInputError('choose a feedback type');
  }
  const rawMessage = cleanText(body.message, 5000);
  if (!rawMessage) throw new FeedbackInputError('message is required');
  // Feedback is intentionally free-form, so people occasionally paste a
  // credential while explaining a problem. Keep the useful message while
  // applying the same credential redaction used by diagnostics.
  const message = redactDiagnostic(rawMessage, 5000);

  let screenshot: FeedbackSubmission['screenshot'] = null;
  if (body.screenshot !== undefined && body.screenshot !== null) {
    if (!body.screenshot || typeof body.screenshot !== 'object') {
      throw new FeedbackInputError('invalid screenshot');
    }
    const input = body.screenshot as Record<string, unknown>;
    if (typeof input.mime !== 'string' || !SCREENSHOT_MIMES.has(input.mime)) {
      throw new FeedbackInputError('screenshot must be PNG, JPEG, or WebP');
    }
    if (typeof input.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.data)) {
      throw new FeedbackInputError('invalid screenshot data');
    }
    const data = Buffer.from(input.data, 'base64');
    if (data.length === 0 || data.length > MAX_SCREENSHOT_BYTES) {
      throw new FeedbackInputError('screenshot must be 5 MB or smaller');
    }
    if (!hasImageSignature(input.mime, data)) {
      throw new FeedbackInputError('screenshot contents do not match its file type');
    }
    screenshot = { mime: input.mime, data };
  }

  return {
    category: body.category as FeedbackCategory,
    message,
    wantsReply: body.wantsReply !== false,
    workspaceId: cleanText(body.workspaceId, 64),
    documentId: cleanText(body.documentId, 128),
    route: cleanText(body.route, 500)?.split('?')[0] ?? null,
    browser: ['Chrome', 'Firefox', 'Safari', 'Edge', 'Other browser'].includes(
      cleanText(body.browser, 30) ?? '',
    )
      ? cleanText(body.browser, 30)
      : null,
    release: cleanText(body.release, 100)
      ? redactDiagnostic(cleanText(body.release, 100), 100)
      : null,
    diagnostics: body.includeDiagnostics === true ? parseDiagnostics(body.diagnostics) : {},
    screenshot,
    grantSupportAccess: body.grantSupportAccess === true,
  };
}

async function validateContext(
  pool: Pool,
  userId: string,
  input: Pick<FeedbackSubmission, 'workspaceId' | 'documentId' | 'grantSupportAccess'>,
): Promise<{ role: Role | null }> {
  if (!input.workspaceId) {
    if (input.documentId || input.grantSupportAccess) {
      throw new FeedbackInputError('workspace context is required');
    }
    return { role: null };
  }
  if (!UUID_PATTERN.test(input.workspaceId)) {
    throw new FeedbackInputError('workspace not found', 404);
  }
  const role = await roleFor(pool, userId, input.workspaceId);
  if (!role) throw new FeedbackInputError('workspace not found', 404);
  if (input.documentId) {
    const document = await pool.query(
      `SELECT 1 FROM documents
       WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL`,
      [input.documentId, input.workspaceId],
    );
    if (document.rowCount === 0) throw new FeedbackInputError('document not found', 404);
  }
  if (input.grantSupportAccess) {
    if (!input.documentId) throw new FeedbackInputError('document context is required');
    if (role !== 'owner' && role !== 'editor') {
      throw new FeedbackInputError('only an owner or editor can grant support access', 403);
    }
  }
  return { role };
}

export async function feedbackContext(
  pool: Pool,
  userId: string,
  workspaceId: string | null,
  documentId: string | null,
): Promise<{
  workspaceId: string | null;
  documentId: string | null;
  canGrantSupportAccess: boolean;
}> {
  const { role } = await validateContext(pool, userId, {
    workspaceId,
    documentId,
    grantSupportAccess: false,
  });
  return {
    workspaceId,
    documentId,
    canGrantSupportAccess: !!documentId && (role === 'owner' || role === 'editor'),
  };
}

export async function createFeedback(
  pool: Pool,
  user: { id: string; email: string; name: string },
  input: FeedbackSubmission,
  publicOrigin: string,
): Promise<{ id: string }> {
  await validateContext(pool, user.id, input);
  let supportShareToken: string | null = null;
  if (input.grantSupportAccess && input.workspaceId && input.documentId) {
    const link = await createShareLink(pool, {
      workspaceId: input.workspaceId,
      docId: input.documentId,
      createdBy: user.id,
      expiresInDays: 7,
      purpose: 'support',
    });
    supportShareToken = link.token;
  }

  let id: string;
  try {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO feedback_items
         (user_id, workspace_id, document_id, category, message, wants_reply,
          route, browser, release, diagnostics, screenshot_mime, screenshot_data,
          support_share_token)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13)
       RETURNING id`,
      [
        user.id,
        input.workspaceId,
        input.documentId,
        input.category,
        input.message,
        input.wantsReply,
        input.route,
        input.browser,
        input.release,
        JSON.stringify(input.diagnostics),
        input.screenshot?.mime ?? null,
        input.screenshot?.data ?? null,
        supportShareToken,
      ],
    );
    id = result.rows[0]!.id;
  } catch (error) {
    if (supportShareToken && input.workspaceId) {
      await pool
        .query(
          `UPDATE share_links SET revoked_at = now()
         WHERE token = $1 AND workspace_id = $2 AND revoked_at IS NULL`,
          [supportShareToken, input.workspaceId],
        )
        .catch(() => {});
    }
    throw error;
  }

  const recipients = feedbackNotificationEmails();
  if (recipients.length > 0) {
    void sendMail({
      to: recipients,
      subject: `Pitolet feedback: ${input.category}`,
      replyTo: user.email,
      text: `${user.name || user.email} sent feedback.\n\n${input.message}\n\nOpen: ${publicOrigin}/admin/feedback/${id}`,
    }).catch((error) =>
      recordProblem(pool, {
        source: 'server',
        title: 'Feedback notification email failed',
        stack: error instanceof Error ? error.stack : undefined,
        context: { operation: 'feedback_notification' },
      }).catch(() => {}),
    );
  }
  return { id };
}

function mapFeedbackRow(row: Record<string, unknown>, includePrivate = false) {
  const screenshot =
    includePrivate && row.screenshot_data
      ? {
          mime: row.screenshot_mime as string,
          data: Buffer.from(row.screenshot_data as Buffer).toString('base64'),
        }
      : null;
  const supportExpiresAt = row.support_expires_at
    ? new Date(row.support_expires_at as string).toISOString()
    : null;
  const supportActive =
    !!row.support_share_token &&
    !row.support_revoked_at &&
    (!supportExpiresAt || Date.parse(supportExpiresAt) > Date.now());
  return {
    id: row.id as string,
    category: row.category as FeedbackCategory,
    message: row.message as string,
    wantsReply: row.wants_reply as boolean,
    status: row.status as FeedbackStatus,
    user: {
      id: row.user_id as string,
      name: (row.user_name as string | null) ?? '',
      email: (row.user_email as string | null) ?? 'Deleted account',
    },
    workspace: row.workspace_id
      ? {
          id: row.workspace_id as string,
          name: row.workspace_name as string,
          slug: row.workspace_slug as string,
        }
      : null,
    documentId: (row.document_id as string | null) ?? null,
    route: (row.route as string | null) ?? null,
    browser: (row.browser as string | null) ?? null,
    release: (row.release as string | null) ?? null,
    diagnostics: includePrivate ? ((row.diagnostics as Record<string, unknown>) ?? {}) : undefined,
    screenshot,
    supportUrl: supportActive ? `/s/${row.support_share_token as string}` : null,
    supportExpiresAt,
    createdAt: new Date(row.created_at as string).toISOString(),
    updatedAt: new Date(row.updated_at as string).toISOString(),
  };
}

const FEEDBACK_SELECT = `
  SELECT f.*, u.name AS user_name, u.email AS user_email,
         w.name AS workspace_name, w.slug AS workspace_slug,
         sl.expires_at AS support_expires_at,
         sl.revoked_at AS support_revoked_at
  FROM feedback_items f
  LEFT JOIN "user" u ON u.id = f.user_id
  LEFT JOIN workspaces w ON w.id = f.workspace_id
  LEFT JOIN share_links sl ON sl.token = f.support_share_token`;

export async function listFeedback(
  pool: Pool,
  input: { status?: string | null; category?: string | null; query?: string | null },
) {
  const values: unknown[] = [];
  const conditions: string[] = [];
  if (input.status && STATUSES.has(input.status as FeedbackStatus)) {
    values.push(input.status);
    conditions.push(`f.status = $${values.length}`);
  }
  if (input.category && CATEGORIES.has(input.category as FeedbackCategory)) {
    values.push(input.category);
    conditions.push(`f.category = $${values.length}`);
  }
  if (input.query?.trim()) {
    values.push(`%${input.query.trim().slice(0, 100)}%`);
    conditions.push(
      `(f.message ILIKE $${values.length} OR u.email ILIKE $${values.length} OR w.name ILIKE $${values.length})`,
    );
  }
  const result = await pool.query(
    `${FEEDBACK_SELECT}
     ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
     ORDER BY CASE f.status WHEN 'new' THEN 0 WHEN 'reviewing' THEN 1 ELSE 2 END,
              f.created_at DESC
     LIMIT 200`,
    values,
  );
  return result.rows.map((row) => mapFeedbackRow(row));
}

export async function unreadFeedbackCount(pool: Pool): Promise<number> {
  const result = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM feedback_items WHERE status = 'new'`,
  );
  return Number(result.rows[0]?.count ?? 0);
}

export async function getFeedback(pool: Pool, id: string) {
  const result = await pool.query(`${FEEDBACK_SELECT} WHERE f.id = $1`, [id]);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  const replies = await pool.query(
    `SELECT r.id, r.body, r.sent_by, r.sent_at, u.name AS sender_name
     FROM feedback_replies r LEFT JOIN "user" u ON u.id = r.sent_by
     WHERE r.feedback_id = $1 ORDER BY r.sent_at ASC`,
    [id],
  );
  return {
    ...mapFeedbackRow(row, true),
    replies: replies.rows.map((reply) => ({
      id: reply.id as string,
      body: reply.body as string,
      sentBy: reply.sent_by as string,
      senderName: (reply.sender_name as string | null) ?? 'Pitolet support',
      sentAt: new Date(reply.sent_at as string).toISOString(),
    })),
  };
}

export async function updateFeedbackStatus(
  pool: Pool,
  id: string,
  status: string,
): Promise<boolean> {
  if (!STATUSES.has(status as FeedbackStatus)) throw new FeedbackInputError('invalid status');
  const result = await pool.query(
    `UPDATE feedback_items SET status = $2, updated_at = now() WHERE id = $1`,
    [id, status],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function replyToFeedback(
  pool: Pool,
  id: string,
  admin: { id: string; name: string },
  body: string,
): Promise<{ id: string; sentAt: string } | null> {
  const message = body.trim();
  if (!message || message.length > 5000)
    throw new FeedbackInputError('reply must contain 1–5000 characters');
  const item = await pool.query(
    `SELECT f.message, u.email, u.name
     FROM feedback_items f JOIN "user" u ON u.id = f.user_id
     WHERE f.id = $1`,
    [id],
  );
  const row = item.rows[0] as { email: string; name: string; message: string } | undefined;
  if (!row) return null;
  await sendMail({
    to: [row.email],
    subject: 'A reply from Pitolet support',
    text: `${message}\n\nYour feedback:\n${row.message}`,
  });
  const inserted = await pool.query<{ id: string; sent_at: Date }>(
    `INSERT INTO feedback_replies (feedback_id, sent_by, body)
     VALUES ($1, $2, $3) RETURNING id, sent_at`,
    [id, admin.id, message],
  );
  await pool.query(
    `UPDATE feedback_items SET status = 'reviewing', updated_at = now() WHERE id = $1`,
    [id],
  );
  return { id: inserted.rows[0]!.id, sentAt: inserted.rows[0]!.sent_at.toISOString() };
}
