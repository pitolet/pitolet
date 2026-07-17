import {
  MAX_PATCH_OPS,
  MAX_PATCH_LABEL_LENGTH,
  MAX_PATCH_PATH_DEPTH,
  MAX_PATCH_VALUE_DEPTH,
  MAX_PATCH_VALUE_ENTRIES,
  isJsonWithinLimits,
  structuralProblems,
  validateDocument,
  validateNode,
  zAsset,
  zBreakpoint,
  zComment,
  zComponentDef,
  zServerMessage,
  zTokenSet,
  type PatchRejectCode,
  type PitoletDocument,
  type PatchActor,
  type PatchOp,
} from '@pitolet/schema';
import { applyPatches, enablePatches, produce, produceWithPatches, type Draft } from 'immer';

enablePatches();

export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

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

export class PatchRejectedError extends Error {
  constructor(
    message: string,
    readonly code: PatchRejectCode = 'invalid_patch',
    readonly rev?: number,
  ) {
    super(message);
    this.name = 'PatchRejectedError';
  }
}

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
    const validated = validateDocument(doc);
    assertDocumentSize(validated);
    this.docs.set(validated.id, { doc: validated, rev });
  }

  unload(docId: string): void {
    this.docs.delete(docId);
  }

  /** Replace a document wholesale (external file change). Bumps rev. */
  replace(doc: PitoletDocument): number {
    const validated = validateDocument(doc);
    assertDocumentSize(validated);
    const entry = this.docs.get(validated.id);
    const rev = (entry?.rev ?? 0) + 1;
    this.docs.set(validated.id, { doc: validated, rev });
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
    expectedRev?: number,
  ): number {
    const entry = this.docs.get(docId);
    if (!entry) throw new PatchRejectedError(`unknown document ${docId}`);
    if (expectedRev !== undefined && expectedRev !== entry.rev) {
      throw new PatchRejectedError(
        `revision conflict: expected ${expectedRev}, current revision is ${entry.rev}`,
        'revision_conflict',
        entry.rev,
      );
    }
    this.validatePatchEnvelope(ops, entry.rev);

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

    const applied = this.prepareAppliedPatch({
      docId,
      rev: entry.rev + 1,
      origin,
      label,
      ops,
      actor,
    });
    entry.doc = next;
    entry.rev = applied.rev;
    this.notify(applied);
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
    this.validatePatchEnvelope(ops, entry.rev);
    this.validate(next, ops);
    const applied = this.prepareAppliedPatch({
      docId,
      rev: entry.rev + 1,
      origin,
      label,
      ops,
      actor,
    });
    entry.doc = next;
    entry.rev = applied.rev;
    this.notify(applied);
    return entry.rev;
  }

  /**
   * Keep the store's committed patch envelope identical to the public wire
   * contract. MCP and other server-side recipes do not pass through the
   * client-message parser, so validate their generated paths, values,
   * attribution, and labels here before advancing the authoritative revision.
   */
  private prepareAppliedPatch(applied: AppliedPatch): AppliedPatch {
    const normalized = { ...applied, label: normalizePatchLabel(applied.label) };
    const result = zServerMessage.safeParse({ t: 'patch', ...normalized });
    if (!result.success) {
      const issue = result.error.issues[0];
      const location = issue?.path.length ? ` at ${issue.path.join('.')}` : '';
      throw new PatchRejectedError(
        `patch cannot be represented by the sync protocol${location}: ${issue?.message ?? 'invalid patch envelope'}`,
        'invalid_patch',
        applied.rev - 1,
      );
    }
    return normalized;
  }

  /**
   * A subscriber is a side effect of an already-committed edit. Letting one
   * throw would tell the caller that an accepted edit failed even though the
   * authoritative revision has advanced, which is an unrecoverable protocol
   * lie. Storage adapters must surface durability failures through flush(),
   * while other subscribers are isolated and logged here.
   */
  private notify(applied: AppliedPatch): void {
    for (const listener of this.listeners) {
      try {
        listener(applied);
      } catch (error) {
        console.error('[pitolet] patch subscriber failed:', error);
      }
    }
  }

  private validatePatchEnvelope(ops: PatchOp[], rev: number): void {
    if (ops.length === 0) {
      throw new PatchRejectedError(
        'patch must contain at least one operation',
        'invalid_patch',
        rev,
      );
    }
    if (ops.length > MAX_PATCH_OPS) {
      throw new PatchRejectedError(
        `patch has ${ops.length} operations; maximum is ${MAX_PATCH_OPS}`,
        'invalid_patch',
        rev,
      );
    }
    for (const op of ops) {
      if (op.path.length === 0 || op.path.length > MAX_PATCH_PATH_DEPTH) {
        throw new PatchRejectedError(
          `patch path depth must be between 1 and ${MAX_PATCH_PATH_DEPTH}`,
          'invalid_patch',
          rev,
        );
      }
      if (
        op.path.some(
          (segment) =>
            segment === '__proto__' || segment === 'prototype' || segment === 'constructor',
        )
      ) {
        throw new PatchRejectedError(
          'patch path contains a forbidden prototype segment',
          'invalid_patch',
          rev,
        );
      }
      if (!['add', 'replace', 'remove'].includes(op.op)) {
        throw new PatchRejectedError(`unsupported patch operation ${String(op.op)}`);
      }
      if (
        op.value !== undefined &&
        !isJsonWithinLimits(op.value, MAX_PATCH_VALUE_DEPTH, MAX_PATCH_VALUE_ENTRIES)
      ) {
        throw new PatchRejectedError(
          `patch value is too deeply nested or complex`,
          'invalid_patch',
          rev,
        );
      }
    }
  }

  /** Validate touched values, then run shared structure checks when relevant. */
  private validate(doc: PitoletDocument, ops: PatchOp[]): void {
    const touchedNodes = new Set<string>();
    const touchedComments = new Set<string>();
    const touchedAssets = new Set<string>();
    let structural = false;
    let fullValidation = false;
    let checkTokens = false;
    let checkComponents = false;
    let checkBreakpoints = false;

    for (const op of ops) {
      const [head, key] = op.path;
      if (op.path.length === 1) fullValidation = true;
      if (
        op.path.length > 1 &&
        (head === 'nodes' || head === 'comments' || head === 'components' || head === 'assets') &&
        typeof key !== 'string'
      ) {
        throw new PatchRejectedError(`patch key for ${head} must be a string`, 'invalid_patch');
      }
      switch (head) {
        case 'comments':
          if (typeof key === 'string') touchedComments.add(key);
          structural = true;
          break;
        case 'nodes':
          if (typeof key === 'string') touchedNodes.add(key);
          if (
            op.path.length <= 2 ||
            [
              'id',
              'type',
              'tag',
              'parent',
              'children',
              'src',
              'componentId',
              'variant',
              'overrides',
              'isComponentMaster',
            ].includes(String(op.path[2])) ||
            (op.path[2] === 'styles' && op.path[3] === 'breakpoints')
          ) {
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
          structural = true;
          break;
        case 'name':
          break;
        case 'assets':
          if (typeof key === 'string') touchedAssets.add(key);
          structural = true;
          break;
        default:
          throw new PatchRejectedError(`patch touches forbidden path ${String(head)}`);
      }
    }

    try {
      if (fullValidation) {
        validateDocument(doc);
      } else {
        for (const nodeId of touchedNodes) {
          const node = doc.nodes[nodeId];
          if (node !== undefined) validateNode(node);
        }
        for (const commentId of touchedComments) {
          const comment = doc.comments?.[commentId];
          if (comment !== undefined) zComment.parse(comment);
        }
        for (const assetId of touchedAssets) {
          const asset = doc.assets[assetId];
          if (asset !== undefined) zAsset.parse(asset);
        }
        if (checkTokens) zTokenSet.parse(doc.tokens);
        if (checkBreakpoints) doc.breakpoints.forEach((bp) => zBreakpoint.parse(bp));
        if (checkComponents) {
          Object.values(doc.components).forEach((c) => zComponentDef.parse(c));
        }
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
    try {
      assertDocumentSize(doc);
    } catch (error) {
      throw new PatchRejectedError(
        error instanceof Error ? error.message : 'document exceeds the storage limit',
        'invalid_patch',
      );
    }
  }
}

function normalizePatchLabel(label: string): string {
  const normalized = label.trim() || 'Edit';
  if (normalized.length <= MAX_PATCH_LABEL_LENGTH) return normalized;

  let prefix = normalized.slice(0, MAX_PATCH_LABEL_LENGTH - 1);
  const lastCodeUnit = prefix.charCodeAt(prefix.length - 1);
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) {
    prefix = prefix.slice(0, -1);
  }
  return `${prefix}…`;
}

function assertDocumentSize(doc: PitoletDocument): void {
  const bytes = Buffer.byteLength(JSON.stringify(doc));
  if (bytes > MAX_DOCUMENT_BYTES) {
    throw new Error(
      `document is ${bytes} bytes; maximum serialized size is ${MAX_DOCUMENT_BYTES} bytes`,
    );
  }
}
