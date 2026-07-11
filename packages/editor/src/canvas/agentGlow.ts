import type { NodeId } from '@pitolet/schema';
import { overlaySync } from './overlaySync.js';

const GLOW_MS = 1600;

/**
 * Transient "the agent just touched this" glow. MCP-origin patches flash the
 * nodes they changed so a watching human sees exactly what the agent did.
 * Module-level mutable state + overlaySync ticks (same pattern as
 * interactionState) — zero React renders to schedule.
 */
const glowing = new Map<NodeId, number>();

export function flashNodes(ids: Iterable<NodeId>): void {
  const expiry = Date.now() + GLOW_MS;
  let added = false;
  for (const id of ids) {
    glowing.set(id, expiry);
    added = true;
  }
  if (!added) return;
  overlaySync.notify();
  setTimeout(() => {
    const now = Date.now();
    for (const [id, exp] of glowing) {
      if (exp <= now) glowing.delete(id);
    }
    overlaySync.notify();
  }, GLOW_MS + 50);
}

/** Node ids currently glowing (unexpired). */
export function glowingNodeIds(): NodeId[] {
  const now = Date.now();
  const out: NodeId[] = [];
  for (const [id, exp] of glowing) {
    if (exp > now) out.push(id);
  }
  return out;
}
