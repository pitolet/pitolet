import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;
if (!tag) throw new Error('expected a release tag such as v1.2.3');

const match =
  /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
    tag,
  );
if (!match) throw new Error(`invalid release tag "${tag}"; expected v<semver>`);

const version = tag.slice(1);
const workspace = readJson(resolve(repoRoot, 'package.json'));
const published = readJson(resolve(repoRoot, 'packages/server/package.json'));
const cloud = readJson(resolve(repoRoot, 'apps/cloud/package.json'));
const mismatches = [
  ['package.json', workspace.version],
  ['packages/server/package.json', published.version],
  ['apps/cloud/package.json', cloud.version],
].filter(([, candidate]) => candidate !== version);
if (mismatches.length > 0) {
  throw new Error(
    `release tag ${tag} does not match:\n${mismatches
      .map(([path, candidate]) => `  - ${path}: ${String(candidate)}`)
      .join('\n')}`,
  );
}

const prerelease = match[4] !== undefined;
console.log(`Release ${tag} matches every release manifest${prerelease ? ' (prerelease)' : ''}.`);
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `release_tag=${tag}\nversion=${version}\nprerelease=${String(prerelease)}\n`,
  );
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}
