import { attach, createDocument, createElement, createFrame, px } from '@pitolet/schema';
import { describe, expect, it } from 'vitest';
import { nodeToHtml, nodeToJsx } from '../src/index.js';

describe('plain HTML layout codegen', () => {
  it('keeps constrained cross-axis fill aligned by its parent', () => {
    const doc = createDocument({ name: 'Constrained fill' });
    const frame = attach(
      doc,
      null,
      createFrame({
        styles: {
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
        },
      }),
    );
    attach(
      doc,
      frame.id,
      createElement({
        name: 'Centered Content',
        styles: {
          width: 'fill',
          maxWidth: px(880),
        },
      }),
    );

    const { css } = nodeToHtml(doc, frame.id);

    expect(css).toContain('.centered-content {\n  display: flex;\n  flex-direction: column;');
    expect(css).toContain('  width: 100%;\n  max-width: 880px;');
    expect(css).not.toContain('align-self: stretch');
  });

  it('keeps base layout context when generating sparse breakpoint overrides', () => {
    const doc = createDocument({ name: 'Responsive layout' });
    doc.breakpoints = [{ id: 'desktop', name: 'Desktop', minWidth: 1200 }];
    const frame = attach(
      doc,
      null,
      createFrame({
        name: 'Page',
        styles: {
          display: 'flex',
          flexDirection: 'column',
        },
      }),
    );
    const layout = attach(
      doc,
      frame.id,
      createElement({
        name: 'Hero Layout',
        styles: {
          display: 'flex',
          flexDirection: 'column',
          width: 'fill',
        },
      }),
    );
    layout.styles.breakpoints = { desktop: { flexDirection: 'row' } };

    const { css } = nodeToHtml(doc, frame.id);
    expect(css).toContain(
      '@media (min-width: 1200px) {\n  .hero-layout {\n    flex-direction: row;\n  }\n}',
    );
  });

  it('recomputes fill sizing when the parent direction changes at a breakpoint', () => {
    const doc = createDocument({ name: 'Responsive fill' });
    doc.breakpoints = [{ id: 'desktop', name: 'Desktop', minWidth: 1200 }];
    const frame = attach(
      doc,
      null,
      createFrame({
        name: 'Page',
        styles: { display: 'flex', flexDirection: 'column' },
      }),
    );
    frame.styles.breakpoints = { desktop: { flexDirection: 'row' } };
    attach(
      doc,
      frame.id,
      createElement({
        name: 'Fill Child',
        styles: { width: 'fill' },
      }),
    );

    const { css } = nodeToHtml(doc, frame.id);
    expect(css).toContain('.fill-child {\n  display: flex;');
    expect(css).toContain('  width: 100%;');
    expect(css).toContain('@media (min-width: 1200px) {\n  .fill-child {');
    expect(css).toContain('    flex-grow: 1;');
    expect(css).toContain('    flex-basis: 0%;');
    expect(css).toContain('    width: unset;');

    const jsx = nodeToJsx(doc, frame.id);
    expect(jsx).toContain('w-full');
    expect(jsx).toContain('desktop:flex-1');
    expect(jsx).toContain('desktop:min-w-0');
    expect(jsx).toContain('desktop:w-auto');
  });
});
