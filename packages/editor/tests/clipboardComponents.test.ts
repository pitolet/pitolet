import {
  attach,
  createDocument,
  createElement,
  createFrame,
  createInstance,
  type ComponentDef,
} from '@pitolet/schema';
import { describe, expect, it } from 'vitest';
import { canPasteSubtree, validateClipPayload } from '../src/commands/clipboard.js';

function fixture() {
  const doc = createDocument({ name: 'Clipboard' });
  const page = attach(doc, null, createFrame({ name: 'Page' }));
  const master = attach(doc, null, createFrame({ name: 'Card master' }));
  const root = attach(doc, master.id, createElement({ name: 'Card' }));
  const def: ComponentDef = {
    id: 'card',
    name: 'Card',
    rootId: master.id,
    contentRootId: root.id,
    variantProps: [],
    variants: {},
  };
  if (master.type !== 'frame') throw new Error('expected frame');
  master.isComponentMaster = def.id;
  doc.components[def.id] = def;
  return { doc, page, master };
}

describe('component clipboard boundaries', () => {
  it('allows a local instance on the page but not inside another component master', () => {
    const { doc, page, master } = fixture();
    const instance = createInstance({ componentId: 'card' });
    const nodes = { [instance.id]: instance };
    expect(canPasteSubtree(doc, nodes, instance.id, page.id)).toBe(true);
    expect(canPasteSubtree(doc, nodes, instance.id, master.id)).toBe(false);
  });

  it('rejects foreign instances and copied component masters', () => {
    const { doc, page, master } = fixture();
    const foreign = createInstance({ componentId: 'foreign' });
    expect(canPasteSubtree(doc, { [foreign.id]: foreign }, foreign.id, page.id)).toBe(false);
    expect(canPasteSubtree(doc, { [master.id]: master }, master.id, null)).toBe(false);
  });

  it('rejects void parents, cycles, and inconsistent clipboard graphs', () => {
    const { doc, page } = fixture();
    const input = createElement({ tag: 'input' });
    const child = createElement();
    input.children = [child.id];
    child.parent = input.id;
    expect(
      validateClipPayload({
        roots: [input.id],
        nodes: { [input.id]: input, [child.id]: child },
      }),
    ).toBeNull();
    expect(canPasteSubtree(doc, { [child.id]: child }, child.id, input.id)).toBe(false);

    const a = createElement();
    const b = createElement();
    a.children = [b.id];
    a.parent = b.id;
    b.children = [a.id];
    b.parent = a.id;
    expect(validateClipPayload({ roots: [a.id], nodes: { [a.id]: a, [b.id]: b } })).toBeNull();

    expect(validateClipPayload({ roots: [child.id], nodes: { [child.id]: child } })).not.toBeNull();
    expect(canPasteSubtree(doc, { [child.id]: child }, child.id, page.id)).toBe(true);
  });
});
