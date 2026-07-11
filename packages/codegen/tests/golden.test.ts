import { createSampleDocument } from '@pitolet/schema';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { generateProject, generateSelection } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const goldenDir = join(here, 'golden');
const UPDATE = process.env.UPDATE_GOLDEN === '1';

/**
 * Golden-file tests: generated output is committed and diffed. Regenerate
 * intentionally with UPDATE_GOLDEN=1 after reviewing changes — codegen must
 * be deterministic, so any unexpected diff is a regression.
 */
describe('golden files', () => {
  const doc = normalizeIds(createSampleDocument());

  it('full project output is stable', () => {
    for (const file of generateProject(doc)) {
      assertGolden(`project/${file.path}`, file.contents);
    }
  });

  it('selection html output is stable', () => {
    const heroId = findByName(doc, 'Hero');
    assertGolden('selection/hero.html', generateSelection(doc, heroId, 'html'));
  });

  it('same input → byte-identical output', () => {
    const a = generateProject(doc);
    const b = generateProject(normalizeIds(createSampleDocument()));
    expect(a).toEqual(b);
  });
});

function assertGolden(relPath: string, actual: string): void {
  const fullPath = join(goldenDir, relPath);
  if (UPDATE || !existsSync(fullPath)) {
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, actual);
    return;
  }
  const expected = readFileSync(fullPath, 'utf8');
  expect(actual, `${relPath} drifted — review and UPDATE_GOLDEN=1 if intended`).toBe(expected);
}

function findByName(doc: ReturnType<typeof createSampleDocument>, name: string): string {
  const node = Object.values(doc.nodes).find((n) => n.name === name);
  if (!node) throw new Error(`no node named ${name}`);
  return node.id;
}

/** Replace random nanoid node ids with stable sequential ids. */
function normalizeIds(doc: ReturnType<typeof createSampleDocument>) {
  const idMap = new Map<string, string>();
  let counter = 0;
  const mapId = (id: string): string => {
    if (!idMap.has(id)) idMap.set(id, `n${String(counter++).padStart(3, '0')}`);
    return idMap.get(id)!;
  };
  const json = JSON.stringify(doc);
  // Walk in stable order: rootOrder first, then depth-first children.
  const walk = (id: string) => {
    mapId(id);
    for (const child of doc.nodes[id]?.children ?? []) walk(child);
  };
  doc.rootOrder.forEach(walk);
  let out = json;
  for (const [oldId, newId] of idMap) out = out.replaceAll(`"${oldId}"`, `"${newId}"`);
  const parsed = JSON.parse(out) as ReturnType<typeof createSampleDocument>;
  parsed.id = 'doc0';
  return parsed;
}
