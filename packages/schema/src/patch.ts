/**
 * Patch operations — the single mutation currency of the whole system.
 *
 * These are Immer's patch format verbatim: the editor produces them with
 * `produceWithPatches`, the server applies them with `applyPatches`, MCP
 * writes are converted into them, and undo stacks store them with inverses.
 */

export interface PatchOp {
  op: 'add' | 'replace' | 'remove';
  path: (string | number)[];
  value?: unknown;
}

export type PatchOrigin = 'local' | `editor:${string}` | 'mcp' | 'server';

/**
 * Optional per-user attribution riding alongside a patch. Absent today
 * (single-user); a future multi-user deployment stamps it server-side so the
 * activity feed can show "Alice · Move Frame". Never sent by clients.
 */
export interface PatchActor {
  id: string;
  name: string;
}

export interface PatchRecord {
  /** Unique id for ack/reject correlation. */
  patchId: string;
  /** Human-readable label shown in history, e.g. "Move Frame" or "MCP: update_node". */
  label: string;
  ops: PatchOp[];
  origin: PatchOrigin;
}
