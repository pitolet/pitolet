import { attach, createDocument, createElement, createFrame, px } from '@pitolet/schema';
import { describe, expect, it } from 'vitest';
import { nodeToHtml } from '../src/index.js';

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
});
