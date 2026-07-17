import { SCHEMA_VERSION, type PitoletDocument } from './document.js';
import { validateDocument } from './zod.js';

/**
 * Document format migrations. Each entry upgrades from its key version to
 * key+1. `migrate` runs the chain, then fully validates.
 */
const MIGRATIONS: Record<number, (doc: Record<string, unknown>) => Record<string, unknown>> = {
  1: (doc) => {
    const nodes = isRecord(doc.nodes) ? doc.nodes : {};
    const sourceComponents = isRecord(doc.components) ? doc.components : {};
    const components: Record<string, unknown> = {};
    for (const [id, value] of Object.entries(sourceComponents)) {
      if (!isRecord(value)) {
        components[id] = value;
        continue;
      }
      const rootId = typeof value.rootId === 'string' ? value.rootId : '';
      const root = isRecord(nodes[rootId]) ? nodes[rootId] : undefined;
      const children = root && Array.isArray(root.children) ? root.children : [];
      components[id] = {
        ...value,
        // Preserve the old renderer's meaning exactly once during migration.
        // New documents set this explicitly and never infer it again.
        contentRootId:
          children.length === 1 && typeof children[0] === 'string' ? children[0] : rootId,
      };
    }
    return { ...doc, schemaVersion: 2, components };
  },
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
