import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assetIdFor, convertCapture } from './convert.js';
import { captureWebPage } from './capture.js';
import type { ImportReport } from './types.js';
import { verifyImport } from './verify.js';

const DEFAULT_VIEWPORTS = [375, 768, 1440];

interface ImportArgs {
  url: string;
  to: string;
  name?: string;
  selector?: string;
  storageState?: string;
  waitFor?: string;
  viewports: number[];
  reportDir?: string;
  json: boolean;
}

export async function runImportCommand(argv: string[]): Promise<void> {
  const args = parseImportArgs(argv);
  const token = process.env.PITOLET_TOKEN?.trim();
  progress(args, `Checking import access at ${args.to}…`);
  await preflightDestination(args.to, token);
  const reportDir = args.reportDir
    ? resolve(args.reportDir)
    : mkdtempSync(join(tmpdir(), 'pitolet-import-'));
  mkdirSync(reportDir, { recursive: true });

  progress(args, `Capturing ${args.url} at ${args.viewports.join(', ')}px…`);
  const capture = await captureWebPage({
    url: args.url,
    selector: args.selector,
    storageState: args.storageState,
    waitFor: args.waitFor,
    viewports: args.viewports,
    onBrowserInstall: () => progress(args, 'Chromium is not installed; downloading it once now…'),
  });

  progress(args, 'Converting the captured DOM into an editable Pitolet document…');
  const conversion = convertCapture(capture, args.name);
  let similarities: Awaited<ReturnType<typeof verifyImport>> = [];
  try {
    progress(args, 'Comparing the responsive import with the source screenshots…');
    similarities = await verifyImport(capture, conversion, reportDir);
    for (const similarity of similarities) {
      if (similarity.score < 0.8) {
        conversion.warnings.push(
          `${similarity.width}px visual similarity is ${Math.round(similarity.score * 100)}%; inspect the difference image`,
        );
      }
    }
  } catch (err) {
    conversion.warnings.push(
      `visual comparison failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  progress(args, `Uploading ${conversion.assetCount} assets…`);
  await uploadAssets(args.to, token, capture, conversion.document.assets);
  progress(args, 'Creating the imported document…');
  const imported = await postDocument(args.to, token, conversion.document);
  const documentUrl = `${args.to}/?document=${encodeURIComponent(imported.docId)}`;
  const report: ImportReport = {
    sourceUrl: args.url,
    destination: args.to,
    documentId: imported.docId,
    documentName: conversion.document.name,
    documentUrl,
    nodeCount: conversion.nodeCount,
    assetCount: conversion.assetCount,
    rasterizedRegions: conversion.rasterizedRegions,
    unsupportedCss: conversion.unsupportedCss,
    unmatchedResponsiveNodes: conversion.unmatchedResponsiveNodes,
    similarities,
    warnings: [...new Set(conversion.warnings)],
    reportDir,
  };
  writeFileSync(join(reportDir, 'report.json'), JSON.stringify(report, null, 2));

  if (args.json) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } else {
    printReport(report, imported.duplicate);
  }
}

function parseImportArgs(argv: string[]): ImportArgs {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(IMPORT_HELP);
    process.exit(0);
  }
  const url = argv[0];
  if (!url || url.startsWith('-'))
    throw new Error('usage: pitolet import <url> --to <destination>');
  validateOptions(argv.slice(1));
  assertHttpUrl(url, 'source URL');
  const toValue = flagValue(argv, '--to');
  if (!toValue) throw new Error('--to is required (self-hosted server or cloud workspace URL)');
  const to = normalizeDestination(toValue);
  const storageState = flagValue(argv, '--storage-state');
  if (storageState && !existsSync(resolve(storageState))) {
    throw new Error(`storage state file not found: ${storageState}`);
  }
  const rawViewports = flagValue(argv, '--viewports');
  const viewports = rawViewports
    ? rawViewports.split(',').map((value) => Number(value.trim()))
    : DEFAULT_VIEWPORTS;
  if (
    viewports.length < 1 ||
    viewports.length > 5 ||
    viewports.some((width) => !Number.isInteger(width) || width < 240 || width > 4096) ||
    new Set(viewports).size !== viewports.length
  ) {
    throw new Error('--viewports must contain 1–5 unique integer widths from 240 to 4096');
  }
  return {
    url,
    to,
    name: flagValue(argv, '--name'),
    selector: flagValue(argv, '--selector'),
    storageState: storageState ? resolve(storageState) : undefined,
    waitFor: flagValue(argv, '--wait-for'),
    viewports: [...viewports].sort((a, b) => a - b),
    reportDir: flagValue(argv, '--report-dir'),
    json: argv.includes('--json'),
  };
}

function validateOptions(argv: string[]): void {
  const valued = new Set([
    '--to',
    '--name',
    '--selector',
    '--storage-state',
    '--viewports',
    '--wait-for',
    '--report-dir',
  ]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--json') continue;
    if (!valued.has(arg)) throw new Error(`unknown import option ${arg}`);
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
    i += 1;
  }
}

function flagValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function normalizeDestination(input: string): string {
  const normalized = input.replace(/\/+$/, '').replace(/\/mcp$/, '');
  assertHttpUrl(normalized, 'destination URL');
  return normalized;
}

function assertHttpUrl(value: string, label: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute http(s) URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${label} must use http or https`);
  }
}

