import { describe, expect, it } from 'vitest';
import { filterDocuments, parseZoomPercent } from '../src/panels/navigation.js';

describe('editor navigation helpers', () => {
  const documents = [
    { id: 'b', name: 'Checkout', frameCount: 2 },
    { id: 'a', name: 'Account', frameCount: 1 },
    { id: 'c', name: 'Marketing', frameCount: 4 },
  ];

  it('filters documents by name and keeps the current document first', () => {
    expect(filterDocuments(documents, '', 'c').map((document) => document.id)).toEqual([
      'c',
      'a',
      'b',
    ]);
    expect(filterDocuments(documents, 'check', 'c').map((document) => document.id)).toEqual(['b']);
  });

  it('parses, clamps, and rejects zoom percentages', () => {
    expect(parseZoomPercent('125%')).toBe(125);
    expect(parseZoomPercent('0.1')).toBe(2);
    expect(parseZoomPercent('900')).toBe(800);
    expect(parseZoomPercent('nope')).toBeNull();
    expect(parseZoomPercent('0')).toBeNull();
  });
});
