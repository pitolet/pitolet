import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import { chromium } from 'playwright-core';

const repoRoot = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const cliPath = resolve(repoRoot, 'packages/server/dist/cli.js');
const editorPath = resolve(repoRoot, 'packages/server/dist/editor/index.html');

if (!existsSync(cliPath) || !existsSync(editorPath)) {
  throw new Error('production build is missing; run `pnpm build` before editor browser QA');
}

const dataDir = mkdtempSync(join(tmpdir(), 'pitolet-editor-e2e-'));
const artifactRoot = process.env.PITOLET_QA_ARTIFACT_DIR
  ? resolve(process.env.PITOLET_QA_ARTIFACT_DIR, 'editor')
  : resolve(tmpdir(), 'pitolet-editor-qa');
rmSync(artifactRoot, { recursive: true, force: true });
mkdirSync(artifactRoot, { recursive: true });
const port = await reservePort();
const baseUrl = `http://127.0.0.1:${port}`;
const logs = [];
const child = spawn(process.execPath, [cliPath, '--port', String(port), '--data', dataDir], {
  cwd: repoRoot,
  env: { ...process.env, NODE_ENV: 'production' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (chunk) => logs.push(String(chunk)));
child.stderr.on('data', (chunk) => logs.push(String(chunk)));

let browser;
let page;
try {
  await waitForServer(baseUrl, child);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: 'dark',
  });
  page = await context.newPage();
  const runtimeErrors = [];
  page.on('pageerror', (error) => runtimeErrors.push(`page error: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') runtimeErrors.push(`console error: ${message.text()}`);
  });

  const response = await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  if (!response?.ok()) throw new Error(`editor returned HTTP ${response?.status() ?? 'none'}`);

  const originalLayer = page.getByRole('treeitem', { name: 'Landing', exact: true });
  await originalLayer.waitFor({ state: 'visible' });
  await originalLayer.click();

  const nameField = page.getByRole('textbox', { name: 'Layer name' });
  await nameField.waitFor({ state: 'visible' });
  await nameField.fill('Landing browser QA');
  await nameField.press('Enter');

  await waitForSavedDocument(dataDir, 'Landing browser QA');
  await page.getByRole('status', { name: 'Saved' }).waitFor({ state: 'visible' });

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page
    .getByRole('treeitem', { name: 'Landing browser QA', exact: true })
    .waitFor({ state: 'visible' });

  await page.screenshot({
    fullPage: true,
    path: resolve(artifactRoot, 'editor-persisted.png'),
  });
  const accessibility = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  writeFileSync(resolve(artifactRoot, 'editor-axe.json'), JSON.stringify(accessibility, null, 2));
  if (accessibility.violations.length > 0) {
    throw new Error(
      `editor axe violations:\n${accessibility.violations
        .map(
          (violation) =>
            `  - ${violation.id} (${violation.impact ?? 'unknown'}) on ` +
            `${violation.nodes.length} node(s): ${violation.help}`,
        )
        .join('\n')}`,
    );
  }

  if (runtimeErrors.length > 0) {
    throw new Error(runtimeErrors.join('\n'));
  }

  await context.close();
  console.log(
    `Editor browser QA passed (edit, sync, persistence, reload, and axe; artifacts: ${artifactRoot}).`,
  );
} catch (error) {
  try {
    await page?.screenshot({
      fullPage: true,
      path: resolve(artifactRoot, 'editor-failure.png'),
    });
  } catch {
    // A crashed page may not be able to produce a screenshot.
  }
  const output = logs.join('').trim();
  throw new Error(
    `${error instanceof Error ? error.message : String(error)}` +
      (output ? `\nServer output:\n${output}` : '') +
      `\nArtifacts retained at ${artifactRoot}`,
    { cause: error },
  );
} finally {
  await browser?.close();
  await stopChild(child);
  rmSync(dataDir, { recursive: true, force: true });
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('could not allocate QA port');
  const selectedPort = address.port;
  await new Promise((resolveClose) => server.close(resolveClose));
  return selectedPort;
}

async function waitForServer(baseUrl, processHandle) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) {
      throw new Error(`Pitolet exited before becoming ready (${processHandle.exitCode})`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // The listener is still starting.
    }
    await delay(100);
  }
  throw new Error('Pitolet did not become ready within 15 seconds');
}

async function waitForSavedDocument(dataDir, expectedName) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const file = readdirSync(dataDir).find((name) => name.endsWith('.pitolet.json'));
    if (file) {
      try {
        const document = JSON.parse(readFileSync(join(dataDir, file), 'utf8'));
        if (Object.values(document.nodes ?? {}).some((node) => node?.name === expectedName)) return;
      } catch {
        // Atomic replacement can race one directory read; retry.
      }
    }
    await delay(100);
  }
  throw new Error(`edited layer "${expectedName}" was not persisted within 10 seconds`);
}

async function stopChild(processHandle) {
  if (processHandle.exitCode !== null) return;
  processHandle.kill('SIGTERM');
  const exited = new Promise((resolveExit) => processHandle.once('exit', resolveExit));
  const timedOut = await Promise.race([exited.then(() => false), delay(5_000).then(() => true)]);
  if (timedOut && processHandle.exitCode === null) {
    processHandle.kill('SIGKILL');
    await exited;
  }
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
