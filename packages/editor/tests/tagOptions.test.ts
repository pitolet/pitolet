import { CONTAINER_TAGS, TEXT_TAGS } from '@pitolet/schema';
import { describe, expect, it } from 'vitest';
import { tagOptionGroups } from '../src/inspector/tagOptions.js';

function values(kind: 'container' | 'text') {
  return tagOptionGroups(kind).flatMap((group) => group.options.map((option) => option.value));
}

describe('HTML tag options', () => {
  it('includes every supported container tag exactly once', () => {
    const result = values('container');
    expect(new Set(result).size).toBe(result.length);
    expect([...result].sort()).toEqual([...CONTAINER_TAGS].sort());
  });

  it('includes every supported text tag exactly once', () => {
    const result = values('text');
    expect(new Set(result).size).toBe(result.length);
    expect([...result].sort()).toEqual([...TEXT_TAGS].sort());
  });

  it('puts common tags in predictable groups', () => {
    const container = tagOptionGroups('container');
    const text = tagOptionGroups('text');

    expect(container.find((group) => group.label === 'Structure')?.options[0]?.value).toBe('div');
    expect(
      container.find((group) => group.label === 'Forms')?.options.map((option) => option.value),
    ).toContain('input');
    expect(
      text.find((group) => group.label === 'Headings')?.options.map((option) => option.value),
    ).toEqual(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
  });
});
