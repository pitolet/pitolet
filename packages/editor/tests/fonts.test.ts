import {
  attach,
  createDocument,
  createFrame,
  createInstance,
  type ComponentDef,
} from '@pitolet/schema';
import { describe, expect, it } from 'vitest';
import { documentFonts } from '../src/fonts/googleFonts.js';

describe('document font discovery', () => {
  it('finds fonts in responsive, state, variant, and instance override layers', () => {
    const doc = createDocument({ name: 'Fonts' });
    const page = attach(doc, null, createFrame({ name: 'Page' }));
    const master = attach(doc, null, createFrame({ styles: { fontFamily: 'Base Face' } }));
    master.styles.breakpoints = { md: { fontFamily: 'Tablet Face' } };
    master.styles.states = { hover: { fontFamily: 'Hover Face' } };
    const component: ComponentDef = {
      id: 'font-card',
      name: 'Font card',
      rootId: master.id,
      contentRootId: master.id,
      variantProps: [],
      variants: { emphasized: { [master.id]: { styles: { fontFamily: 'Variant Face' } } } },
    };
    if (master.type !== 'frame') throw new Error('expected frame');
    master.isComponentMaster = component.id;
    doc.components[component.id] = component;
    const instance = attach(doc, page.id, createInstance({ componentId: component.id }));
    if (instance.type !== 'instance') throw new Error('expected instance');
    instance.overrides[master.id] = { styles: { fontFamily: 'Override Face' } };

    expect(documentFonts(doc)).toEqual(
      expect.arrayContaining([
        'Base Face',
        'Tablet Face',
        'Hover Face',
        'Variant Face',
        'Override Face',
      ]),
    );
  });
});
