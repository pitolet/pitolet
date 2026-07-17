import {
  attach,
  createDocument,
  createElement,
  createFrame,
  createInstance,
  createText,
  type ComponentDef,
} from '@pitolet/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  effectiveInspectorNode,
  effectiveInspectorStyleSheet,
  setStyle,
} from '../src/inspector/useStyle.js';
import { history, setPatchSender, useEditor } from '../src/store/index.js';

function componentFixture() {
  const doc = createDocument({ name: 'Instance overrides' });
  const page = attach(doc, null, createFrame({ name: 'Page' }));
  const master = attach(doc, null, createFrame({ name: 'Button master' }));
  const button = attach(
    doc,
    master.id,
    createElement({ name: 'Button root', tag: 'button', styles: { opacity: 0.9 } }),
  );
  const label = attach(
    doc,
    button.id,
    createText({ name: 'Label', text: 'Buy', styles: { opacity: 0.8 } }),
  );
  const component: ComponentDef = {
    id: 'button',
    name: 'Button',
    rootId: master.id,
    contentRootId: button.id,
    variantProps: [{ name: 'tone', values: ['plain', 'strong'], default: 'plain' }],
    variants: {
      'tone=strong': {
        [button.id]: { styles: { opacity: 0.7 } },
        [label.id]: { styles: { opacity: 0.6 } },
      },
    },
  };
  if (master.type !== 'frame') throw new Error('expected frame');
  master.isComponentMaster = component.id;
  doc.components[component.id] = component;

  const instance = createInstance({ componentId: component.id, variant: { tone: 'strong' } });
  instance.styles.base.opacity = 0.5;
  instance.overrides[label.id] = { styles: { opacity: 0.4 } };
  attach(doc, page.id, instance);
  return { doc, page, master, button, label, instance };
}

describe('instance inspector overrides', () => {
  beforeEach(() => {
    history.clear();
    setPatchSender(() => {});
  });

  it('reads component, compound variant, and instance root styles in cascade order', () => {
    const { doc, button, instance } = componentFixture();
    expect(effectiveInspectorNode(doc, instance.id, null)?.id).toBe(button.id);
    expect(effectiveInspectorStyleSheet(doc, instance.id, null)?.base.opacity).toBe(0.5);
  });

  it('reads and writes an inner layer override without changing the main component', () => {
    const { doc, label, instance } = componentFixture();
    useEditor.getState().setDocument(doc, 0);
    useEditor.getState().setConnected(true);
    useEditor.getState().select([instance.id]);
    useEditor.getState().setEditingInstanceOverride(instance.id, label.id);

    expect(
      effectiveInspectorStyleSheet(doc, instance.id, {
        instanceId: instance.id,
        nodeId: label.id,
      })?.base.opacity,
    ).toBe(0.4);

    setStyle('Change inner opacity', (styles) => {
      styles.opacity = 0.25;
    });
    const next = useEditor.getState().doc!;
    expect(next.nodes[label.id]!.styles.base.opacity).toBe(0.8);
    expect(next.nodes[instance.id]).toMatchObject({
      type: 'instance',
      overrides: { [label.id]: { styles: { opacity: 0.25 } } },
    });
  });

  it('writes root, breakpoint, and interaction styles onto the instance', () => {
    const { doc, instance } = componentFixture();
    const store = useEditor.getState();
    store.setDocument(doc, 0);
    store.setConnected(true);
    store.select([instance.id]);

    setStyle('Root opacity', (styles) => {
      styles.opacity = 0.45;
    });
    store.setEditingContext({ breakpointId: 'md', state: null });
    setStyle('Tablet opacity', (styles) => {
      styles.opacity = 0.35;
    });
    store.setEditingContext({ breakpointId: null, state: 'hover' });
    setStyle('Hover opacity', (styles) => {
      styles.opacity = 0.3;
    });

    const node = useEditor.getState().doc!.nodes[instance.id];
    expect(node).toMatchObject({
      type: 'instance',
      styles: {
        base: { opacity: 0.45 },
        breakpoints: { md: { opacity: 0.35 } },
        states: { hover: { opacity: 0.3 } },
      },
    });
  });

  it('removes empty inner override records and exits flat override modes for contextual edits', () => {
    const { doc, label, instance } = componentFixture();
    const store = useEditor.getState();
    store.setDocument(doc, 0);
    store.setConnected(true);
    store.select([instance.id]);
    store.setEditingInstanceOverride(instance.id, label.id);

    setStyle('Reset inner opacity', (styles) => {
      delete styles.opacity;
    });
    expect(
      (useEditor.getState().doc!.nodes[instance.id] as typeof instance).overrides[label.id],
    ).toBeUndefined();

    store.setEditingInstanceOverride(instance.id, label.id);
    store.setEditingContext({ breakpointId: 'md', state: null });
    expect(store.editingInstanceOverride).toBeNull();

    store.setEditingVariant('button', 'tone=strong');
    store.setEditingContext({ breakpointId: null, state: 'hover' });
    expect(store.editingVariant).toBeNull();
  });
});
