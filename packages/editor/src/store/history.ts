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
  /**
   * Transport patches that make up this logical history entry. Keeping the
   * segments separate means one rejected scrub/typing patch can be removed
   * without discarding or rewinding the other, already accepted segments.
   */
  segments?: HistorySegment[];
}

export interface HistorySegment {
  patchId: string;
  ops: PatchOp[];
  inverseOps: PatchOp[];
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
    entry.segments ??= [{ patchId: entry.patchId, ops: entry.ops, inverseOps: entry.inverseOps }];
    const top = this.undoStack[this.undoStack.length - 1];
    if (
      entry.coalesceKey !== undefined &&
      top?.coalesceKey === entry.coalesceKey &&
      top.origin === 'local'
    ) {
      // Merge: forward ops accumulate; the inverse rewinds through both.
      top.ops = [...top.ops, ...entry.ops];
      top.inverseOps = [...entry.inverseOps, ...top.inverseOps];
      top.segments = [...segmentsOf(top), ...segmentsOf(entry)];
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

  /**
   * Server rejected a transport patch. Remove only that patch's segment from
   * its logical undo entry; coalesced neighbours may already be authoritative.
   */
  discard(patchId: string): HistoryEntry | undefined {
    const discarded = discardFromStack(this.undoStack, patchId);
    if (discarded) return discarded;
    const redone = discardFromStack(this.redoStack, patchId);
    if (redone) return redone;
    return undefined;
  }

  /** Put a rejected undo back where it was before the optimistic transition. */
  restoreUndo(entry: HistoryEntry): void {
    removeEntry(this.redoStack, entry);
    if (!this.undoStack.includes(entry)) this.undoStack.push(entry);
  }

  /** Put a rejected redo back where it was before the optimistic transition. */
  restoreRedo(entry: HistoryEntry): void {
    removeEntry(this.undoStack, entry);
    if (!this.redoStack.includes(entry)) this.redoStack.push(entry);
  }

  /** Rebase a still-pending segment's undo data onto a newer confirmed base. */
  updateInverse(patchId: string, inverseOps: PatchOp[]): void {
    const entry = [...this.undoStack, ...this.redoStack].find((candidate) =>
      segmentsOf(candidate).some((segment) => segment.patchId === patchId),
    );
    if (!entry) return;
    const segment = segmentsOf(entry).find((candidate) => candidate.patchId === patchId);
    if (!segment) return;
    segment.inverseOps = inverseOps;
    entry.inverseOps = [...segmentsOf(entry)]
      .reverse()
      .flatMap((candidate) => candidate.inverseOps);
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

  get undoLabel(): string | null {
    return this.undoStack.at(-1)?.label ?? null;
  }

  get redoLabel(): string | null {
    return this.redoStack.at(-1)?.label ?? null;
  }
}

function segmentsOf(entry: HistoryEntry): HistorySegment[] {
  return (
    entry.segments ?? [{ patchId: entry.patchId, ops: entry.ops, inverseOps: entry.inverseOps }]
  );
}

function discardFromStack(stack: HistoryEntry[], patchId: string): HistoryEntry | undefined {
  const entryIndex = stack.findIndex((entry) =>
    segmentsOf(entry).some((segment) => segment.patchId === patchId),
  );
  if (entryIndex < 0) return undefined;

  const entry = stack[entryIndex]!;
  const segment = segmentsOf(entry).find((candidate) => candidate.patchId === patchId)!;
  const remaining = segmentsOf(entry).filter((candidate) => candidate.patchId !== patchId);
  if (remaining.length === 0) {
    stack.splice(entryIndex, 1);
  } else {
    entry.segments = remaining;
    entry.patchId = remaining.at(-1)!.patchId;
    entry.ops = remaining.flatMap((candidate) => candidate.ops);
    entry.inverseOps = [...remaining].reverse().flatMap((candidate) => candidate.inverseOps);
  }

  return {
    ...entry,
    patchId: segment.patchId,
    ops: segment.ops,
    inverseOps: segment.inverseOps,
    segments: [segment],
  };
}

function removeEntry(stack: HistoryEntry[], entry: HistoryEntry): void {
  const index = stack.indexOf(entry);
  if (index >= 0) stack.splice(index, 1);
}
