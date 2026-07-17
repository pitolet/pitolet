import { generateProject } from '@pitolet/codegen';
import type { PitoletDocument } from '@pitolet/schema';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { ASSET_ID_PATTERN, assetMimeForId, type AssetStorage } from './storage/StorageAdapter.js';

export const MANIFEST_NAME = '.pitolet-manifest.json';
const MAX_EXPORT_ASSET_BYTES = 20 * 1024 * 1024;
const MAX_EXPORT_TOTAL_ASSET_BYTES = 500 * 1024 * 1024;
const exportLocks = new Map<string, Promise<void>>();

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

/** Where a document's export lives: <dataDir>/exports/<doc-name>-<doc-id>/ */
export function exportDirFor(doc: PitoletDocument, dataDir: string): string {
  return join(dataDir, 'exports', `${sanitize(doc.name)}-${sanitizeId(doc.id)}`);
}

/**
 * Write the generated project to disk plus a manifest recording each file's
 * source node and content hash — the anchor for drift checks.
 */
export async function exportProject(
  doc: PitoletDocument,
  dataDir: string,
  options: { annotate?: boolean } = {},
  assets?: AssetStorage,
): Promise<{ dir: string; files: string[] }> {
  const outDir = exportDirFor(doc, dataDir);
  const previousExport = exportLocks.get(outDir) ?? Promise.resolve();
  let releaseExport!: () => void;
  const currentExport = new Promise<void>((resolveLock) => {
    releaseExport = resolveLock;
  });
  exportLocks.set(outDir, currentExport);
  await previousExport.catch(() => {});
  try {
    return await exportProjectUnlocked(doc, dataDir, outDir, options, assets);
  } finally {
    releaseExport();
    if (exportLocks.get(outDir) === currentExport) exportLocks.delete(outDir);
  }
}

async function exportProjectUnlocked(
  doc: PitoletDocument,
  dataDir: string,
  outDir: string,
  options: { annotate?: boolean },
  assets?: AssetStorage,
): Promise<{ dir: string; files: string[] }> {
  ensureExportRoot(dataDir, outDir);
  const files = generateProject(doc, { annotate: options.annotate });
  const manifest: ExportManifest = { docId: doc.id, annotate: !!options.annotate, files: {} };
  const previous = readManifest(outDir);
  if (previous && previous.docId !== doc.id) {
    throw new Error(`export directory belongs to another document (${previous.docId})`);
  }

  const generatedPaths = new Set<string>();
  for (const file of files) {
    resolveExportPath(outDir, file.path);
    if (generatedPaths.has(file.path)) {
      throw new Error(`code generation produced duplicate path ${file.path}`);
    }
    generatedPaths.add(file.path);
  }

  const assetFiles: string[] = [];
  const assetPayloads: Array<{ relativePath: string; data: Buffer }> = [];
  let totalAssetBytes = 0;
  if (assets) {
    for (const assetId of Object.keys(doc.assets).sort()) {
      if (!ASSET_ID_PATTERN.test(assetId)) {
        throw new Error(`document contains invalid asset id ${assetId.slice(0, 100)}`);
      }
      const metadata = doc.assets[assetId]!;
      const expectedMime = assetMimeForId(assetId);
      if (metadata.mime !== expectedMime) {
        throw new Error(
          `asset ${assetId} metadata type ${metadata.mime} does not match ${expectedMime}`,
        );
      }
      const found = await assets.get(assetId);
      if (!found) throw new Error(`document asset ${assetId} is missing from storage`);
      if (found.mime !== expectedMime) {
        found.stream.destroy();
        throw new Error(`stored asset ${assetId} has unexpected type ${found.mime}`);
      }
      if (found.size !== undefined && found.size > MAX_EXPORT_ASSET_BYTES) {
        found.stream.destroy();
        throw new Error(`stored asset ${assetId} exceeds 20 MB`);
      }
      const data = await readStream(found.stream, MAX_EXPORT_ASSET_BYTES);
      assertAssetDigest(assetId, data);
      totalAssetBytes += data.length;
      if (totalAssetBytes > MAX_EXPORT_TOTAL_ASSET_BYTES) {
        throw new Error('document assets exceed the 500 MB export limit');
      }
      const relativePath = `assets/${assetId}`;
      resolveExportPath(outDir, relativePath);
      assetPayloads.push({ relativePath, data });
      assetFiles.push(relativePath);
    }
  }

  // Validate and read every dependency before changing the current export.
  // A missing/corrupt asset therefore cannot leave a half-updated project.
  for (const file of files) {
    const path = resolveExportPath(outDir, file.path);
    writeAtomic(outDir, path, file.contents);
    manifest.files[file.path] = { sourceId: file.sourceId, hash: sha1(file.contents) };
  }
  for (const asset of assetPayloads) {
    const path = resolveExportPath(outDir, asset.relativePath);
    writeAtomic(outDir, path, asset.data);
    manifest.files[asset.relativePath] = { hash: sha1(asset.data) };
  }
  if (previous) {
    for (const relativePath of Object.keys(previous.files)) {
      if (!manifest.files[relativePath]) {
        const stalePath = resolveExportPath(outDir, relativePath);
        assertPathParentsSafe(outDir, stalePath);
        rmSync(stalePath, { force: true });
      }
    }
  }
  writeAtomic(outDir, resolveExportPath(outDir, MANIFEST_NAME), JSON.stringify(manifest, null, 2));
  return { dir: outDir, files: [...files.map((f) => f.path), ...assetFiles] };
}

