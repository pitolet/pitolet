import { defaultTokens } from '@pitolet/schema';
import { describe, expect, it } from 'vitest';
import { generateThemeCss } from '../src/index.js';

describe('theme breakpoints', () => {
  it('emits custom imported breakpoints without repeating Tailwind defaults', () => {
    const css = generateThemeCss(defaultTokens(), [
      { id: 'md', name: 'Medium', minWidth: 768 },
      { id: 'import-desktop', name: 'Imported desktop', minWidth: 1440 },
    ]);
    expect(css).not.toContain('--breakpoint-md');
    expect(css).toContain('--breakpoint-import-desktop: 90rem;');
  });
});
