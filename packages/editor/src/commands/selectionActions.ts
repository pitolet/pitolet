import { isAncestor, type NodeId, type PitoletDocument } from '@pitolet/schema';
import { effectiveNodeVisibility } from '../store/componentMutations.js';
import type { EditingVariant } from '../store/index.js';
import { isEffectivelyLocked } from '../store/locks.js';

export interface SelectionActionState {
  hasSelection: boolean;
  editable: boolean;
  containsComponentMaster: boolean;
  containsComponentContentRoot: boolean;
  canDuplicate: boolean;
  canDelete: boolean;
  canGroup: boolean;
  allLocked: boolean;
  allHidden: boolean;
}

/**
 * Shared availability for selection actions shown in the selection bar and
 * command palette. Keeping it here prevents an action from looking available
 * when its mutation would be rejected or do nothing.
 */
export function getSelectionActionState(
  doc: Pick<PitoletDocument, 'nodes' | 'components'> | null,
  selection: NodeId[],
  editingVariant: EditingVariant | null = null,
): SelectionActionState {
  if (!doc || selection.length === 0) return emptyState();

  const nodes = selection.map((id) => doc.nodes[id]).filter((node) => node !== undefined);
  const hasSelection = nodes.length === selection.length;
  if (!hasSelection) return emptyState();

  const containsComponentMaster = nodes.some(
    (node) => node.type === 'frame' && Boolean(node.isComponentMaster),
  );
  const containsComponentContentRoot = Object.values(doc.components).some((component) =>
    selection.some(
      (id) => id === component.contentRootId || isAncestor(doc.nodes, id, component.contentRootId),
    ),
  );
  const unlocked = selection.every((id) => !isEffectivelyLocked(doc, id));
  const canDuplicate = unlocked && !containsComponentMaster;
  const canDelete = canDuplicate && !containsComponentContentRoot;
  const editable = canDuplicate;
  const parentId = nodes[0]?.parent ?? null;
  const canGroup =
    editable &&
    nodes.length > 1 &&
    parentId !== null &&
    nodes.every((node) => node.parent === parentId);

  return {
    hasSelection: true,
    editable,
    containsComponentMaster,
    containsComponentContentRoot,
    canDuplicate,
    canDelete,
    canGroup,
    allLocked: nodes.every((node) => node.locked),
    allHidden: nodes.every((node) => !effectiveNodeVisibility(doc, node.id, editingVariant)),
  };
}

function emptyState(): SelectionActionState {
  return {
    hasSelection: false,
    editable: false,
    containsComponentMaster: false,
    containsComponentContentRoot: false,
    canDuplicate: false,
    canDelete: false,
    canGroup: false,
    allLocked: false,
    allHidden: false,
  };
}