/**
 * Compare the last export against (a) the files on disk and (b) freshly
 * generated code — detecting human/agent code edits and design changes.
 */
export function checkDrift(doc: PitoletDocument, dataDir: string): DriftEntry[] | null {
  const outDir = exportDirFor(doc, dataDir);
  if (!existsSync(outDir)) return null;
  ensureExportRoot(dataDir, outDir);
  const manifestPath = resolveExportPath(outDir, MANIFEST_NAME);
  if (!existsSync(manifestPath)) return null;

  const manifest = readManifest(outDir);
  if (!manifest) return null;
  const current = new Map(
    generateProject(doc, { annotate: manifest.annotate }).map((f) => [f.path, sha1(f.contents)]),
  );
  for (const assetId of Object.keys(doc.assets)) {
    if (!ASSET_ID_PATTERN.test(assetId)) {
      throw new Error(`document contains invalid asset id ${assetId.slice(0, 100)}`);
    }
    const path = `assets/${assetId}`;
    // Asset ids are content-addressed. An existing manifest hash remains the
    // current design hash; a newly referenced asset still appears as changed.
    current.set(path, manifest.files[path]?.hash ?? `new-asset:${assetId}`);
  }

  const entries: DriftEntry[] = [];
  for (const [relPath, record] of Object.entries(manifest.files)) {
    const diskPath = resolveExportPath(outDir, relPath);
    assertPathParentsSafe(outDir, diskPath);
    if (!existsSync(diskPath)) {
      entries.push({ path: relPath, status: 'missing' });
      continue;
    }
    const fileEdited =
      lstatSync(diskPath).isSymbolicLink() || sha1(readFileSync(diskPath)) !== record.hash;
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

async function readStream(stream: Readable, maximum: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maximum) {
      stream.destroy();
      throw new Error('stored asset exceeds 20 MB');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, size);
}

function sha1(value: string | Buffer): string {
  return createHash('sha1').update(value).digest('hex');
}

function readManifest(outDir: string): ExportManifest | null {
  const path = resolveExportPath(outDir, MANIFEST_NAME);
  if (!existsSync(path)) return null;
  try {
    if (lstatSync(path).isSymbolicLink()) throw new Error('manifest must not be a symbolic link');
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ExportManifest>;
    if (
      typeof parsed.docId !== 'string' ||
      typeof parsed.annotate !== 'boolean' ||
      !parsed.files ||
      Array.isArray(parsed.files) ||
      typeof parsed.files !== 'object'
    ) {
      throw new Error('invalid manifest');
    }
    for (const [relativePath, record] of Object.entries(parsed.files)) {
      resolveExportPath(outDir, relativePath);
      if (
        !record ||
        typeof record !== 'object' ||
        typeof record.hash !== 'string' ||
        !/^[a-f0-9]{40}$/.test(record.hash) ||
        (record.sourceId !== undefined && typeof record.sourceId !== 'string')
      ) {
        throw new Error(`invalid manifest record for ${relativePath.slice(0, 100)}`);
      }
    }
    return parsed as ExportManifest;
  } catch (err) {
    throw new Error(
      `cannot safely update export with an unreadable manifest: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err },
    );
  }
}

function writeAtomic(outDir: string, path: string, value: string | Buffer): void {
  ensureSafeDirectory(outDir, dirname(path));
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temp, value);
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

function ensureExportRoot(dataDir: string, outDir: string): void {
  mkdirSync(dataDir, { recursive: true });
  const realDataDir = realpathSync(dataDir);
  const exportsDir = join(dataDir, 'exports');
  mkdirSync(exportsDir, { recursive: true });
  if (lstatSync(exportsDir).isSymbolicLink()) {
    throw new Error('exports directory must not be a symbolic link');
  }
  const realExportsDir = realpathSync(exportsDir);
  assertInside(realDataDir, realExportsDir, 'exports directory');
  mkdirSync(outDir, { recursive: true });
  if (lstatSync(outDir).isSymbolicLink()) {
    throw new Error('document export directory must not be a symbolic link');
  }
  assertInside(realExportsDir, realpathSync(outDir), 'document export directory');
}

function resolveExportPath(outDir: string, relativePath: string): string {
  if (
    !relativePath ||
    relativePath.includes('\0') ||
    relativePath.includes('\\') ||
    relativePath.startsWith('/') ||
    relativePath.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error(`unsafe export path ${relativePath.slice(0, 100)}`);
  }
  const resolved = resolve(outDir, relativePath);
  assertInside(resolve(outDir), resolved, 'export path');
  return resolved;
}

function ensureSafeDirectory(outDir: string, directory: string): void {
  const realOutDir = realpathSync(outDir);
  const pathFromRoot = relative(resolve(outDir), resolve(directory));
  if (pathFromRoot === '') return;
  if (isAbsolute(pathFromRoot) || pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`)) {
    throw new Error('export parent directory escapes the configured data directory');
  }
  let current = realOutDir;
  for (const part of pathFromRoot.split(sep)) {
    const next = join(current, part);
    if (existsSync(next)) {
      const entry = lstatSync(next);
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new Error(`unsafe export directory component ${part}`);
      }
    } else {
      mkdirSync(next);
    }
    current = realpathSync(next);
    assertInside(realOutDir, current, 'export parent directory');
  }
}

