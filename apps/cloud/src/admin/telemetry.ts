import { createHash } from 'node:crypto';
import type { Pool } from 'pg';

export const CLIENT_EVENT_NAMES = [
  'dashboard_opened',
  'workspace_opened',
  'editor_opened',
  'prompt_copied',
  'manual_setup_opened',
] as const;
export type ClientEventName = (typeof CLIENT_EVENT_NAMES)[number];
export type ProblemSource = 'dashboard' | 'editor' | 'server' | 'runtime' | 'storage';
export type ProblemSeverity = 'warning' | 'error' | 'fatal';

const CLIENT_EVENT_SET = new Set<string>(CLIENT_EVENT_NAMES);
const ALLOWED_EVENT_PROPERTIES: Record<ClientEventName, Set<string>> = {
  dashboard_opened: new Set(),
  workspace_opened: new Set(),
  editor_opened: new Set(),
  prompt_copied: new Set(['intent', 'client', 'includedConnection']),
  manual_setup_opened: new Set(['client']),
};

const AGENT_CLIENTS = new Set(['codex', 'claude-code', 'cursor', 'other']);

export function parseClientEvent(raw: unknown): {
  name: ClientEventName;
  workspaceId: string | null;
  documentId: string | null;
  source: 'dashboard' | 'editor';
  properties: Record<string, string | boolean>;
} | null {
  if (!raw || typeof raw !== 'object') return null;
  const body = raw as Record<string, unknown>;
  if (typeof body.name !== 'string' || !CLIENT_EVENT_SET.has(body.name)) return null;
  if (body.source !== 'dashboard' && body.source !== 'editor') return null;
  const name = body.name as ClientEventName;
  const properties: Record<string, string | boolean> = {};
  if (body.properties !== undefined) {
    if (!body.properties || typeof body.properties !== 'object' || Array.isArray(body.properties)) {
      return null;
    }
    for (const [key, value] of Object.entries(body.properties as Record<string, unknown>)) {
      if (!ALLOWED_EVENT_PROPERTIES[name].has(key)) return null;
      if (typeof value !== 'string' && typeof value !== 'boolean') return null;
      if (typeof value === 'string' && value.length > 40) return null;
      properties[key] = value;
    }
  }
  if (name === 'prompt_copied') {
    if (properties.intent !== 'scratch' && properties.intent !== 'import') return null;
    if (typeof properties.client !== 'string' || !AGENT_CLIENTS.has(properties.client)) return null;
    if (typeof properties.includedConnection !== 'boolean') return null;
  } else if (name === 'manual_setup_opened') {
    if (typeof properties.client !== 'string' || !AGENT_CLIENTS.has(properties.client)) return null;
  } else if (Object.keys(properties).length > 0) {
    return null;
  }
  const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : null;
  const documentId = typeof body.documentId === 'string' ? body.documentId.slice(0, 128) : null;
  return { name, workspaceId, documentId, source: body.source, properties };
}

export async function recordProductEvent(
  pool: Pool,
  input: {
    name: ClientEventName | 'document_imported';
    source: 'dashboard' | 'editor' | 'server';
    userId: string;
    workspaceId?: string | null;
    documentId?: string | null;
    properties?: Record<string, string | boolean>;
  },
): Promise<void> {
  const dedupeOpened =
    input.name === 'dashboard_opened' ||
    input.name === 'workspace_opened' ||
    input.name === 'editor_opened';
  await pool.query(
    `INSERT INTO product_events
       (name, source, user_id, workspace_id, document_id, properties)
     SELECT $1, $2, $3, $4, $5, $6::jsonb
     WHERE $7::boolean = false OR NOT EXISTS (
       SELECT 1 FROM product_events
       WHERE name = $1 AND source = $2 AND user_id = $3
         AND workspace_id IS NOT DISTINCT FROM $4::uuid
         AND document_id IS NOT DISTINCT FROM $5::text
         AND occurred_at > now() - interval '30 minutes'
     )`,
    [
      input.name,
      input.source,
      input.userId,
      input.workspaceId ?? null,
      input.documentId ?? null,
      JSON.stringify(input.properties ?? {}),
      dedupeOpened,
    ],
  );
}

const REDACTIONS: Array<[RegExp, string]> = [
  [/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]'],
  [/\bptl_[0-9a-f]{40}\b/gi, '[agent-token]'],
  [/\bpshare_[A-Za-z0-9_-]{24}\b/g, '[share-token]'],
  [/\bpsess_[A-Za-z0-9_-]{32}\b/g, '[share-session]'],
  [/\b(token|code|secret|key)=[^&\s]+/gi, '$1=[redacted]'],
];

export function redactDiagnostic(value: unknown, maxLength = 8_000): string {
  let text =
    value instanceof Error ? `${value.name}: ${value.message}` : String(value ?? 'Unknown error');
  for (const [pattern, replacement] of REDACTIONS) text = text.replace(pattern, replacement);
  return text.slice(0, maxLength);
}

