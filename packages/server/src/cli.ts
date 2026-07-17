import { existsSync, mkdirSync } from 'node:fs';
import { isIP } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sharedPasswordAuth } from './auth/sharedPassword.js';
import { createApp } from './server.js';

const SERVER_HELP = `Usage:
  pitolet [options]
  pitolet import <url> --to <destination> [options]

Server options:
  --port <port>                     Listen port (default: 4517)
  --host <host>                     Listen host (default: 127.0.0.1)
  --data <path>                     Document and asset directory (default: ./pitolet)
  --password <password>             Shared password (prefer PITOLET_PASSWORD)
  --trust-proxy                     Trust proxy client-address headers
  --allow-unauthenticated-network   Permit an open non-loopback listener
  -h, --help                        Show this help

The server refuses an unauthenticated non-loopback listener unless you pass
the explicit override. Environment variables use the PITOLET_ prefix.
`;

const args = process.argv.slice(2);
if (args[0] === 'import') {
  try {
    const { runImportCommand } = await import('./importer/command.js');
    await runImportCommand(args.slice(1));
  } catch (err) {
    console.error(`[pitolet import] ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
} else {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(SERVER_HELP);
    process.exit(0);
  }
  validateServerOptions(args);
  const port = Number(process.env.PITOLET_PORT ?? argValue(args, '--port') ?? 4517);
  const host = process.env.PITOLET_HOST ?? argValue(args, '--host') ?? '127.0.0.1';
  const dataDir = resolve(process.env.PITOLET_DATA ?? argValue(args, '--data') ?? './pitolet');
  const password = process.env.PITOLET_PASSWORD ?? argValue(args, '--password');
  const allowOpenNetwork =
    process.env.PITOLET_ALLOW_UNAUTHENTICATED_NETWORK === 'true' ||
    args.includes('--allow-unauthenticated-network');

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`invalid port: ${String(port)}`);
  }
  if (!isValidHost(host)) throw new Error(`invalid host: ${host || '(empty)'}`);
  if (!isLoopbackHost(host) && !password && !allowOpenNetwork) {
    throw new Error(
      `refusing to expose an unauthenticated server on ${host}. ` +
        'Set PITOLET_PASSWORD, bind to 127.0.0.1, or pass ' +
        '--allow-unauthenticated-network if this is intentional.',
    );
  }

  mkdirSync(dataDir, { recursive: true });

  // In production (built CLI), the editor bundle sits next to the server dist.
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, 'editor'), resolve(here, '../../editor/dist')];
  const editorDist = process.env.NODE_ENV === 'development' ? undefined : findFirst(candidates);

  const trustProxy = process.env.PITOLET_TRUST_PROXY === 'true' || args.includes('--trust-proxy');
  const auth = password ? sharedPasswordAuth(password, { trustProxy }) : undefined;
  const { server, adapter, hub } = await createApp({ port, dataDir, editorDist, auth });
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `[pitolet] port ${port} is already in use — is another Pitolet running?\n` +
          `          Stop it, or start this one on a different port: PITOLET_PORT=4518 pnpm dev`,
      );
      process.exit(1);
    }
    throw err;
  });
  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[pitolet] ${signal} received; saving documents and stopping…`);
    const serverClosed = new Promise<void>((resolveClose) => {
      server.close(() => resolveClose());
    });
    // Upgraded WebSockets are not closed by closeAllConnections(). Stop the
    // hub first so no editor patch can race the final storage flush.
    hub.close();
    server.closeAllConnections();
    try {
      await Promise.race([
        serverClosed,
        new Promise<void>((resolveTimeout) => {
          const timer = setTimeout(resolveTimeout, 5_000);
          timer.unref?.();
        }),
      ]);
      await adapter.close();
      console.log('[pitolet] all pending changes saved');
      process.exit(0);
    } catch (err) {
      console.error('[pitolet] shutdown failed:', err);
      process.exit(1);
    }
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  server.listen(port, host, () => {
    const displayHost = host.includes(':') ? `[${host}]` : host;
    console.log(`pitolet server listening on http://${displayHost}:${port}`);
    console.log(`  documents: ${dataDir}`);
    console.log(
      password
        ? '  auth: Password protection enabled'
        : '  auth: No auth — anyone with network access can edit (set PITOLET_PASSWORD to protect)',
    );
    if (!editorDist) console.log('  editor: dev mode (Vite on :5173 proxies here)');
  });
}

function argValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

function validateServerOptions(argv: string[]): void {
  const valued = new Set(['--port', '--host', '--data', '--password']);
  const switches = new Set(['--allow-unauthenticated-network', '--trust-proxy']);
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (!valued.has(argument) && !switches.has(argument)) {
      throw new Error(`unknown server option ${argument}`);
    }
    if (seen.has(argument)) throw new Error(`duplicate server option ${argument}`);
    seen.add(argument);
    if (!valued.has(argument)) continue;
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
    index += 1;
  }
}

function findFirst(paths: string[]): string | undefined {
  return paths.find((p) => existsSync(p));
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/\.$/, '');
  return (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized === '::1' ||
    normalized === '[::1]' ||
    normalized === '127.0.0.1' ||
    normalized.startsWith('127.')
  );
}

function isValidHost(host: string): boolean {
  const value = host.trim();
  if (!value || value.includes('/') || value.includes('://') || /\s/.test(value)) return false;
  if (value.startsWith('[') && value.endsWith(']')) {
    return isIP(value.slice(1, -1)) === 6;
  }
  if (isIP(value)) return true;
  return (
    value.length <= 253 &&
    value
      .replace(/\.$/, '')
      .split('.')
      .every(
        (label) =>
          label.length > 0 &&
          label.length <= 63 &&
          /^[a-zA-Z0-9_](?:[a-zA-Z0-9_-]*[a-zA-Z0-9_])?$/.test(label),
      )
  );
}
