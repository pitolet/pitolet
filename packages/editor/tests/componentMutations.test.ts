import {
  attach,
  createDocument,
  createElement,
  createFrame,
  createText,
  structuralProblems,
} from '@pitolet/schema';
import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import {
  addVariantProperty,
  addVariantValue,
  canDefineComponent,
  canInsertInstance,
  componentInsertionTarget,
  componentMasterIdForNode,
  defineComponent,
  deleteComponent,
  deleteVariantProperty,
  detachInstance,
  duplicateComponent,
  effectiveNodeVisibility,
  insertInstance,
  removeVariantValue,
  renameComponent,
  renameVariantProperty,
  renameVariantValue,
  setNodeVisibility,
} from '../src/store/componentMutations.js';
import { deleteNodes, duplicateNodes } from '../src/store/mutations.js';
import { componentInstanceStats } from '../src/panels/ComponentsPanel.js';

function pageFixture() {
  const doc = createDocument({ name: 'Components' });
  const page = attach(doc, null, createFrame({ name: 'Page', width: 1200, height: 800 }));
  const box = attach(doc, page.id, createElement({ name: 'Content' }));
  const label = attach(doc, box.id, createText({ name: 'Label', text: 'Button' }));
  return { doc, page, box, label };
}

describe('component mutations', () => {
  it('counts component instances and inherited locks in one tree traversal', () => {
    const { doc, page } = pageFixture();
    const lockedGroup = attach(doc, page.id, createElement({ name: 'Locked' }));
    lockedGroup.locked = true;
    const master = attach(doc, null, createFrame({ name: 'Badge', width: 160, height: 48 }));
    const next = produce(doc, (draft) => {
      defineComponent(draft, master.id);
      const componentId = Object.keys(draft.components)[0]!;
      insertInstance(draft, componentId, page.id);
      insertInstance(draft, componentId, lockedGroup.id);
    });
    const componentId = Object.keys(next.components)[0]!;

    const stats = componentInstanceStats(next);
    expect(stats.instanceCounts.get(componentId)).toBe(2);
    expect(stats.lockedInstanceCounts.get(componentId)).toBe(1);
  });

  it('creates a component from ordinary content and replaces it with an instance', () => {
    const { doc, box, label } = pageFixture();
    let instanceId: string | null = null;
    const next = produce(doc, (draft) => {
      instanceId = defineComponent(draft, label.id);
    });

    expect(instanceId).not.toBeNull();
    const instance = next.nodes[instanceId!];
    expect(instance?.type).toBe('instance');
    const component = Object.values(next.components)[0];
    expect(component?.name).toBe('Label');
    expect(component?.contentRootId).toBe(label.id);
    expect(next.nodes[component!.rootId]).toMatchObject({
      type: 'frame',
      isComponentMaster: component!.id,
      canvas: { x: 1320, y: 0, width: 480, height: 'auto' },
    });
    expect(next.nodes[box.id]!.children).toContain(instanceId!);
    expect(componentMasterIdForNode(next, label.id)).toBe(component!.id);
  });

  it('places masters beside long auto-height pages without guessing their height', () => {
    const doc = createDocument({ name: 'Long page' });
    const page = attach(
      doc,
      null,
      createFrame({ name: 'Long page', x: 200, y: 140, width: 1440, height: 'auto' }),
    );
    const card = attach(doc, page.id, createElement({ name: 'Card' }));

    const next = produce(doc, (draft) => {
      defineComponent(draft, card.id);
    });
    const component = Object.values(next.components)[0]!;
    const master = next.nodes[component.rootId];
    expect(master?.type).toBe('frame');
    if (master?.type !== 'frame') return;
    expect(master.canvas).toEqual({ x: 1760, y: 140, width: 480, height: 'auto' });
  });

  it('uses an explicit content root even when a top-level master has one child', () => {
    const doc = createDocument({ name: 'Top-level component' });
    const frame = attach(doc, null, createFrame({ name: 'Card' }));
    attach(doc, frame.id, createText({ name: 'Only child', text: 'Card' }));
    const next = produce(doc, (draft) => {
      expect(defineComponent(draft, frame.id)).toBeNull();
    });
    const component = Object.values(next.components)[0]!;
    expect(component.rootId).toBe(frame.id);
    expect(component.contentRootId).toBe(frame.id);
  });

  it('detaches frame-based component instances without copying master ownership', () => {
    const doc = createDocument({ name: 'Frame component' });
    const page = attach(doc, null, createFrame({ name: 'Page' }));
    const master = attach(doc, null, createFrame({ name: 'Panel', width: 640, height: 360 }));
    const withComponent = produce(doc, (draft) => {
      defineComponent(draft, master.id);
      const componentId = Object.keys(draft.components)[0]!;
      const instanceId = insertInstance(draft, componentId, page.id)!;
      const detachedId = detachInstance(draft, instanceId)!;
      const detached = draft.nodes[detachedId];
      expect(detached?.type).toBe('frame');
      if (detached?.type === 'frame') expect(detached.isComponentMaster).toBeUndefined();
    });
    expect(structuralProblems(withComponent)).toEqual([]);
  });

  it('rejects component creation for instances, masters, and content inside a master', () => {
    const { doc, page, label } = pageFixture();
    const master = attach(doc, null, createFrame({ name: 'Button', width: 240, height: 80 }));
    const masterChild = attach(doc, master.id, createText({ name: 'Button label', text: 'Buy' }));
    let componentId = '';
    const withComponent = produce(doc, (draft) => {
      defineComponent(draft, master.id);
      const masterNode = draft.nodes[master.id];
      componentId = masterNode?.type === 'frame' ? (masterNode.isComponentMaster ?? '') : '';
    });
    let instanceId: string | null = null;
    const withInstance = produce(withComponent, (draft) => {
      instanceId = insertInstance(draft, componentId, page.id);
    });

    expect(canDefineComponent(withInstance, master.id)).toBe(false);
    expect(canDefineComponent(withInstance, masterChild.id)).toBe(false);
    expect(canDefineComponent(withInstance, instanceId!)).toBe(false);
    expect(canDefineComponent(withInstance, label.id)).toBe(true);

    const unchanged = produce(withInstance, (draft) => {
      expect(defineComponent(draft, masterChild.id)).toBeNull();
      expect(defineComponent(draft, instanceId!)).toBeNull();
    });
    expect(Object.keys(unchanged.components)).toHaveLength(1);
  });

  it('resolves an unambiguous page insertion target and excludes masters', () => {
    const { doc, page, box, label } = pageFixture();
    const master = attach(doc, null, createFrame({ name: 'Master', width: 240, height: 80 }));
    const masterChild = attach(doc, master.id, createText({ text: 'Master child' }));
    const next = produce(doc, (draft) => {
      defineComponent(draft, master.id);
    });

    expect(componentInsertionTarget(next, [])).toBe(page.id);
    expect(componentInsertionTarget(next, [box.id])).toBe(box.id);
    expect(componentInsertionTarget(next, [label.id])).toBe(box.id);
    expect(componentInsertionTarget(next, [box.id, label.id])).toBeNull();
    expect(componentInsertionTarget(next, [master.id])).toBeNull();
    expect(componentInsertionTarget(next, [masterChild.id])).toBeNull();
  });

  it('prevents instances from being inserted into component masters or void elements', () => {
    const { doc, page, box } = pageFixture();
    const master = attach(doc, null, createFrame({ name: 'Card', width: 240, height: 80 }));
    const input = attach(doc, page.id, createElement({ name: 'Input', tag: 'input' }));
    let componentId = '';
    const next = produce(doc, (draft) => {
      defineComponent(draft, master.id);
      const node = draft.nodes[master.id];
      componentId = node?.type === 'frame' ? (node.isComponentMaster ?? '') : '';
    });

    expect(canInsertInstance(next, componentId, box.id)).toBe(true);
    expect(canInsertInstance(next, componentId, master.id)).toBe(false);
    expect(canInsertInstance(next, componentId, input.id)).toBe(false);

    const inserted = produce(next, (draft) => {
      expect(insertInstance(draft, componentId, master.id)).toBeNull();
      expect(insertInstance(draft, componentId, input.id)).toBeNull();
      expect(insertInstance(draft, componentId, box.id)).not.toBeNull();
    });
    expect(Object.values(inserted.nodes).filter((node) => node.type === 'instance')).toHaveLength(
      1,
    );
  });

  it('does not delete or clone component master frames through generic layer actions', () => {
    const { doc } = pageFixture();
    const master = attach(doc, null, createFrame({ name: 'Badge', width: 160, height: 48 }));
    const withComponent = produce(doc, (draft) => {
      defineComponent(draft, master.id);
    });

    const afterDelete = produce(withComponent, (draft) => {
      deleteNodes(draft, [master.id]);
    });
    expect(afterDelete).toEqual(withComponent);

    const afterDuplicate = produce(withComponent, (draft) => {
      expect(duplicateNodes(draft, [master.id])).toEqual([]);
    });
    expect(afterDuplicate).toEqual(withComponent);
  });

  it('protects the explicit content root and prunes deleted-node variants and overrides', () => {
    const { doc, box, label } = pageFixture();
    const sibling = attach(doc, box.id, createText({ name: 'Optional', text: 'Optional' }));
    let componentId = '';
    let instanceId = '';
    const withComponent = produce(doc, (draft) => {
      defineComponent(draft, box.id);
      componentId = Object.keys(draft.components)[0]!;
      const instance = Object.values(draft.nodes).find((node) => node.type === 'instance');
      if (!instance || instance.type !== 'instance') throw new Error('expected instance');
      instanceId = instance.id;
      draft.components[componentId]!.variants['mode=compact'] = {
        [sibling.id]: { visible: false },
      };
      instance.overrides[sibling.id] = { content: [{ text: 'Changed' }] };
    });

    const contentRootId = withComponent.components[componentId]!.contentRootId;
    const protectedDoc = produce(withComponent, (draft) => {
      deleteNodes(draft, [contentRootId]);
    });
    expect(protectedDoc).toEqual(withComponent);

    const pruned = produce(withComponent, (draft) => {
      deleteNodes(draft, [sibling.id]);
    });
    expect(pruned.nodes[sibling.id]).toBeUndefined();
    expect(pruned.components[componentId]!.variants['mode=compact']).toBeUndefined();
    const prunedInstance = pruned.nodes[instanceId];
    expect(
      prunedInstance?.type === 'instance' ? prunedInstance.overrides[sibling.id] : 'missing',
    ).toBeUndefined();
    expect(pruned.nodes[label.id]).toBeDefined();
  });

  it('duplicates the complete master and remaps component-owned node ids', () => {
    const { doc, label } = pageFixture();
    let componentId = '';
    const withComponent = produce(doc, (draft) => {
      defineComponent(draft, label.id);
      componentId = Object.keys(draft.components)[0]!;
      draft.components[componentId]!.variantProps = [
        { name: 'tone', values: ['plain', 'strong'], default: 'plain' },
      ];
      draft.components[componentId]!.variants['tone=strong'] = {
        [label.id]: { visible: false },
      };
    });

    let duplicate: ReturnType<typeof duplicateComponent> = null;
    const next = produce(withComponent, (draft) => {
      duplicate = duplicateComponent(draft, componentId);
    });
    expect(duplicate).not.toBeNull();
    const source = next.components[componentId]!;
    const copy = next.components[duplicate!.componentId]!;
    expect(copy.name).toBe('Label copy');
    expect(copy.rootId).not.toBe(source.rootId);
    expect(copy.contentRootId).not.toBe(source.contentRootId);
    expect(copy.variants['tone=strong']?.[copy.contentRootId]).toEqual({ visible: false });
    expect(copy.variants['tone=strong']?.[source.contentRootId]).toBeUndefined();
    const sourceRoot = next.nodes[source.rootId];
    const copyRoot = next.nodes[copy.rootId];
    expect(sourceRoot?.type).toBe('frame');
    expect(copyRoot?.type).toBe('frame');
    if (sourceRoot?.type === 'frame' && copyRoot?.type === 'frame') {
      expect(copyRoot.canvas.x).toBe(sourceRoot.canvas.x + sourceRoot.canvas.width + 120);
      expect(copyRoot.canvas.y).toBe(sourceRoot.canvas.y);
    }
  });

  it('renames a component and safely detaches every instance before deletion', () => {
    const { doc, page, box, label } = pageFixture();
    let componentId = '';
    let secondInstance = '';
    const withInstances = produce(doc, (draft) => {
      defineComponent(draft, label.id);
      componentId = Object.keys(draft.components)[0]!;
      secondInstance = insertInstance(draft, componentId, box.id)!;
      expect(renameComponent(draft, componentId, 'Action label')).toBe(true);
    });
    expect(withInstances.components[componentId]!.name).toBe('Action label');
    expect(withInstances.nodes[secondInstance]!.name).toBe('Action label');

    let detachedCount: number | null = null;
    const deleted = produce(withInstances, (draft) => {
      detachedCount = deleteComponent(draft, componentId);
    });
    expect(detachedCount).toBe(2);
    expect(deleted.components[componentId]).toBeUndefined();
    expect(Object.values(deleted.nodes).some((node) => node.type === 'instance')).toBe(false);
    expect(deleted.nodes[page.id]!.children).toContain(box.id);
    expect(deleted.nodes[box.id]!.children).toHaveLength(2);
  });

  it('bakes compound variants, inner overrides, and root instance styles when detaching', () => {
    const { doc, label } = pageFixture();
    let detachedId: string | null = null;
    const detached = produce(doc, (draft) => {
      defineComponent(draft, label.id);
      const componentId = Object.keys(draft.components)[0]!;
      const component = draft.components[componentId]!;
      component.variantProps = [
        { name: 'size', values: ['sm', 'lg'], default: 'sm' },
        { name: 'tone', values: ['plain', 'strong'], default: 'plain' },
      ];
      component.variants['size=lg'] = { [label.id]: { styles: { opacity: 0.7 } } };
      component.variants['size=lg,tone=strong'] = { [label.id]: { visible: false } };
      const instance = Object.values(draft.nodes).find((node) => node.type === 'instance');
      if (!instance || instance.type !== 'instance') throw new Error('expected instance');
      instance.variant = { size: 'lg', tone: 'strong' };
      instance.styles.base.opacity = 0.4;
      instance.overrides[label.id] = { content: [{ text: 'Overridden' }] };
      draft.comments = {
        detach: {
          id: 'detach',
          nodeId: instance.id,
          text: 'Keep this note',
          author: 'you',
          createdAt: 1,
        },
      };
      detachedId = detachInstance(draft, instance.id);
    });

    expect(detachedId).not.toBeNull();
    expect(detached.nodes[detachedId!]).toMatchObject({
      type: 'text',
      visible: false,
      content: [{ text: 'Overridden' }],
      styles: { base: { opacity: 0.4 } },
    });
    expect(detached.comments?.detach?.nodeId).toBe(detachedId);
  });

  it('rewrites compound variants and instance values through the full variant lifecycle', () => {
    const { doc, label } = pageFixture();
    let componentId = '';
    let instanceId = '';
    const withVariants = produce(doc, (draft) => {
      defineComponent(draft, label.id);
      componentId = Object.keys(draft.components)[0]!;
      instanceId = Object.values(draft.nodes).find((node) => node.type === 'instance')!.id;
      expect(addVariantProperty(draft, componentId, 'tone', 'plain')).toBe(true);
      expect(addVariantValue(draft, componentId, 'tone', 'strong')).toBe(true);
      expect(addVariantProperty(draft, componentId, 'size', 'sm')).toBe(true);
      expect(addVariantValue(draft, componentId, 'size', 'lg')).toBe(true);
      draft.components[componentId]!.variants['size=lg,tone=strong'] = {
        [label.id]: { visible: false },
      };
      expect(renameVariantProperty(draft, componentId, 'tone', 'intent')).toBe(true);
      expect(renameVariantValue(draft, componentId, 'intent', 'strong', 'bold')).toBe(true);
      expect(removeVariantValue(draft, componentId, 'size', 'sm')).toBe(true);
    });

    expect(withVariants.nodes[instanceId]).toMatchObject({
      type: 'instance',
      variant: { intent: 'plain', size: 'lg' },
    });
    expect(withVariants.components[componentId]!.variants['intent=bold,size=lg']).toEqual({
      [label.id]: { visible: false },
    });

    const withoutIntent = produce(withVariants, (draft) => {
      expect(deleteVariantProperty(draft, componentId, 'intent')).toBe(true);
    });
    expect(withoutIntent.components[componentId]!.variants['size=lg']).toEqual({
      [label.id]: { visible: false },
    });
    expect(
      (withoutIntent.nodes[instanceId] as { variant: Record<string, string> }).variant.intent,
    ).toBeUndefined();
  });

  it('stores visibility in the active compound variant without changing base visibility', () => {
    const { doc, label } = pageFixture();
    let componentId = '';
    const componentDoc = produce(doc, (draft) => {
      defineComponent(draft, label.id);
      componentId = Object.keys(draft.components)[0]!;
      addVariantProperty(draft, componentId, 'tone', 'plain');
      addVariantValue(draft, componentId, 'tone', 'strong');
      setNodeVisibility(draft, label.id, false, { componentId, key: 'tone=strong' });
    });
    expect(componentDoc.nodes[label.id]!.visible).toBe(true);
    expect(effectiveNodeVisibility(componentDoc, label.id, null)).toBe(true);
    expect(
      effectiveNodeVisibility(componentDoc, label.id, {
        componentId,
        key: 'tone=strong',
      }),
    ).toBe(false);
  });

  it('rejects invalid code-style variant names and ambiguous selector values', () => {
    const { doc, label } = pageFixture();
    const next = produce(doc, (draft) => {
      defineComponent(draft, label.id);
      const componentId = Object.keys(draft.components)[0]!;
      expect(addVariantProperty(draft, componentId, 'button tone', 'plain')).toBe(false);
      expect(addVariantProperty(draft, componentId, 'tone', 'plain')).toBe(true);
      expect(addVariantValue(draft, componentId, 'tone', 'with,comma')).toBe(false);
      expect(addVariantValue(draft, componentId, 'tone', 'with=equals')).toBe(false);
    });
    expect(Object.values(next.components)[0]!.variantProps).toHaveLength(1);
  });
});
