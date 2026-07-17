import {
  attach,
  createDocument,
  createElement,
  createFrame,
  createImage,
  createInstance,
  createText,
  defaultTokens,
  px,
  type ComponentDef,
} from '@pitolet/schema';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import {
  generateComponent,
  generateProject,
  generateSelection,
  generateThemeCss,
} from '../src/index.js';

describe('safe deterministic code generation', () => {
  it('drops unsafe tags, attributes and navigation protocols', () => {
    const doc = createDocument({ name: 'Hostile values' });
    const frame = attach(doc, null, createFrame({ name: 'Page' }));
    const element = attach(doc, frame.id, createElement({ name: 'Unsafe' }));
    element.tag = 'div><script>alert(1)</script><div' as never;
    element.attrs = {
      onclick: 'alert(1)',
      style: 'color:red',
      contenteditable: 'true',
      autofocus: 'true',
      href: 'javascript:alert(1)',
      title: '" onMouseOver="alert(1)',
      'data-safe': 'yes',
    };
    element.styles.base.fontFamily = '</style><script>alert(1)</script>';
    const text = attach(doc, element.id, createText({ text: 'Open' }));
    if (text.type !== 'text') throw new Error('expected text');
    text.content = [{ text: 'Open', marks: { link: 'javascript:alert(1)' } }];

    for (const target of ['react-tailwind', 'html'] as const) {
      const output = generateSelection(doc, frame.id, target);
      expect(output).not.toMatch(
        /<script|\sonclick=|\sonMouseOver="|javascript:|\scontenteditable=|\sautofocus=/,
      );
      expect(output).not.toContain('</style><script>');
      expect(output).toContain('data-safe');
      expect(output).toContain('Open');
    }
  });

  it('exports false boolean attributes as disabled and resolves local assets through ESM', () => {
    const doc = createDocument({ name: 'Assets' });
    const frame = attach(doc, null, createFrame({ name: 'Page' }));
    const input = attach(doc, frame.id, createElement({ tag: 'input' }));
    input.attrs = { disabled: 'false', checked: '0' };
    attach(doc, frame.id, createImage({ src: { asset: 'a'.repeat(64) }, alt: 'Photo' }));
    doc.assets['a'.repeat(64)] = {
      fileName: 'photo.png',
      mime: 'image/png',
      width: 1,
      height: 1,
    };

    const jsx = generateSelection(doc, frame.id, 'react-tailwind');
    expect(jsx).not.toMatch(/\sdisabled(?:\s|=)/);
    expect(jsx).not.toMatch(/\schecked(?:\s|=)/);
    expect(jsx).toContain('new URL("../assets/');
    expect(jsx).toContain('import.meta.url');
  });

  it('allocates safe unique component, variant, breakpoint and token names', () => {
    const doc = createDocument({ name: 'Collisions' });
    const page = attach(doc, null, createFrame({ name: 'Page' }));
    const componentIds = ['one', 'two'];
    for (const [index, id] of componentIds.entries()) {
      const master = attach(doc, null, createFrame({ name: `Master ${index}` }));
      const root = attach(doc, master.id, createElement({ name: 'Root', tag: 'button' }));
      const def: ComponentDef = {
        id,
        name: index === 0 ? 'Card!' : 'Card?',
        rootId: master.id,
        contentRootId: root.id,
        variantProps:
          index === 0
            ? [
                { name: 'className', values: ['a', 'b'], default: 'a' },
                { name: 'a-b', values: ['a', 'b'], default: 'a' },
                { name: 'a_b', values: ['a', 'b'], default: 'a' },
                {
                  name: '`]; export const owned = true; //',
                  values: ['a', 'b'],
                  default: 'a',
                },
                { name: 'default', values: ['a', 'b'], default: 'a' },
                { name: 'class', values: ['a', 'b'], default: 'a' },
              ]
            : [],
        variants: {},
      };
      if (master.type !== 'frame') throw new Error('expected frame');
      master.isComponentMaster = id;
      doc.components[id] = def;
      attach(doc, page.id, createInstance({ componentId: id }));
    }

    const files = generateProject(doc);
    expect(
      files.filter((file) => file.path.startsWith('components/')).map((file) => file.path),
    ).toEqual(['components/Card.tsx', 'components/Card2.tsx']);
    const first = generateComponent(doc, doc.components.one!);
    expect(first).toContain('className_2?:');
    expect(first).toContain('a_b?:');
    expect(first).toContain('a_b_2?:');
    expect(first).toContain('default_2?:');
    expect(first).toContain('class_2?:');
    expect(first).not.toContain('\nexport const owned');
    expect(syntaxDiagnostics(first)).toEqual([]);

    doc.breakpoints = [
      { id: 'wide!', name: 'Wide one', minWidth: 700 },
      { id: 'wide?', name: 'Wide two', minWidth: 900 },
    ];
    page.styles.breakpoints = { 'wide!': { opacity: 0.8 }, 'wide?': { opacity: 0.6 } };
    const selection = generateSelection(doc, page.id, 'react-tailwind');
    const theme = generateThemeCss(doc.tokens, doc.breakpoints);
    expect(selection).not.toContain('wide!:');
    expect(selection).toContain('wide:opacity-80');
    expect(selection).toContain('wide-2:opacity-60');
    expect(theme).toContain('--breakpoint-wide:');
    expect(theme).toContain('--breakpoint-wide-2:');

    const tokens = defaultTokens();
    tokens.spacing['nested.name'] = { $value: px(13) };
    tokens.spacing['nested name'] = { $value: px(17) };
    const tokenTheme = generateThemeCss(tokens);
    expect(tokenTheme).toContain('--spacing-nested-name: 13px');
    expect(tokenTheme).toContain('--spacing-nested-name-2: 17px');
  });

  it('does not let custom breakpoints shadow Tailwind state or built-in variants', () => {
    const doc = createDocument({ name: 'Reserved breakpoints' });
    const page = attach(doc, null, createFrame({ name: 'Page' }));
    doc.breakpoints = [
      { id: 'hover', name: 'Hover-sized', minWidth: 700 },
      { id: 'md', name: 'Custom medium', minWidth: 900 },
    ];
    page.styles.breakpoints = {
      hover: { opacity: 0.8 },
      md: { opacity: 0.6 },
    };

    const selection = generateSelection(doc, page.id, 'react-tailwind');
    const theme = generateThemeCss(doc.tokens, doc.breakpoints);
    expect(selection).toContain('hover-2:opacity-80');
    expect(selection).toContain('md-2:opacity-60');
    expect(selection).not.toContain(' hover:opacity-80');
    expect(theme).toContain('--breakpoint-hover-2:');
    expect(theme).toContain('--breakpoint-md-2:');
  });

  it('emits imported font faces only through safe local asset URLs', () => {
    const doc = createDocument({ name: 'Local fonts' });
    const page = attach(doc, null, createFrame({ name: 'Page' }));
    const fontId = `${'a'.repeat(64)}.woff2`;
    doc.assets[fontId] = {
      fileName: 'interface.woff2',
      mime: 'font/woff2',
      width: 0,
      height: 0,
      fontFace: {
        family: 'Interface Sans',
        style: 'normal',
        weight: '400 700',
        display: 'swap',
      },
    };
    doc.assets[`bad');color:red;/*`] = {
      fileName: 'bad.woff2',
      mime: 'font/woff2',
      width: 0,
      height: 0,
      fontFace: { family: 'Unsafe' },
    };

    const html = generateSelection(doc, page.id, 'html');
    const theme = generateProject(doc).find((file) => file.path === 'theme.css')!.contents;
    for (const output of [html, theme]) {
      expect(output).toContain('@font-face');
      expect(output).toContain(`url('assets/${fontId}')`);
      expect(output).not.toContain(`bad');color:red`);
    }
  });

  it('encodes annotation values so they cannot inject source lines', () => {
    const doc = createDocument({ id: 'doc\nexport const owned = true', name: 'Annotations' });
    const frame = attach(doc, null, createFrame({ name: 'Page' }));
    frame.id = 'frame\nexport const owned = true';
    doc.nodes = { [frame.id]: frame };
    doc.rootOrder = [frame.id];

    const code = generateSelection(doc, frame.id, 'react-tailwind', { annotate: true });
    expect(code).not.toContain('\nexport const owned = true');
    expect(code).toContain('%0Aexport%20const%20owned');
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
