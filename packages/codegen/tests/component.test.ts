import {
  attach,
  createDocument,
  createElement,
  createFrame,
  createImage,
  createInstance,
  createText,
  px,
  sides,
  type ComponentDef,
} from '@pitolet/schema';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { generateComponent, generateProject, generateSelection } from '../src/index.js';

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
    contentRootId: button.id,
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
    expect(code).toContain(`intent?: "primary" | "ghost"`);
    expect(code).toContain(`children?: React.ReactNode`);
    expect(code).toContain(`intent = "primary"`);
    // Variant map on the button element with both merged class strings.
    expect(code).toContain('"intent=primary":');
    expect(code).toContain('"intent=ghost":');
    expect(code).toContain('bg-primary');
    expect(code).toContain('border-border');
    expect(code).toContain('children ?? overrides?.[');
    expect(code).toContain('?.content ?? "Button"');
    expect(syntaxDiagnostics(code)).toEqual([]);
  });

  it('composes single-property and compound variants across every declared prop', () => {
    const { doc, def, button, label } = buttonComponentDoc();
    def.variantProps.push({ name: 'size', values: ['sm', 'lg'], default: 'sm' });
    def.variants['size=lg'] = {
      [button.id]: { styles: { padding: sides(px(32)) } },
    };
    def.variants['intent=ghost,size=lg'] = {
      [label.id]: { visible: false },
    };
    button.styles.breakpoints = { md: { opacity: 0.8 } };
    button.styles.states = { hover: { opacity: 0.7 } };

    const code = generateComponent(doc, def);
    expect(code).toContain(`size?: "sm" | "lg"`);
    expect(code).toContain('"intent=" + intent');
    expect(code).toContain('"size=" + size');
    expect(code).toContain('"intent=ghost,size=lg"');
    expect(code).toContain('p-8');
    expect(code).toContain('md:opacity-80');
    expect(code).toContain('hover:opacity-70');
    expect(code).toContain('[variantKey]');
    expect(syntaxDiagnostics(code)).toEqual([]);
  });

  it('call sites emit variant props and children overrides', () => {
    const { doc, def, button, label } = buttonComponentDoc();
    def.variantProps.push({ name: 'size', values: ['sm', 'lg'], default: 'sm' });
    const icon = attach(
      doc,
      button.id,
      createImage({ name: 'Icon', src: { url: '/icon.svg' }, alt: '' }),
    );
    const frame = attach(
      doc,
      null,
      createFrame({ name: 'Page', styles: { padding: sides(px(32)) } }),
    );
    const instance = createInstance({
      componentId: def.id,
      name: 'CTA',
      variant: { intent: 'ghost', size: 'lg' },
    });
    instance.overrides[label.id] = { content: [{ text: 'Learn more' }] };
    instance.overrides[icon.id] = {
      src: { url: '/arrow.svg' },
      styles: { opacity: 0.5 },
      visible: false,
    };
    instance.styles.base.margin = sides(px(16));
    attach(doc, frame.id, instance);

    const code = generateSelection(doc, frame.id, 'react-tailwind');
    expect(code).toContain(`import { Button } from '../components/Button';`);
    expect(code).toContain('<Button intent="ghost" size="lg"');
    expect(code).toContain('className="m-4"');
    expect(code).toContain(
      `"${icon.id}": { src: "/arrow.svg", className: "opacity-50", visible: false }`,
    );
    expect(code).toContain('>Learn more</Button>');
  });

  it('default-variant instances omit the prop', () => {
    const { doc, def } = buttonComponentDoc();
    const frame = attach(doc, null, createFrame({ name: 'Page2' }));
    attach(doc, frame.id, createInstance({ componentId: def.id, variant: { intent: 'primary' } }));
    const code = generateSelection(doc, frame.id, 'react-tailwind');
    expect(code).toContain('<Button />');
  });

  it('avoids naming a selection wrapper after its imported component', () => {
    const { doc, def } = buttonComponentDoc();
    const frame = attach(doc, null, createFrame({ name: 'Page' }));
    const instance = attach(doc, frame.id, createInstance({ componentId: def.id, name: 'Button' }));

    const code = generateSelection(doc, instance.id, 'react-tailwind');
    expect(code).toContain(`import { Button } from '../components/Button';`);
    expect(code).toContain('export function ButtonSelection()');
    expect(code).not.toContain('export function Button()');
    expect(code).toContain('<Button />');
    expect(syntaxDiagnostics(code)).toEqual([]);
  });

  it('keeps allocating when the selection fallback also names an import', () => {
    const { doc, def } = buttonComponentDoc();
    const secondMaster = attach(
      doc,
      null,
      createFrame({ name: 'Button selection master', width: 320, height: 'auto' }),
    );
    const secondRoot = attach(
      doc,
      secondMaster.id,
      createElement({ name: 'Button selection root', tag: 'div' }),
    );
    if (secondMaster.type !== 'frame') throw new Error('expected frame');
    secondMaster.isComponentMaster = 'comp2';
    doc.components.comp2 = {
      id: 'comp2',
      name: 'ButtonSelection',
      rootId: secondMaster.id,
      contentRootId: secondRoot.id,
      variantProps: [],
      variants: {},
    };
    const frame = attach(doc, null, createFrame({ name: 'Button' }));
    attach(doc, frame.id, createInstance({ componentId: def.id }));
    attach(doc, frame.id, createInstance({ componentId: 'comp2' }));

    const code = generateSelection(doc, frame.id, 'react-tailwind');
    expect(code).toContain(`import { Button } from '../components/Button';`);
    expect(code).toContain(`import { ButtonSelection } from '../components/ButtonSelection';`);
    expect(code).toContain('export function ButtonSelection2()');
    expect(syntaxDiagnostics(code)).toEqual([]);
  });

  it('keeps generated frame filenames and exported function names aligned', () => {
    const { doc, def } = buttonComponentDoc();
    for (let index = 0; index < 2; index += 1) {
      const frame = attach(doc, null, createFrame({ name: 'Button' }));
      attach(doc, frame.id, createInstance({ componentId: def.id }));
    }

    const frames = generateProject(doc).filter((file) => file.path.startsWith('frames/'));
    expect(frames.map((file) => file.path)).toEqual(['frames/Button2.tsx', 'frames/Button3.tsx']);
    expect(frames[0]!.contents).toContain('export function Button2()');
    expect(frames[1]!.contents).toContain('export function Button3()');
    for (const file of frames) {
      expect(file.contents).toContain(`import { Button } from '../components/Button';`);
      expect(syntaxDiagnostics(file.contents)).toEqual([]);
    }
  });

  it('emits a structured image alt exactly once', () => {
    const { doc, def, button } = buttonComponentDoc();
    const image = attach(
      doc,
      button.id,
      createImage({ name: 'Logo', src: { url: '/logo.svg' }, alt: 'Pitolet' }),
    );
    image.attrs = { alt: 'Pitolet' };
    const frame = attach(doc, null, createFrame({ name: 'Images' }));
    attach(doc, frame.id, createImage({ src: { url: '/photo.png' }, alt: 'Photo' }));
    const direct = doc.nodes[frame.children[0]!]!;
    direct.attrs = { alt: 'Photo' };

    const jsx = generateSelection(doc, frame.id, 'react-tailwind');
    expect(jsx.match(/alt=/g)).toHaveLength(1);
    const html = generateSelection(doc, frame.id, 'html');
    expect(html.match(/alt=/g)).toHaveLength(1);
    const component = generateComponent(doc, def);
    expect(component.match(/alt=/g)).toHaveLength(1);
  });

  it('flattens only the explicit content root in HTML and keeps instance root styles', () => {
    const { doc, def } = buttonComponentDoc();
    const frame = attach(doc, null, createFrame({ name: 'HTML page' }));
    const instance = createInstance({ componentId: def.id });
    instance.styles.base.margin = sides(px(16));
    attach(doc, frame.id, instance);

    const code = generateSelection(doc, frame.id, 'html');
    expect(code).toContain('<button class="button-root"');
    expect(code).not.toContain('class="button"');
    expect(code).toContain('margin-top: 16px');
  });

  it('uses top-level master canvas dimensions when the frame is the content root', () => {
    const doc = createDocument({ name: 'Frame component' });
    const page = attach(doc, null, createFrame({ name: 'Page' }));
    const master = attach(doc, null, createFrame({ name: 'Panel', width: 640, height: 360 }));
    if (master.type !== 'frame') throw new Error('expected frame');
    master.isComponentMaster = 'panel';
    doc.components.panel = {
      id: 'panel',
      name: 'Panel',
      rootId: master.id,
      contentRootId: master.id,
      variantProps: [],
      variants: {},
    };
    attach(doc, page.id, createInstance({ componentId: 'panel' }));

    const html = generateSelection(doc, page.id, 'html');
    expect(html).toContain('width: 640px');
    expect(html).toContain('height: 360px');
    const component = generateComponent(doc, doc.components.panel);
    expect(component).toContain('w-[640px]');
    expect(component).toContain('h-[360px]');
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

function syntaxDiagnostics(code: string): string[] {
  return (
    ts
      .transpileModule(code, {
        compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
        reportDiagnostics: true,
      })
      .diagnostics?.map((diagnostic) =>
        ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
      ) ?? []
  );
}
