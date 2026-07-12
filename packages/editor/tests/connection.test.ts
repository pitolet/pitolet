import { describe, expect, it } from 'vitest';
import { initialDocument } from '../src/sync/connection.js';

describe('document deep links', () => {
  const documents = [
    { id: 'welcome', name: 'Welcome' },
    { id: 'imported', name: 'Imported site' },
  ];

  it('opens the requested imported document', () => {
    expect(initialDocument(documents, '?document=imported')?.id).toBe('imported');
  });

  it('falls back to the first document for missing or unknown ids', () => {
    expect(initialDocument(documents, '')?.id).toBe('welcome');
    expect(initialDocument(documents, '?document=missing')?.id).toBe('welcome');
  });
});