async function uploadAssets(
  destination: string,
  token: string | undefined,
  capture: Awaited<ReturnType<typeof captureWebPage>>,
  documentAssets: Record<string, unknown>,
): Promise<void> {
  const uploaded = new Set<string>();
  for (const asset of capture.assets) {
    const expectedId = assetIdFor(asset.data, asset.mime);
    if (!(expectedId in documentAssets) || uploaded.has(expectedId)) continue;
    const response = await fetch(`${destination}/api/assets`, {
      method: 'POST',
      headers: headers(token, { 'content-type': asset.mime }),
      body: asset.data,
    });
    const body = await responseJson(response);
    if (!response.ok) throw destinationError(response.status, body.error, destination);
    if (body.assetId !== expectedId) {
      throw new Error(
        `asset integrity mismatch: expected ${expectedId}, server returned ${body.assetId}`,
      );
    }
    uploaded.add(expectedId);
  }
}

async function postDocument(
  destination: string,
  token: string | undefined,
  document: import('@pitolet/schema').PitoletDocument,
): Promise<{ docId: string; duplicate: boolean }> {
  const response = await fetch(`${destination}/api/import`, {
    method: 'POST',
    headers: headers(token, { 'content-type': 'application/json' }),
    body: JSON.stringify(document),
  });
  const body = await responseJson(response);
  if (!response.ok) throw destinationError(response.status, body.error, destination);
  if (typeof body.docId !== 'string') throw new Error('import server returned no document id');
  return { docId: body.docId, duplicate: body.duplicate === true };
}

function headers(
  token: string | undefined,
  values: Record<string, string>,
): Record<string, string> {
  return token ? { ...values, authorization: `Bearer ${token}` } : values;
}

async function preflightDestination(destination: string, token: string | undefined): Promise<void> {
  const response = await fetch(`${destination}/api/import`, {
    headers: headers(token, { accept: 'application/json' }),
  });
  const body = await responseJson(response);
  if (!response.ok) throw destinationError(response.status, body.error, destination);
  if (body.ok !== true) throw new Error(`${destination} does not support website imports`);
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : { error: text };
  } catch {
    return { error: text || response.statusText };
  }
}

function destinationError(status: number, error: unknown, destination: string): Error {
  const reason = typeof error === 'string' ? error : `HTTP ${status}`;
  if (status === 401) {
    return new Error(
      `${destination} rejected the import: unauthorized. Set PITOLET_TOKEN to a write-scoped agent token or self-hosted password.`,
    );
  }
  return new Error(`${destination} rejected the import (${status}): ${reason}`);
}

function progress(_args: ImportArgs, message: string): void {
  process.stderr.write(`[pitolet import] ${message}\n`);
}

function printReport(report: ImportReport, duplicate: boolean): void {
  process.stdout.write(
    `\n${duplicate ? 'Import already exists' : 'Import complete'}: ${report.documentName}\n` +
      `  Open: ${report.documentUrl}\n` +
      `  Document: ${report.documentId}\n` +
      `  Nodes: ${report.nodeCount}\n` +
      `  Assets: ${report.assetCount}\n` +
      `  Rasterized regions: ${report.rasterizedRegions}\n` +
      `  Unsupported CSS: ${report.unsupportedCss.join(', ') || 'none'}\n` +
      `  Responsive unmatched nodes: ${report.unmatchedResponsiveNodes}\n` +
      `  Similarity: ${report.similarities.map((s) => `${s.width}px ${Math.round(s.score * 100)}%`).join(' · ') || 'not available'}\n` +
      `  Report: ${report.reportDir}\n` +
      (report.warnings.length > 0
        ? `  Warnings (${report.warnings.length}):\n${report.warnings
            .slice(0, 20)
            .map((w) => `    - ${w}`)
            .join('\n')}\n`
        : ''),
  );
}

const IMPORT_HELP = `Usage:
  pitolet import <url> --to <destination> [options]

Options:
  --name <name>                 Imported document name (default: page title)
  --selector <css>              Import one matching subtree (default: body)
  --storage-state <file>        Playwright storage-state JSON for authenticated pages
  --viewports <widths>          Comma-separated responsive widths (default: 375,768,1440)
  --wait-for <css>              Wait for a visible element before capture
  --report-dir <path>           Save source/import/difference images here
  --json                        Print the final report as JSON

Authentication:
  Set PITOLET_TOKEN to a cloud agent token or self-hosted shared password.
  Do not put credentials in command arguments.
`;
