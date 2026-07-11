import { SCHEMA_VERSION, type PitoletDocument } from './document.js';
import { validateDocument } from './zod.js';

/**
 * Document format migrations. Each entry upgrades from its key version to
 * key+1. `migrate` runs the chain, then fully validates.
 */
const MIGRATIONS: Record<number, (doc: Record<string, unknown>) => Record<string, unknown>> = {
  // 1 → 2 example (none yet):
  // 1: (doc) => ({ ...doc, schemaVersion: 2 }),
};

export function migrateDocument(raw: unknown): PitoletDocument {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('document is not an object');
  }
  let doc = raw as Record<string, unknown>;
  let version = typeof doc.schemaVersion === 'number' ? doc.schemaVersion : 0;
  if (version === 0) throw new Error('document has no schemaVersion');
  if (version > SCHEMA_VERSION) {
    throw new Error(
      `document schemaVersion ${version} is newer than this build supports (${SCHEMA_VERSION})`,
    );
  }
  while (version < SCHEMA_VERSION) {
    const step = MIGRATIONS[version];
    if (!step) throw new Error(`no migration from schemaVersion ${version}`);
    doc = step(doc);
    version = doc.schemaVersion as number;
  }
  return validateDocument(doc);
}