function assertPathParentsSafe(outDir: string, path: string): void {
  const realOutDir = realpathSync(outDir);
  const parentPath = relative(resolve(outDir), dirname(resolve(path)));
  if (parentPath === '') return;
  if (isAbsolute(parentPath) || parentPath === '..' || parentPath.startsWith(`..${sep}`)) {
    throw new Error('export path escapes the configured data directory');
  }
  let current = realOutDir;
  for (const part of parentPath.split(sep)) {
    const next = join(current, part);
    if (!existsSync(next)) return;
    const entry = lstatSync(next);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error(`unsafe export directory component ${part}`);
    }
    current = realpathSync(next);
    assertInside(realOutDir, current, 'export path');
  }
}

function assertInside(root: string, candidate: string, label: string): void {
  const pathFromRoot = relative(root, candidate);
  if (
    pathFromRoot === '' ||
    (!isAbsolute(pathFromRoot) && !pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== '..')
  ) {
    return;
  }
  throw new Error(`${label} escapes the configured data directory`);
}

function assertAssetDigest(assetId: string, data: Buffer): void {
  const expected = assetId.slice(0, assetId.indexOf('.'));
  const actual = createHash('sha256').update(data).digest('hex');
  if (!actual.startsWith(expected)) {
    throw new Error(`stored asset ${assetId} does not match its content digest`);
  }
}

function sanitize(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '') || 'untitled'
  ).slice(0, 80);
}

function sanitizeId(id: string): string {
  return (
    id
      .replace(/[^a-zA-Z0-9_-]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .slice(0, 128) || 'document'
  );
}
