import type { PatchOp } from '@pitolet/schema';

export interface HistoryEntry {
  patchId: string;
  label: string;
  ops: PatchOp[];
  inverseOps: PatchOp[];
  origin: 'local' | 'remote';
  /** Selection to restore when undoing to before this entry. */
  selectionBefore: string[];
  selectionAfter: string[];
  /** Entries sharing a coalesce key merge into one undo step (scrubs, typing). */
  coalesceKey?: string;
}

const LIMIT = 200;

/**
 * Undo/redo stacks. Lives outside React state — pushes during interactions
 * must never cause renders. Remote (MCP/other-client) patches are recorded
 * too, so a human can undo an agent's edit.
 */
export class History {
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];

  push(entry: HistoryEntry): void {
    const top = this.undoStack[this.undoStack.length - 1];
    if (
      entry.coalesceKey !== undefined &&
      top?.coalesceKey === entry.coalesceKey &&
      top.origin === 'local'
    ) {
      // Merge: forward ops accumulate; the inverse rewinds through both.
      top.ops = [...top.ops, ...entry.ops];
      top.inverseOps = [...entry.inverseOps, ...top.inverseOps];
      top.selectionAfter = entry.selectionAfter;
      top.patchId = entry.patchId;
      this.redoStack = [];
      return;
    }
    this.undoStack.push(entry);
    if (this.undoStack.length > LIMIT) this.undoStack.shift();
    this.redoStack = [];
  }

  popUndo(): HistoryEntry | undefined {
    const entry = this.undoStack.pop();
    if (entry) this.redoStack.push(entry);
    return entry;
  }

  popRedo(): HistoryEntry | undefined {
    const entry = this.redoStack.pop();
    if (entry) this.undoStack.push(entry);
    return entry;
  }

  /** Server rejected a patch — drop it from history (it never happened). */
  discard(patchId: string): HistoryEntry | undefined {
    const i = this.undoStack.findIndex((e) => e.patchId === patchId);
    if (i >= 0) return this.undoStack.splice(i, 1)[0];
    const j = this.redoStack.findIndex((e) => e.patchId === patchId);
    if (j >= 0) return this.redoStack.splice(j, 1)[0];
    return undefined;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }
}
