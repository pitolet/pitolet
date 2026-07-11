import { generateProject } from '@pitolet/codegen';
import type { PitoletDocument } from '@pitolet/schema';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const MANIFEST_NAME = '.pitolet-manifest.json';

export interface ExportManifest {
  docId: string;
  annotate: boolean;
  /** Relative path → source frame/component id + content hash at export time. */
  files: Record<string, { sourceId?: string; hash: string }>;
}

export interface DriftEntry {
  path: string;
  status: 'in-sync' | 'design-updated' | 'file-edited' | 'both' | 'missing';
}

/** Where a document's export lives: <dataDir>/../pitolet-export/<doc-name>/ */
export function exportDirFor(doc: PitoletDocument, dataDir: string): string {
  return resolve(dataDir, '..', 'pitolet-export', sanitize(doc.name));
}

/**
 * Write the generated project to disk plus a manifest recording each file's
 * source node and content hash — the anchor for drift checks.
 */
export function exportProject(
  doc: PitoletDocument,
  dataDir: string,
  options: { annotate?: boolean } = {},
): { dir: string; files: string[] } {
  const outDir = exportDirFor(doc, dataDir);
  const files = generateProject(doc, { annotate: options.annotate });
  const manifest: ExportManifest = { docId: doc.id, annotate: !!options.annotate, files: {} };

  for (const file of files) {
    const path = join(outDir, file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.contents);
    manifest.files[file.path] = { sourceId: file.sourceId, hash: sha1(file.contents) };
  }
  writeFileSync(join(outDir, MANIFEST_NAME), JSON.stringify(manifest, null, 2));
  return { dir: outDir, files: files.map((f) => f.path) };
}

/**
 * Compare the last export against (a) the files on disk and (b) freshly
 * generated code — detecting human/agent code edits and design changes.
 */
export function checkDrift(doc: PitoletDocument, dataDir: string): DriftEntry[] | null {
  const outDir = exportDirFor(doc, dataDir);
  const manifestPath = join(outDir, MANIFEST_NAME);
  if (!existsSync(manifestPath)) return null;

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ExportManifest;
  const current = new Map(
    generateProject(doc, { annotate: manifest.annotate }).map((f) => [f.path, sha1(f.contents)]),
  );

  const entries: DriftEntry[] = [];
  for (const [relPath, record] of Object.entries(manifest.files)) {
    const diskPath = join(outDir, relPath);
    if (!existsSync(diskPath)) {
      entries.push({ path: relPath, status: 'missing' });
      continue;
    }
    const fileEdited = sha1(readFileSync(diskPath, 'utf8')) !== record.hash;
    const designUpdated = current.get(relPath) !== record.hash;
    entries.push({
      path: relPath,
      status:
        fileEdited && designUpdated
          ? 'both'
          : fileEdited
            ? 'file-edited'
            : designUpdated
              ? 'design-updated'
              : 'in-sync',
    });
  }
  // Files the current design would generate that the last export didn't have.
  for (const path of current.keys()) {
    if (!manifest.files[path]) entries.push({ path, status: 'design-updated' });
  }
  return entries;
}

function sha1(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

function sanitize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'untitled';
}
