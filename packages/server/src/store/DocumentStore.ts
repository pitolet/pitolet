import {
  structuralProblems,
  validateNode,
  zBreakpoint,
  zComment,
  zComponentDef,
  zTokenSet,
  type PitoletDocument,
  type PatchActor,
  type PatchOp,
} from '@pitolet/schema';
import { applyPatches, enablePatches, produce, produceWithPatches, type Draft } from 'immer';

enablePatches();

export interface AppliedPatch {
  docId: string;
  rev: number;
  origin: string;
  label: string;
  ops: PatchOp[];
  /** Per-user attribution, when known. Absent = single-user (today). */
  actor?: PatchActor;
}

export type PatchListener = (patch: AppliedPatch) => void;

export class PatchRejectedError extends Error {}

interface DocEntry {
  doc: PitoletDocument;
  rev: number;
}

/**
 * The authoritative in-memory document store. Every mutation — editor
 * patches, MCP writes — flows through applyPatch(): apply → validate →
 * bump rev → notify (broadcast + persistence). Application is serialized by
 * the Node event loop; there is no partial application (a failed patch
 * leaves the stored document untouched).
 */
export class DocumentStore {
  private docs = new Map<string, DocEntry>();
  private listeners = new Set<PatchListener>();

  load(doc: PitoletDocument, rev = 0): void {
    this.docs.set(doc.id, { doc, rev });
  }

  unload(docId: string): void {
    this.docs.delete(docId);
  }

  /** Replace a document wholesale (external file change). Bumps rev. */
  replace(doc: PitoletDocument): number {
    const entry = this.docs.get(doc.id);
    const rev = (entry?.rev ?? 0) + 1;
    this.docs.set(doc.id, { doc, rev });
    return rev;
  }

  get(docId: string): { doc: PitoletDocument; rev: number } | undefined {
    const entry = this.docs.get(docId);
    return entry ? { doc: entry.doc, rev: entry.rev } : undefined;
  }

  list(): Array<{ id: string; name: string; rev: number; frameCount: number }> {
    return [...this.docs.values()].map(({ doc, rev }) => ({
      id: doc.id,
      name: doc.name,
      rev,
      frameCount: doc.rootOrder.length,
    }));
  }

  subscribe(listener: PatchListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Apply ops to a document. Throws PatchRejectedError (doc untouched) when
   * the ops are invalid. Returns the new revision.
   */
  applyPatch(
    docId: string,
    ops: PatchOp[],
    origin: string,
    label: string,
    actor?: PatchActor,
  ): number {
    const entry = this.docs.get(docId);
    if (!entry) throw new PatchRejectedError(`unknown document ${docId}`);

    let next: PitoletDocument;
    try {
      next = produce(entry.doc, (draft) => {
        applyPatches(draft, ops);
      });
    } catch (err) {
      throw new PatchRejectedError(
        `patch failed to apply: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    this.validate(next, ops);

    entry.doc = next;
    entry.rev += 1;
    const applied: AppliedPatch = { docId, rev: entry.rev, origin, label, ops, actor };
    for (const listener of this.listeners) listener(applied);
    return entry.rev;
  }

  /**
   * Server-side mutation entry point (MCP tools): run a recipe, derive its
   * ops, validate, commit, notify. Same guarantees as applyPatch.
   */
  applyRecipe(
    docId: string,
    origin: string,
    label: string,
    recipe: (draft: Draft<PitoletDocument>) => void,
    actor?: PatchActor,
  ): number {
    const entry = this.docs.get(docId);
    if (!entry) throw new PatchRejectedError(`unknown document ${docId}`);
    let next: PitoletDocument;
    let ops: PatchOp[];
    try {
      const result = produceWithPatches(entry.doc, recipe);
      next = result[0];
      ops = result[1] as PatchOp[];
    } catch (err) {
      throw new PatchRejectedError(
        `edit failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (ops.length === 0) return entry.rev;
    this.validate(next, ops);
    entry.doc = next;
    entry.rev += 1;
    const applied: AppliedPatch = { docId, rev: entry.rev, origin, label, ops, actor };
    for (const listener of this.listeners) listener(applied);
    return entry.rev;
  }

  /** Validate only what the ops touched (plus cheap structural coherence). */
  private validate(doc: PitoletDocument, ops: PatchOp[]): void {
    const touchedNodes = new Set<string>();
    const touchedComments = new Set<string>();
    let structural = false;
    let checkTokens = false;
    let checkComponents = false;
    let checkBreakpoints = false;

    for (const op of ops) {
      const [head, key] = op.path;
      switch (head) {
        case 'comments':
          if (typeof key === 'string') touchedComments.add(key);
          break;
        case 'nodes':
          if (typeof key === 'string') touchedNodes.add(key);
          if (op.path.length <= 2 || op.path[2] === 'parent' || op.path[2] === 'children') {
            structural = true;
          }
          break;
        case 'rootOrder':
          structural = true;
          break;
        case 'tokens':
          checkTokens = true;
          break;
        case 'components':
          checkComponents = true;
          structural = true;
          break;
        case 'breakpoints':
          checkBreakpoints = true;
          break;
        case 'name':
        case 'assets':
          break;
        default:
          throw new PatchRejectedError(`patch touches forbidden path ${String(head)}`);
      }
    }

    try {
      for (const nodeId of touchedNodes) {
        const node = doc.nodes[nodeId];
        if (node !== undefined) validateNode(node);
      }
      for (const commentId of touchedComments) {
        const comment = doc.comments?.[commentId];
        if (comment !== undefined) zComment.parse(comment);
      }
      if (checkTokens) zTokenSet.parse(doc.tokens);
      if (checkBreakpoints) doc.breakpoints.forEach((bp) => zBreakpoint.parse(bp));
      if (checkComponents) {
        Object.values(doc.components).forEach((c) => zComponentDef.parse(c));
      }
    } catch (err) {
      throw new PatchRejectedError(
        `patch produced invalid data: ${err instanceof Error ? err.message.slice(0, 400) : String(err)}`,
      );
    }

    if (structural) {
      const problems = structuralProblems(doc);
      if (problems.length > 0) {
        throw new PatchRejectedError(`patch breaks document structure: ${problems[0]}`);
      }
    }
  }
}
