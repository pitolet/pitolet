import type { PitoletDocument } from './document.js';
import type { NodeId } from './nodes.js';
import type { PatchOp } from './patch.js';
import { validateDocument } from './zod.js';
import { z } from 'zod';

/**
 * WebSocket wire protocol between editor clients and the authoritative server.
 * MCP writes enter the same pipeline server-side and surface to clients as
 * `patch` messages with origin 'mcp'.
 */

export const MAX_WS_MESSAGE_BYTES = 8 * 1024 * 1024;
/** Server snapshots may contain a valid document body up to the 25 MB API limit. */
export const MAX_SERVER_MESSAGE_BYTES = 32 * 1024 * 1024;
export const MAX_PATCH_OPS = 1_000;
export const MAX_PATCH_LABEL_LENGTH = 200;
export const MAX_PATCH_PATH_DEPTH = 64;
export const MAX_PATCH_VALUE_DEPTH = 64;
export const MAX_PATCH_VALUE_ENTRIES = 100_000;
export const MAX_SELECTION_IDS = 1_000;
export const MAX_APPLIED_PATCH_IDS = 10_000;
export const MAX_SCREENSHOT_SIZE = 2_000;

const zWireId = z.string().min(1).max(256);
const zWireText = z.string().min(1).max(MAX_PATCH_LABEL_LENGTH);
const zWireActor = z
  .object({
    id: zWireId,
    name: z.string().min(1).max(256),
  })
  .strict();
const zPatchOp = z
  .object({
    op: z.enum(['add', 'replace', 'remove']),
    path: z
      .array(z.union([z.string().max(256), z.number().int().nonnegative()]))
      .min(1)
      .max(MAX_PATCH_PATH_DEPTH),
    value: z.unknown().optional(),
  })
  .strict()
  .superRefine((operation, context) => {
    if (
      operation.value !== undefined &&
      !isJsonWithinLimits(operation.value, MAX_PATCH_VALUE_DEPTH, MAX_PATCH_VALUE_ENTRIES)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: 'patch value is too deeply nested or complex',
      });
    }
  });

/** Runtime validation for untrusted editor WebSocket messages. */
export const zClientMessage = z.discriminatedUnion('t', [
  z.object({ t: z.literal('open'), docId: zWireId }).strict(),
  z
    .object({
      t: z.literal('patch'),
      docId: zWireId,
      patchId: zWireId,
      baseRev: z.number().int().nonnegative(),
      label: z.string().min(1).max(MAX_PATCH_LABEL_LENGTH),
      ops: z.array(zPatchOp).min(1).max(MAX_PATCH_OPS),
    })
    .strict(),
  z
    .object({
      t: z.literal('select'),
      docId: zWireId,
      nodeIds: z.array(zWireId).max(MAX_SELECTION_IDS),
    })
    .strict(),
  z
    .object({
      t: z.literal('screenshot-result'),
      reqId: zWireId,
      dataUrl: z.string().max(MAX_WS_MESSAGE_BYTES).optional(),
      error: z.string().max(1_000).optional(),
    })
    .strict()
    .refine((message) => message.dataUrl !== undefined || message.error !== undefined, {
      message: 'screenshot result requires dataUrl or error',
    }),
  z.object({ t: z.literal('ping'), nonce: zWireId }).strict(),
]);

export type ClientMessage =
  | { t: 'open'; docId: string }
  | {
      t: 'patch';
      docId: string;
      patchId: string;
      baseRev: number;
      label: string;
      ops: PatchOp[];
    }
  | { t: 'select'; docId: string; nodeIds: NodeId[] }
  | { t: 'screenshot-result'; reqId: string; dataUrl?: string; error?: string }
  | { t: 'ping'; nonce: string };

export type PatchRejectCode =
  'revision_conflict' | 'invalid_patch' | 'forbidden' | 'document_not_open';

const zServerDocument = z.unknown().transform((value, context): PitoletDocument => {
  try {
    return validateDocument(value);
  } catch (error) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: error instanceof Error ? error.message : 'invalid document',
    });
    return z.NEVER;
  }
});

/** Runtime validation for untrusted server WebSocket messages. */
export const zServerMessage = z.discriminatedUnion('t', [
  z
    .object({
      t: z.literal('doc'),
      docId: zWireId,
      rev: z.number().int().nonnegative(),
      document: zServerDocument,
      /** Recent editor patch ids already committed, for reconnect deduplication. */
      appliedPatchIds: z.array(zWireId).max(MAX_APPLIED_PATCH_IDS).optional(),
    })
    .strict(),
  z
    .object({
      t: z.literal('ack'),
      docId: zWireId,
      patchId: zWireId,
      rev: z.number().int().nonnegative(),
      duplicate: z.literal(true).optional(),
    })
    .strict(),
  z
    .object({
      t: z.literal('reject'),
      docId: zWireId,
      patchId: zWireId,
      reason: z.string().min(1).max(1_000),
      rev: z.number().int().nonnegative(),
      code: z.enum(['revision_conflict', 'invalid_patch', 'forbidden', 'document_not_open']),
    })
    .strict(),
  z
    .object({
      t: z.literal('patch'),
      docId: zWireId,
      rev: z.number().int().nonnegative(),
      origin: z.string().min(1).max(256),
      label: zWireText,
      ops: z.array(zPatchOp).min(1).max(MAX_PATCH_OPS),
      /** Per-user attribution, stamped server-side. Absent = single-user. */
      actor: zWireActor.optional(),
    })
    .strict(),
  z
    .object({
      t: z.literal('selection'),
      docId: zWireId,
      nodeIds: z.array(zWireId).max(MAX_SELECTION_IDS),
      origin: z.string().min(1).max(256),
    })
    .strict(),
  z
    .object({
      t: z.literal('request-screenshot'),
      reqId: zWireId,
      frameId: zWireId,
      maxSize: z.number().int().min(100).max(MAX_SCREENSHOT_SIZE),
    })
    .strict(),
  z.object({ t: z.literal('pong'), nonce: zWireId }).strict(),
  z.object({ t: z.literal('error'), message: z.string().min(1).max(1_000) }).strict(),
]);

export type ServerMessage = z.infer<typeof zServerMessage>;

export function isJsonWithinLimits(value: unknown, maxDepth: number, maxEntries: number): boolean {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let entries = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (
      current.value === null ||
      typeof current.value === 'string' ||
      typeof current.value === 'number' ||
      typeof current.value === 'boolean'
    ) {
      continue;
    }
    if (typeof current.value !== 'object' || current.depth >= maxDepth) return false;
    const children = Array.isArray(current.value)
      ? current.value
      : Object.values(current.value as Record<string, unknown>);
    entries += children.length;
    if (entries > maxEntries) return false;
    for (const child of children) stack.push({ value: child, depth: current.depth + 1 });
  }
  return true;
}
