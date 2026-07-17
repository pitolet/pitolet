import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = resolve(repoRoot, 'packages/server');
const require = createRequire(import.meta.url);
const typescript = require.resolve('typescript/bin/tsc', { paths: [repoRoot] });
const temporaryRoot = mkdtempSync(join(tmpdir(), 'pitolet-package-check-'));
const npmCache = join(temporaryRoot, 'npm-cache');
const smokeRoot = join(temporaryRoot, 'smoke');
let server;

try {
  const packResult = run(
    'npm',
    ['pack', '--json', '--pack-destination', temporaryRoot],
    packageRoot,
    { npm_config_cache: npmCache },
  );
  const packed = parsePackResult(packResult.stdout);
  const tarball = resolve(temporaryRoot, packed.filename);
  const paths = new Set(packed.files.map((file) => file.path));

  for (const required of [
    'README.md',
    'package.json',
    'dist/LICENSE',
    'dist/cli.js',
    'dist/index.js',
    'dist/index.d.ts',
    'dist/schema/index.d.ts',
    'dist/editor/index.html',
  ]) {
    if (!paths.has(required)) throw new Error(`npm tarball is missing ${required}`);
  }
  if (![...paths].some((path) => /^dist\/editor\/assets\/.+\.js$/.test(path))) {
    throw new Error('npm tarball is missing the editor JavaScript bundle');
  }
  if (![...paths].some((path) => /^dist\/editor\/assets\/.+\.css$/.test(path))) {
    throw new Error('npm tarball is missing the editor stylesheet');
  }

  const forbidden = [...paths].filter(
    (path) =>
      path.endsWith('.map') ||
      /(^|\/)(?:src|tests?|fixtures?|coverage)(\/|$)/.test(path) ||
      /(^|\/)\.env(?:\.|$)/.test(path) ||
      path.endsWith('.pitolet.json') ||
      /(?:^|\/)(?:package-lock|pnpm-lock|yarn\.lock)/.test(path),
  );
  if (forbidden.length > 0) {
    throw new Error(`npm tarball contains forbidden files:\n${forbidden.map(bullet).join('\n')}`);
  }
  const declarations = readFileSync(resolve(packageRoot, 'dist/index.d.ts'), 'utf8');
  if (declarations.includes('@pitolet/')) {
    throw new Error('public declarations reference a private @pitolet workspace package');
  }

  writeFileSync(
    join(temporaryRoot, 'package.json'),
    JSON.stringify({ private: true, type: 'module' }),
  );
  run(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--no-package-lock',
      '--prefix',
      smokeRoot,
      tarball,
    ],
    temporaryRoot,
    { npm_config_cache: npmCache },
  );

  const installedRoot = resolve(smokeRoot, 'node_modules/pitolet');
  writeFileSync(
    resolve(smokeRoot, 'consumer.ts'),
    [
      "import { DocumentStore, createApp, type PitoletDocument } from 'pitolet';",
      '',
      'const store = new DocumentStore();',
      'declare const document: PitoletDocument;',
      'store.load(document);',
      'void createApp;',
      '',
    ].join('\n'),
  );
  writeFileSync(
    resolve(smokeRoot, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        noEmit: true,
        skipLibCheck: false,
      },
      include: ['consumer.ts'],
    }),
  );
  run(process.execPath, [typescript, '--project', 'tsconfig.json'], smokeRoot);

  const library = await import(pathToFileURL(resolve(installedRoot, 'dist/index.js')).href);
  for (const exported of ['createApp', 'createRuntime', 'DocumentStore']) {
    if (typeof library[exported] !== 'function') {
      throw new Error(`installed package does not export ${exported}`);
    }
  }

  const port = await availablePort();
  const dataDir = resolve(temporaryRoot, 'data');
  const cli = resolve(installedRoot, 'dist/cli.js');
  const logs = [];
  const environment = { ...process.env, NODE_ENV: 'production' };
  delete environment.PITOLET_PASSWORD;
  server = spawn(
    process.execPath,
    [cli, '--host', '127.0.0.1', '--port', String(port), '--data', dataDir],
    { cwd: smokeRoot, env: environment, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  server.stdout.on('data', (chunk) => appendLog(logs, chunk));
  server.stderr.on('data', (chunk) => appendLog(logs, chunk));

  const health = await waitForResponse(`http://127.0.0.1:${port}/api/health`, server, logs);
  if (!health.ok || (await health.json()).ok !== true) {
    throw new Error('installed package health endpoint did not report ok');
  }
  const editor = await fetch(`http://127.0.0.1:${port}/`);
  const html = await editor.text();
  if (!editor.ok || !html.includes('<title>Pitolet</title>')) {
    throw new Error('installed package did not serve its bundled editor');
  }

  console.log(
    `npm package smoke passed (${packed.files.length} files, ${packed.size} compressed bytes).`,
  );
} finally {
  await stopServer(server);
  rmSync(temporaryRoot, { recursive: true, force: true });
}

function run(command, args, cwd, extraEnvironment = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...extraEnvironment },
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (${result.status ?? 'unknown'}):\n` +
        `${result.stdout}${result.stderr}`,
    );
  }
  return result;
}

function parsePackResult(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`npm pack returned invalid JSON:\n${stdout}`);
  }
  if (!Array.isArray(parsed) || parsed.length !== 1 || !parsed[0]?.filename) {
    throw new Error(`npm pack returned an unexpected result:\n${stdout}`);
  }
  return parsed[0];
}

async function availablePort() {
  const probe = createServer();
  await new Promise((resolveListen, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolveListen);
  });
  const address = probe.address();
  if (!address || typeof address === 'string')
    throw new Error('could not allocate smoke-test port');
  await new Promise((resolveClose) => probe.close(resolveClose));
  return address.port;
}

async function waitForResponse(url, child, logs) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`installed CLI exited early (${child.exitCode}):\n${logs.join('')}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {
      // The listener may not be ready yet.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  throw new Error(`installed CLI did not become healthy:\n${logs.join('')}`);
}

function appendLog(logs, chunk) {
  logs.push(String(chunk));
  while (logs.join('').length > 20_000) logs.shift();
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise((resolveExit) => child.once('exit', () => resolveExit(true))),
    new Promise((resolveTimeout) => setTimeout(() => resolveTimeout(false), 5_000)),
  ]);
  if (!exited && child.exitCode === null) child.kill('SIGKILL');
}

function bullet(value) {
  return `  - ${value}`;
}
