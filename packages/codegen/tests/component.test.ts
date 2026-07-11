import {
  attach,
  createDocument,
  createElement,
  createFrame,
  createInstance,
  createText,
  px,
  sides,
  type ComponentDef,
} from '@pitolet/schema';
import { describe, expect, it } from 'vitest';
import { generateComponent, generateSelection } from '../src/index.js';

function buttonComponentDoc() {
  const doc = createDocument({ name: 'Kit' });

  // Master: a frame wrapping one button element with one text node.
  const master = attach(doc, null, createFrame({ name: 'Button', width: 320, height: 'auto' }));
  const button = attach(
    doc,
    master.id,
    createElement({
      name: 'Button root',
      tag: 'button',
      styles: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: { top: px(12), right: px(24), bottom: px(12), left: px(24) },
        fills: [{ type: 'solid', color: { $token: 'color.primary' } }],
        color: { $token: 'color.primary-foreground' },
        radius: {
          tl: { $token: 'radius.md' },
          tr: { $token: 'radius.md' },
          br: { $token: 'radius.md' },
          bl: { $token: 'radius.md' },
        },
      },
    }),
  );
  const label = attach(doc, button.id, createText({ name: 'Label', tag: 'span', text: 'Button' }));

  const def: ComponentDef = {
    id: 'comp1',
    name: 'Button',
    rootId: master.id,
    variantProps: [{ name: 'intent', values: ['primary', 'ghost'], default: 'primary' }],
    variants: {
      'intent=ghost': {
        [button.id]: {
          styles: {
            fills: [],
            color: { $token: 'color.foreground' },
            border: { width: px(1), style: 'solid', color: { $token: 'color.border' } },
          },
        },
      },
    },
  };
  if (master.type === 'frame') master.isComponentMaster = def.id;
  doc.components[def.id] = def;
  return { doc, def, master, button, label };
}

describe('component codegen', () => {
  it('emits a typed component with per-variant class maps and children', () => {
    const { doc, def } = buttonComponentDoc();
    const code = generateComponent(doc, def);
    expect(code).toContain(`export interface ButtonProps`);
    expect(code).toContain(`intent?: 'primary' | 'ghost'`);
    expect(code).toContain(`children?: React.ReactNode`);
    expect(code).toContain(`intent = 'primary'`);
    // Variant map on the button element with both merged class strings.
    expect(code).toContain('"primary":');
    expect(code).toContain('"ghost":');
    expect(code).toContain('bg-primary');
    expect(code).toContain('border-border');
    expect(code).toContain('{children ?? "Button"}');
  });

  it('call sites emit variant props and children overrides', () => {
    const { doc, def, label } = buttonComponentDoc();
    const frame = attach(doc, null, createFrame({ name: 'Page', styles: { padding: sides(px(32)) } }));
    const instance = createInstance({ componentId: def.id, name: 'CTA', variant: { intent: 'ghost' } });
    instance.overrides[label.id] = { content: [{ text: 'Learn more' }] };
    attach(doc, frame.id, instance);

    const code = generateSelection(doc, frame.id, 'react-tailwind');
    expect(code).toContain(`import { Button } from '../components/Button';`);
    expect(code).toContain('<Button intent="ghost">Learn more</Button>');
  });

  it('default-variant instances omit the prop', () => {
    const { doc, def } = buttonComponentDoc();
    const frame = attach(doc, null, createFrame({ name: 'Page2' }));
    attach(doc, frame.id, createInstance({ componentId: def.id, variant: { intent: 'primary' } }));
    const code = generateSelection(doc, frame.id, 'react-tailwind');
    expect(code).toContain('<Button />');
  });

  it('annotate mode adds a header comment and data-ptl-id attributes', () => {
    const { doc } = buttonComponentDoc();
    const frame = attach(doc, null, createFrame({ name: 'Home' }));
    attach(doc, frame.id, createText({ tag: 'h1', text: 'Hi' }));
    const code = generateSelection(doc, frame.id, 'react-tailwind', { annotate: true });
    expect(code).toContain(`// @pitolet doc=${doc.id} frame=${frame.id}`);
    expect(code).toContain(`data-ptl-id="${frame.id}"`);
    // Off by default (golden files unaffected).
    const plain = generateSelection(doc, frame.id, 'react-tailwind');
    expect(plain).not.toContain('data-ptl-id');
    expect(plain).not.toContain('@pitolet');
  });
});
