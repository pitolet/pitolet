import { createElement } from '@pitolet/schema';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { renderSpans, safeTag, safeTextTag, sanitizeAttrs } from '../src/canvas/NodeRenderer.js';
import { canNodeContainChildren } from '../src/store/nodeSafety.js';

describe('canvas DOM safety', () => {
  it('blocks editor-owned, focus-changing, and executable attributes', () => {
    expect(
      sanitizeAttrs({
        style: 'display:none',
        'data-node-id': 'spoofed',
        contentEditable: 'true',
        autoFocus: 'true',
        tabIndex: '0',
        onClick: 'alert(1)',
        href: 'https://example.com',
        id: 'duplicated-across-instances',
        name: 'shared-radio-group',
        for: 'external-control',
        form: 'external-form',
        popovertarget: 'external-popover',
        accessKey: 'x',
        defaultChecked: 'true',
        defaultValue: 'surprise',
        suppressHydrationWarning: 'true',
        disabled: 'false',
        readonly: 'true',
        class: 'imported',
        'aria-label': 'Name',
      }),
    ).toEqual({
      disabled: false,
      readOnly: true,
      className: 'imported',
      'aria-label': 'Name',
    });
  });

  it('falls back safely for unknown and void text tags', () => {
    expect(safeTag('SCRIPT')).toBe('div');
    expect(safeTag('SECTION')).toBe('section');
    expect(safeTextTag('br')).toBe('span');
    expect(canNodeContainChildren(createElement({ tag: 'input' }))).toBe(false);
    expect(canNodeContainChildren(createElement({ tag: 'section' }))).toBe(true);
  });

  it('keeps links embedded in text out of the editor tab order', () => {
    const rendered = renderSpans([
      { text: 'Documentation', marks: { link: 'https://example.com' } },
    ]) as ReactElement[];
    expect(rendered[0]?.type).toBe('a');
    expect(rendered[0]?.props).toMatchObject({ tabIndex: -1, draggable: false });
  });
});
