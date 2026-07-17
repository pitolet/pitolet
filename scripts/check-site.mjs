import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const generatedFiles = [
  'site/landing.pitolet.json',
  'site/vs-figma.pitolet.json',
  'deploy/static/index.html',
  'deploy/static/vs-figma/index.html',
  'deploy/static/media/pitolet-insert.png',
  'deploy/static/media/pitolet-mark.svg',
];
const temporaryRoot = mkdtempSync(join(tmpdir(), 'pitolet-site-check-'));

try {
  const build = spawnSync(process.execPath, [resolve(repoRoot, 'site/build.mjs')], {
    cwd: repoRoot,
    env: { ...process.env, PITOLET_SITE_OUTPUT_ROOT: temporaryRoot },
    encoding: 'utf8',
  });
  if (build.status !== 0) {
    process.stderr.write(build.stdout);
    process.stderr.write(build.stderr);
    throw new Error(`site build failed with exit code ${build.status ?? 'unknown'}`);
  }

  const actualFiles = walkFiles(temporaryRoot);
  const unexpected = actualFiles.filter((path) => !generatedFiles.includes(path));
  if (unexpected.length > 0) {
    throw new Error(`site build wrote unexpected files:\n${unexpected.map(bullet).join('\n')}`);
  }

  const stale = [];
  for (const path of generatedFiles) {
    const committedPath = resolve(repoRoot, path);
    const generatedPath = resolve(temporaryRoot, path);
    if (!existsSync(committedPath)) {
      stale.push(`${path} is missing from the repository`);
      continue;
    }
    if (!existsSync(generatedPath)) {
      stale.push(`${path} was not produced by the site build`);
      continue;
    }
    if (!readFileSync(committedPath).equals(readFileSync(generatedPath))) {
      stale.push(`${path} does not match site/build.ts`);
    }
  }

  if (stale.length > 0) {
    throw new Error(
      `generated site artifacts are stale:\n${stale.map(bullet).join('\n')}\n` +
        'Run `pnpm build:site`, inspect the result, and commit every generated artifact.',
    );
  }

  console.log(`Site artifacts are current (${generatedFiles.length} files).`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

function walkFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory)) {
      const absolute = join(directory, entry);
      if (statSync(absolute).isDirectory()) visit(absolute);
      else files.push(relative(root, absolute).split(sep).join('/'));
    }
  };
  visit(root);
  return files.sort();
}

function bullet(value) {
  return `  - ${value}`;
}
