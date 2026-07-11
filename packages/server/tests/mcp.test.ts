import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type PitoletApp } from '../src/index.js';

describe('MCP end-to-end (real client over streamable HTTP)', () => {
  let app: PitoletApp;
  let dataDir: string;
  let client: Client;
  let docId: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'pitolet-mcp-'));
    app = await createApp({ port: 0, dataDir });
    await new Promise<void>((resolve) => app.server.listen(0, resolve));
    const address = app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    docId = app.store.list()[0]!.id;

    client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)),
    );
  });

  afterAll(async () => {
    await client.close();
    await app.adapter.close();
    await new Promise((resolve) => app.server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  });

  function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
    const content = result.content as Array<{ type: string; text?: string }>;
    return content.find((c) => c.type === 'text')?.text ?? '';
  }

  it('lists tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'add_comment',
      'check_drift',
      'create_document',
      'create_frame',
      'delete_nodes',
      'export_project',
      'get_comments',
      'get_design_as_code',
      'get_node',
      'get_screenshot',
      'get_selection',
      'get_tokens',
      'import_design_system',
      'insert_nodes',
      'list_documents',
      'list_frames',
      'resolve_comment',
      'set_selection',
      'set_tokens',
      'update_node',
    ]);
  });

  it('reads frames and nodes as compact summaries', async () => {
    const frames = JSON.parse(textOf(await client.callTool({ name: 'list_frames', arguments: {} })));
    expect(frames.frames[0].name).toBe('Landing');
    const frameId = frames.frames[0].id;

    const result = await client.callTool({
      name: 'get_node',
      arguments: { nodeId: frameId, depth: 2 },
    });
    const summary = JSON.parse(textOf(result));
    expect(summary.name).toBe('Landing');
    expect(summary.children.length).toBeGreaterThan(0);
    // Token-cost guarantee: a depth-2 frame summary stays compact.
    expect(textOf(result).length).toBeLessThan(4000);
  });

  it('get_design_as_code returns compact production code', async () => {
    const frames = JSON.parse(textOf(await client.callTool({ name: 'list_frames', arguments: {} })));
    const code = textOf(
      await client.callTool({
        name: 'get_design_as_code',
        arguments: { nodeId: frames.frames[0].id },
      }),
    );
    expect(code).toContain('export function Landing()');
    expect(code).toContain('bg-primary');
    // ~2k token budget for a full hero page.
    expect(code.length).toBeLessThan(8000);
  });

  it('insert_nodes creates validated nodes and broadcasts a labeled patch', async () => {
    const frames = JSON.parse(textOf(await client.callTool({ name: 'list_frames', arguments: {} })));
    const frameId = frames.frames[0].id;

    const patches: string[] = [];
    const unsubscribe = app.store.subscribe((p) => patches.push(`${p.origin}:${p.label}`));

    const result = await client.callTool({
      name: 'insert_nodes',
      arguments: {
        parentId: frameId,
        nodes: [
          {
            name: 'Testimonial',
            tag: 'section',
            styles: {
              display: 'flex',
              flexDirection: 'column',
              gap: { row: { $token: 'spacing.3' }, column: { $token: 'spacing.3' } },
              padding: {
                top: { $token: 'spacing.8' },
                right: { $token: 'spacing.8' },
                bottom: { $token: 'spacing.8' },
                left: { $token: 'spacing.8' },
              },
            },
            children: [
              { text: '“Pitolet changed how we ship UI.”', tag: 'blockquote', name: 'Quote' },
              { text: 'Maya Chen, Design Engineer', tag: 'p', name: 'Attribution' },
            ],
          },
        ],
      },
    });
    unsubscribe();

    const parsed = JSON.parse(textOf(result));
    expect(parsed.created).toHaveLength(1);
    expect(patches).toEqual(['mcp:MCP: insert nodes']);

    const doc = app.store.get(docId)!.doc;
    const section = doc.nodes[parsed.created[0]]!;
    expect(section.tag).toBe('section');
    expect(section.children).toHaveLength(2);
  });

  it('rejects invalid inserts atomically', async () => {
    const before = app.store.get(docId)!.rev;
    const result = await client.callTool({
      name: 'insert_nodes',
      arguments: {
        parentId: 'nonexistent-node',
        nodes: [{ text: 'orphan' }],
      },
    });
    expect(result.isError).toBe(true);
    expect(app.store.get(docId)!.rev).toBe(before);
  });

  it('update_node merges styles and confirms compactly', async () => {
    const frames = JSON.parse(textOf(await client.callTool({ name: 'list_frames', arguments: {} })));
    const frameId = frames.frames[0].id;
    const result = await client.callTool({
      name: 'update_node',
      arguments: {
        nodeId: frameId,
        set: { name: 'Home', styles: { base: { opacity: 0.9 } } },
      },
    });
    const parsed = JSON.parse(textOf(result));
    expect(parsed.ok).toBe(true);
    const node = app.store.get(docId)!.doc.nodes[frameId]!;
    expect(node.name).toBe('Home');
    expect(node.styles.base.opacity).toBe(0.9);
    // Merge, not replace: original background fill survives.
    expect(node.styles.base.fills).toBeDefined();
  });

  it('set_tokens merges and recolors live', async () => {
    await client.callTool({
      name: 'set_tokens',
      arguments: {
        patch: {
          color: { brand: { $value: { space: 'oklch', l: 0.6, c: 0.2, h: 20 } } },
        },
      },
    });
    const tokens = app.store.get(docId)!.doc.tokens;
    expect(tokens.color.brand?.$value.h).toBe(20);
    expect(tokens.color.primary).toBeDefined(); // merge kept existing
  });

  it('get_screenshot fails helpfully with no editor connected', async () => {
    const frames = JSON.parse(textOf(await client.callTool({ name: 'list_frames', arguments: {} })));
    const result = await client.callTool({
      name: 'get_screenshot',
      arguments: { frameId: frames.frames[0].id },
    });
    expect(result.isError).toBe(true);
    // No editor and no Playwright → guidance covering both paths.
    expect(textOf(result)).toContain('Playwright');
  });

  it('comment lifecycle: add (agent) → get → resolve', async () => {
    const frames = JSON.parse(textOf(await client.callTool({ name: 'list_frames', arguments: {} })));
    const frameId = frames.frames[0].id;

    const added = JSON.parse(
      textOf(
        await client.callTool({
          name: 'add_comment',
          arguments: { nodeId: frameId, text: 'Tighten the hero spacing' },
        }),
      ),
    );
    expect(added.commentId).toBeTruthy();
    const stored = app.store.get(docId)!.doc.comments![added.commentId]!;
    expect(stored.author).toBe('agent');
    expect(stored.text).toBe('Tighten the hero spacing');

    const list = textOf(await client.callTool({ name: 'get_comments', arguments: {} }));
    expect(list).toContain('Tighten the hero spacing');

    await client.callTool({
      name: 'resolve_comment',
      arguments: { commentId: added.commentId },
    });
    expect(app.store.get(docId)!.doc.comments![added.commentId]!.resolved).toBe(true);
    // Resolved comments hidden by default.
    const afterResolve = textOf(await client.callTool({ name: 'get_comments', arguments: {} }));
    expect(afterResolve).not.toContain('Tighten the hero spacing');
  });

  it('import_design_system merges tokens and reports skips', async () => {
    const css = `@theme {
      --color-brand: #6d28d9;
      --spacing-gutter: 1.5rem;
      --radius-card: 10px;
      --text-hero: 3rem;
      --font-display: 'Space Grotesk', sans-serif;
      --shadow-card: 0 2px 8px rgba(0,0,0,0.1);
      --color-broken: not-a-color;
    }`;
    const result = JSON.parse(
      textOf(await client.callTool({ name: 'import_design_system', arguments: { css } })),
    );
    expect(result.imported.color).toBe(1);
    expect(result.imported.spacing).toBe(1);
    expect(result.imported.fontFamily).toBe(1);
    expect(result.skipped.length).toBe(1);

    const tokens = app.store.get(docId)!.doc.tokens;
    expect(tokens.color.brand).toBeDefined();
    expect(tokens.spacing.gutter?.$value).toEqual({ value: 24, unit: 'px' }); // 1.5rem → 24px
    expect(tokens.typography.fontFamily.display?.$value).toBe('Space Grotesk');
  });

  it('create_document persists a new empty doc', async () => {
    const result = JSON.parse(
      textOf(await client.callTool({ name: 'create_document', arguments: { name: 'Fresh' } })),
    );
    expect(result.docId).toBeTruthy();
    const entry = app.store.get(result.docId);
    expect(entry?.doc.name).toBe('Fresh');
    expect(entry?.doc.rootOrder).toHaveLength(0);
  });

  it('export_project writes a manifest; check_drift detects file + design changes', async () => {
    const exportResult = JSON.parse(
      textOf(await client.callTool({ name: 'export_project', arguments: { annotate: true } })),
    );
    expect(exportResult.files).toContain('theme.css');
    const manifestPath = join(exportResult.dir, '.pitolet-manifest.json');
    expect(existsSync(manifestPath)).toBe(true);

    // Fresh export → in sync.
    let drift = textOf(await client.callTool({ name: 'check_drift', arguments: {} }));
    expect(drift).toContain('everything in sync');

    // Edit a generated file on disk → file-edited.
    const frameFile = (exportResult.files as string[]).find((f) => f.startsWith('frames/'))!;
    const framePath = join(exportResult.dir, frameFile);
    writeFileSync(framePath, readFileSync(framePath, 'utf8') + '\n// hand edit\n');
    drift = textOf(await client.callTool({ name: 'check_drift', arguments: {} }));
    expect(drift).toContain('file-edited');

    // Also mutate the design of that same frame → now file-edited AND
    // design-updated ⇒ status 'both', with reconcile guidance.
    const frames = JSON.parse(textOf(await client.callTool({ name: 'list_frames', arguments: {} })));
    await client.callTool({
      name: 'update_node',
      arguments: { nodeId: frames.frames[0].id, set: { styles: { base: { opacity: 0.5 } } } },
    });
    drift = textOf(await client.callTool({ name: 'check_drift', arguments: {} }));
    expect(drift).toContain('both');
    expect(drift).toContain('design changed');
    expect(drift).toContain('files were edited');
  });
});
