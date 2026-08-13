import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runImportCommand } from '../src/importer/command.js';
import { createApp, type PitoletApp } from '../src/index.js';

let source: http.Server;
let destination: PitoletApp;
let sourceUrl: string;
let destinationUrl: string;
let dataDir: string;
let reportDir: string;
let storageState: string;

beforeAll(async () => {
  source = http.createServer((req, res) => {
    if (!req.headers.cookie?.includes('session=allowed')) {
      res.writeHead(401, { 'content-type': 'text/plain' }).end('login required');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html>
      <html><head><title>Responsive fixture</title><style>
        :root { --color-brand: #6d28d9; --spacing-gutter: 24px; }
        body {
          margin: 0;
          min-height: 100vh;
          font-family: Arial, sans-serif;
          color: #171717;
          background:
            radial-gradient(ellipse 64% 50% at 50% 96%, rgb(109 40 217 / 28%), transparent 70%),
            radial-gradient(ellipse 120% 80% at 50% -16%, rgb(59 130 246 / 20%), transparent 65%),
            #fafafa;
        }
        main { display: flex; flex-direction: column; gap: 12px; padding: 16px; position: relative; }
        h1 { color: var(--color-brand); font-size: 32px; }
        .cards { display: grid; grid-template-columns: 1fr; gap: 12px; }
        .card { padding: var(--spacing-gutter); border: 1px solid #ddd; border-radius: 12px; box-shadow: 0 8px 20px rgb(0 0 0 / 8%), inset 0 1px white; }
        .action { transform: translateY(0); filter: saturate(1.1); position: sticky; top: 8px; }
        .action:hover { transform: translateY(-2px); color: #6d28d9; }
        .action:focus { outline: 2px solid #6d28d9; }
        .action:active { transform: translateY(1px); }
        .brand-icon { width: 32px; height: 32px; }
        @media (min-width: 768px) { main { padding: 24px; } .cards { grid-template-columns: 1fr 1fr; } }
        @media (max-width: 899px) { h1 { text-transform: uppercase; } }
        @media (min-width: 1200px) { main { padding: 48px; } .cards { grid-template-columns: 1fr 1fr 1fr; } }
      </style></head><body><main data-testid="fixture-root">
        <svg class="brand-icon" viewBox="0 0 32 32" aria-label="Brand mark"><circle cx="16" cy="16" r="14" fill="#6d28d9" /></svg>
        <h1>Imported dashboard</h1>
        <button class="action" type="button">Create report</button>
        <div class="cards">
          <section class="card"><h2>Revenue</h2><p>R 42,000</p></section>
          <section class="card"><h2>Customers</h2><p>128</p></section>
          <section class="card"><canvas width="160" height="80"></canvas></section>
        </div>
        <form><label>Email <input type="email" placeholder="you@example.com"></label></form>
        <table><caption>Quarterly totals</caption><tbody><tr><th scope="row">Q1</th><td>42</td></tr></tbody></table>
        <details><summary>Method</summary><p>Calculated from paid invoices.</p></details>
        <img alt="Pixel" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lz7Z1wAAAABJRU5ErkJggg==">
      </main></body></html>`);
  });
  await new Promise<void>((resolve) => source.listen(0, '127.0.0.1', resolve));
  const sourceAddress = source.address();
  const sourcePort = typeof sourceAddress === 'object' && sourceAddress ? sourceAddress.port : 0;
  sourceUrl = `http://127.0.0.1:${sourcePort}`;

  dataDir = mkdtempSync(join(tmpdir(), 'pitolet-import-e2e-data-'));
  reportDir = mkdtempSync(join(tmpdir(), 'pitolet-import-e2e-report-'));
  storageState = join(dataDir, 'storage-state.json');
  writeFileSync(
    storageState,
    JSON.stringify({
      cookies: [
        {
          name: 'session',
          value: 'allowed',
          domain: '127.0.0.1',
          path: '/',
          expires: -1,
          httpOnly: false,
          secure: false,
          sameSite: 'Lax',
        },
      ],
      origins: [],
    }),
  );
  destination = await createApp({ port: 0, dataDir });
  await new Promise<void>((resolve) => destination.server.listen(0, '127.0.0.1', resolve));
  const destinationAddress = destination.server.address();
  const destinationPort =
    typeof destinationAddress === 'object' && destinationAddress ? destinationAddress.port : 0;
  destinationUrl = `http://127.0.0.1:${destinationPort}`;
}, 30_000);

afterAll(async () => {
  await destination?.adapter.close();
  destination?.server.closeAllConnections();
  if (destination) await new Promise((resolve) => destination.server.close(resolve));
  if (source) await new Promise((resolve) => source.close(resolve));
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(reportDir, { recursive: true, force: true });
});

describe('pitolet import end-to-end', () => {
  it('fails clearly when an authenticated source is captured without login state', async () => {
    await expect(
      runImportCommand([
        sourceUrl,
        '--to',
        destinationUrl,
        '--viewports',
        '375',
        '--report-dir',
        reportDir,
        '--json',
      ]),
    ).rejects.toThrow('source page returned HTTP 401');
  }, 30_000);

  it('captures an authenticated responsive page, verifies it, and imports it', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await runImportCommand([
        sourceUrl,
        '--to',
        destinationUrl,
        '--name',
        'Imported dashboard',
        '--storage-state',
        storageState,
        '--viewports',
        '375,768,1440',
        '--report-dir',
        reportDir,
        '--json',
      ]);
    } finally {
      stdout.mockRestore();
    }

    const imported = destination.store
      .list()
      .find((document) => document.name === 'Imported dashboard');
    expect(imported).toBeDefined();
    const document = destination.store.get(imported!.id)!.doc;
    expect(document.breakpoints.map((breakpoint) => breakpoint.minWidth)).toEqual([
      768, 900, 1200, 1440,
    ]);
    expect(document.tokens.color.brand).toBeDefined();
    expect(document.tokens.spacing.gutter).toBeDefined();
    expect(Object.keys(document.assets).length).toBeGreaterThan(0);
    expect(Object.values(document.nodes).some((node) => node.type === 'image')).toBe(true);
    expect(Object.values(document.nodes).some((node) => node.tag === 'form')).toBe(true);
    expect(Object.values(document.nodes).some((node) => node.tag === 'table')).toBe(true);
    expect(Object.values(document.nodes).some((node) => node.tag === 'details')).toBe(true);
    expect(Object.values(document.nodes).some((node) => node.tag === 'svg')).toBe(true);
    expect(Object.values(document.nodes).some((node) => node.tag === 'circle')).toBe(true);
    const button = Object.values(document.nodes).find((node) => node.tag === 'button');
    expect(button?.styles.states?.hover).toBeDefined();
    expect(document.nodes[document.rootOrder[0]!]!.type).toBe('frame');
    expect(document.nodes[document.rootOrder[0]!]!.styles.base.fills).toHaveLength(3);

    const report = JSON.parse(readFileSync(join(reportDir, 'report.json'), 'utf8')) as {
      similarities: Array<{ width: number; score: number }>;
      rasterizedRegions: number;
      status: string;
      editableAreaScore: number;
      compatibilityIssues: Array<{ kind: string; reason: string; nodeName: string }>;
    };
    expect(report.similarities.map((entry) => entry.width)).toEqual([375, 768, 900, 1200, 1440]);
    expect(report.similarities.every((entry) => entry.score >= 0 && entry.score <= 1)).toBe(true);
    expect(report.status).toBe('degraded');
    expect(report.editableAreaScore).toBeGreaterThan(0.8);
    expect(report.rasterizedRegions).toBe(1);
    expect(report.compatibilityIssues).toContainEqual(
      expect.objectContaining({ kind: 'rasterized', reason: 'canvas' }),
    );
    expect(
      report.compatibilityIssues.some((issue) =>
        ['body', 'html', 'Responsive fixture'].includes(issue.nodeName),
      ),
    ).toBe(false);
  }, 180_000);
});