const CLIENT_PROBLEM_TITLES = new Set(['Browser error', 'Error', 'Unhandled promise rejection']);

export function safeClientProblemTitle(value: unknown): string {
  const text = value instanceof Error ? value.name : typeof value === 'string' ? value : '';
  const candidate = text.split(':', 1)[0]?.trim() ?? '';
  if (CLIENT_PROBLEM_TITLES.has(candidate)) return candidate;
  if (/^[A-Za-z][A-Za-z0-9]{0,39}(?:Error|Exception)$/.test(candidate)) return candidate;
  return 'Browser error';
}

export function safeClientProblemStack(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const frames = value
    .split('\n')
    .filter((line) => /^\s*at\s+/.test(line))
    .slice(0, 20)
    .map((line) => redactDiagnostic(line, 500));
  return frames.length ? frames.join('\n').slice(0, 8_000) : null;
}

function normalizedFingerprintPart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/g, '[id]')
    .replace(/\b\d+\b/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
}

export function problemFingerprint(
  source: ProblemSource,
  title: string,
  route?: string | null,
): string {
  return createHash('sha256')
    .update(`${source}\n${normalizedFingerprintPart(title)}\n${route ?? ''}`)
    .digest('hex');
}

function safeContext(
  raw: Record<string, unknown> | undefined,
): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  if (!raw) return out;
  for (const [key, value] of Object.entries(raw).slice(0, 20)) {
    if (!['component', 'operation', 'code', 'method'].includes(key)) continue;
    if (typeof value === 'string') out[key] = redactDiagnostic(value, 200);
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null)
      out[key] = value;
  }
  return out;
}

export async function recordProblem(
  pool: Pool,
  input: {
    source: ProblemSource;
    severity?: ProblemSeverity;
    title: unknown;
    stack?: unknown;
    route?: string | null;
    release?: string | null;
    userId?: string | null;
    workspaceId?: string | null;
    documentId?: string | null;
    context?: Record<string, unknown>;
  },
): Promise<string> {
  const title = redactDiagnostic(input.title, 1_000) || 'Unknown error';
  const stack = input.stack ? redactDiagnostic(input.stack, 12_000) : null;
  const route = input.route ? redactDiagnostic(input.route.split('?')[0], 500) : null;
  const fingerprint = problemFingerprint(input.source, title, route);
  await pool.query(
    `INSERT INTO problem_groups
       (fingerprint, source, severity, title, stack, release, route,
        last_user_id, last_workspace_id, last_document_id, context)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
     ON CONFLICT (fingerprint) DO UPDATE SET
       occurrence_count = problem_groups.occurrence_count + 1,
       last_seen_at = now(),
       status = CASE WHEN problem_groups.status = 'resolved' THEN 'open' ELSE problem_groups.status END,
       resolved_at = CASE WHEN problem_groups.status = 'resolved' THEN NULL ELSE problem_groups.resolved_at END,
       stack = COALESCE(EXCLUDED.stack, problem_groups.stack),
       release = COALESCE(EXCLUDED.release, problem_groups.release),
       last_user_id = EXCLUDED.last_user_id,
       last_workspace_id = EXCLUDED.last_workspace_id,
       last_document_id = EXCLUDED.last_document_id,
       context = EXCLUDED.context`,
    [
      fingerprint,
      input.source,
      input.severity ?? 'error',
      title,
      stack,
      input.release ?? null,
      route,
      input.userId ?? null,
      input.workspaceId ?? null,
      input.documentId ?? null,
      JSON.stringify(safeContext(input.context)),
    ],
  );
  return fingerprint;
}

export async function runTelemetryRetention(pool: Pool): Promise<void> {
  await pool.query(
    `DELETE FROM product_events WHERE id IN (
       SELECT id FROM product_events
       WHERE occurred_at < now() - interval '90 days'
       ORDER BY occurred_at ASC LIMIT 1000
     )`,
  );
  await pool.query(
    `DELETE FROM problem_groups WHERE fingerprint IN (
       SELECT fingerprint FROM problem_groups
       WHERE last_seen_at < now() - interval '90 days'
       ORDER BY last_seen_at ASC LIMIT 1000
     )`,
  );
  await pool.query(
    `UPDATE feedback_items SET screenshot_data = NULL, screenshot_mime = NULL
     WHERE id IN (
       SELECT id FROM feedback_items
       WHERE screenshot_data IS NOT NULL AND created_at < now() - interval '30 days'
       ORDER BY created_at ASC LIMIT 100
     )`,
  );
  await pool.query(
    `DELETE FROM feedback_items WHERE id IN (
       SELECT id FROM feedback_items
       WHERE status = 'resolved' AND updated_at < now() - interval '1 year'
       ORDER BY updated_at ASC LIMIT 100
     )`,
  );
}

export function startTelemetryRetention(
  pool: Pool,
  intervalMs = 24 * 60 * 60_000,
): { stop(): void } {
  const run = () =>
    void runTelemetryRetention(pool).catch((error) => {
      console.error('[pitolet-cloud] telemetry retention failed:', error);
    });
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
