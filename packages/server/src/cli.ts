import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sharedPasswordAuth } from './auth/sharedPassword.js';
import { createApp } from './server.js';

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
  const port = Number(process.env.PITOLET_PORT ?? argValue(args, '--port') ?? 4517);
  const dataDir = resolve(process.env.PITOLET_DATA ?? argValue(args, '--data') ?? './pitolet');
  const password = process.env.PITOLET_PASSWORD ?? argValue(args, '--password');

  mkdirSync(dataDir, { recursive: true });

  // In production (built CLI), the editor bundle sits next to the server dist.
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, 'editor'), resolve(here, '../../editor/dist')];
  const editorDist = process.env.NODE_ENV === 'development' ? undefined : findFirst(candidates);

  const auth = password ? sharedPasswordAuth(password) : undefined;
  const { server } = await createApp({ port, dataDir, editorDist, auth });
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
  server.listen(port, () => {
    console.log(`pitolet server listening on http://localhost:${port}`);
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

function findFirst(paths: string[]): string | undefined {
  return paths.find((p) => existsSync(p));
}
