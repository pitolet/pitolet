import type { PitoletDocument } from './document.js';
import type { NodeId } from './nodes.js';
import type { PatchActor, PatchOp } from './patch.js';

/**
 * WebSocket wire protocol between editor clients and the authoritative server.
 * MCP writes enter the same pipeline server-side and surface to clients as
 * `patch` messages with origin 'mcp'.
 */

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
  | { t: 'screenshot-result'; reqId: string; dataUrl?: string; error?: string };

export type ServerMessage =
  | { t: 'doc'; docId: string; rev: number; document: PitoletDocument }
  | { t: 'ack'; patchId: string; rev: number }
  | { t: 'reject'; patchId: string; reason: string }
  | {
      t: 'patch';
      docId: string;
      rev: number;
      origin: string;
      label: string;
      ops: PatchOp[];
      /** Per-user attribution, stamped server-side. Absent = single-user. */
      actor?: PatchActor;
    }
  | { t: 'selection'; docId: string; nodeIds: NodeId[]; origin: string }
  | { t: 'request-screenshot'; reqId: string; frameId: NodeId; maxSize: number }
  | { t: 'error'; message: string };
