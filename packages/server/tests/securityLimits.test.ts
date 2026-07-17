import {
  createSampleDocument,
  MAX_PATCH_LABEL_LENGTH,
  MAX_PATCH_VALUE_DEPTH,
} from '@pitolet/schema';
import type http from 'node:http';
import { Readable, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { handleAssetUpload, serveAsset } from '../src/assets.js';
import { readJsonBody } from '../src/mcp/mcpServer.js';
import type { AssetStorage } from '../src/storage/StorageAdapter.js';
import {
  DocumentStore,
  MAX_DOCUMENT_BYTES,
  PatchRejectedError,
} from '../src/store/DocumentStore.js';

function request(
  chunks: Array<string | Buffer>,
  headers: http.IncomingHttpHeaders = {},
): http.IncomingMessage {
  const stream = Readable.from(chunks) as unknown as http.IncomingMessage;
  stream.headers = headers;
  return stream;
}

class TestResponse extends Writable {
  status = 0;
  responseHeaders: Record<string, string> = {};
  body = Buffer.alloc(0);

  writeHead(status: number, headers: Record<string, string> = {}): this {
    this.status = status;
    this.responseHeaders = headers;
    return this;
  }

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.body = Buffer.concat([this.body, buffer]);
    callback();
  }
}

describe('MCP request limits', () => {
  it('parses bounded JSON and rejects declared or streamed overflow', async () => {
    await expect(readJsonBody(request(['{"ok":true}']), 64)).resolves.toEqual({ ok: true });

    await expect(readJsonBody(request([], { 'content-length': '65' }), 64)).rejects.toThrow(
      /exceeds 64 bytes/,
    );

    await expect(readJsonBody(request([Buffer.alloc(40), Buffer.alloc(40)]), 64)).rejects.toThrow(
      /exceeds 64 bytes/,
    );
    await expect(readJsonBody(request(['{not json']), 64)).rejects.toThrow(/invalid JSON request/);
  });
});

describe('document storage limits', () => {
  it('rejects an edit that would grow a normal document beyond the import limit', () => {
    const store = new DocumentStore();
    const doc = createSampleDocument();
    store.load(doc);
    const text = Object.values(doc.nodes).find((node) => node.type === 'text');
    if (!text || text.type !== 'text') throw new Error('sample document needs a text node');

    expect(() =>
      store.applyPatch(
        doc.id,
        [
          {
            op: 'replace',
            path: ['nodes', text.id, 'content', 0, 'text'],
            value: 'x'.repeat(MAX_DOCUMENT_BYTES),
          },
        ],
        'test',
        'Oversized text',
      ),
    ).toThrow(PatchRejectedError);
    expect(store.get(doc.id)!.rev).toBe(0);
    expect(store.get(doc.id)!.doc.nodes[text.id]).toEqual(text);
  });

  it('applies the size ceiling to root-level replacements too', () => {
    const store = new DocumentStore();
    const doc = createSampleDocument();
    store.load(doc);

    expect(() =>
      store.applyPatch(
        doc.id,
        [{ op: 'replace', path: ['name'], value: 'x'.repeat(MAX_DOCUMENT_BYTES) }],
        'test',
        'Oversized name',
      ),
    ).toThrow(/maximum serialized size/);
    expect(store.get(doc.id)!.rev).toBe(0);
    expect(store.get(doc.id)!.doc.name).toBe(doc.name);
  });

  it('rejects excessively nested direct patch values before Immer sees them', () => {
    const store = new DocumentStore();
    const doc = createSampleDocument();
    store.load(doc);
    let value: unknown = 'leaf';
    for (let index = 0; index <= MAX_PATCH_VALUE_DEPTH; index += 1) {
      value = { nested: value };
    }

    expect(() =>
      store.applyPatch(
        doc.id,
        [{ op: 'replace', path: ['name'], value }],
        'test',
        'Hostile nested value',
      ),
    ).toThrow(/too deeply nested/);
    expect(store.get(doc.id)!.rev).toBe(0);
  });

  it('rejects prototype-manipulating patch paths before Immer sees them', () => {
    const store = new DocumentStore();
    const doc = createSampleDocument();
    store.load(doc);

    expect(() =>
      store.applyPatch(
        doc.id,
        [
          {
            op: 'add',
            path: ['nodes', '__proto__', 'polluted'],
            value: true,
          },
        ],
        'test',
        'Prototype pollution',
      ),
    ).toThrow(/forbidden prototype segment/);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    expect(store.get(doc.id)!.rev).toBe(0);
  });

  it('rejects numeric keys for record-backed document collections', () => {
    const store = new DocumentStore();
    const doc = createSampleDocument();
    store.load(doc);

    expect(() =>
      store.applyPatch(
        doc.id,
        [
          {
            op: 'add',
            path: ['assets', 0],
            value: {
              fileName: 123,
              width: -1,
              height: -2,
              mime: 99,
            },
          },
        ],
        'editor:test',
        'Invalid numeric asset key',
      ),
    ).toThrow(/key for assets must be a string/);

    expect(() =>
      store.applyPatch(
        doc.id,
        [{ op: 'add', path: ['nodes', 0], value: { id: 0 } }],
        'editor:test',
        'Invalid numeric node key',
      ),
    ).toThrow(/key for nodes must be a string/);

    expect(store.get(doc.id)).toMatchObject({ rev: 0, doc });
  });

  it('revalidates structure when a container is changed into a void tag', () => {
    const store = new DocumentStore();
    const doc = createSampleDocument();
    store.load(doc);
    const container = Object.values(doc.nodes).find(
      (node) => node.type === 'element' && node.children.length > 0,
    );
    if (!container) throw new Error('sample document needs a non-empty element');

    expect(() =>
      store.applyPatch(
        doc.id,
        [{ op: 'replace', path: ['nodes', container.id, 'tag'], value: 'input' }],
        'test',
        'Invalid void tag',
      ),
    ).toThrow(/void element/);
    expect(store.get(doc.id)!.rev).toBe(0);
  });

  it('does not report a committed edit as rejected when a subscriber fails', () => {
    const store = new DocumentStore();
    const doc = createSampleDocument();
    store.load(doc);
    const delivered = vi.fn();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    store.subscribe(() => {
      throw new Error('subscriber unavailable');
    });
    store.subscribe(delivered);

    expect(
      store.applyPatch(
        doc.id,
        [{ op: 'replace', path: ['name'], value: 'Committed' }],
        'test',
        'Rename',
      ),
    ).toBe(1);
    expect(store.get(doc.id)).toMatchObject({ rev: 1, doc: { name: 'Committed' } });
    expect(delivered).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith('[pitolet] patch subscriber failed:', expect.any(Error));
    error.mockRestore();
  });

  it('normalizes server-generated patch labels before broadcasting them', () => {
    const store = new DocumentStore();
    const doc = createSampleDocument();
    store.load(doc);
    const delivered = vi.fn();
    store.subscribe(delivered);

    store.applyRecipe(doc.id, 'mcp', `  ${'Long label '.repeat(30)}  `, (draft) => {
      draft.name = 'Renamed';
    });

    expect(delivered).toHaveBeenCalledOnce();
    const label = delivered.mock.calls[0]?.[0]?.label as string;
    expect(label.length).toBeLessThanOrEqual(MAX_PATCH_LABEL_LENGTH);
    expect(label).toMatch(/…$/);

    store.applyPatch(
      doc.id,
      [{ op: 'replace', path: ['name'], value: 'Renamed again' }],
      'server',
      '   ',
    );
    expect(delivered.mock.calls[1]?.[0]?.label).toBe('Edit');
  });

  it('rejects server-generated operations that cannot be represented on the wire', () => {
    const store = new DocumentStore();
    const doc = createSampleDocument();
    store.load(doc);
    const oversizedTokenKey = 'x'.repeat(257);

    expect(() =>
      store.applyRecipe(doc.id, 'mcp', 'MCP: update tokens', (draft) => {
        draft.tokens.color[oversizedTokenKey] = {
          $value: { space: 'oklch', l: 0.5, c: 0.1, h: 200 },
        };
      }),
    ).toThrow(/cannot be represented by the sync protocol/);
    expect(store.get(doc.id)).toMatchObject({ rev: 0, doc });
  });
});

describe('asset endpoint hardening', () => {
  it('rejects active SVG and raster MIME spoofing before storage', async () => {
    const put = vi.fn<AssetStorage['put']>();
    const assets = {
      put,
      get: vi.fn<AssetStorage['get']>(),
    } satisfies AssetStorage;

    const svgResponse = new TestResponse();
    await handleAssetUpload(
      request(['<svg><script>alert(1)</script></svg>'], {
        'content-type': 'image/svg+xml',
      }),
      svgResponse as unknown as http.ServerResponse,
      assets,
    );
    expect(svgResponse.status).toBe(415);

    const fakePngResponse = new TestResponse();
    await handleAssetUpload(
      request(['not really a png'], { 'content-type': 'image/png' }),
      fakePngResponse as unknown as http.ServerResponse,
      assets,
    );
    expect(fakePngResponse.status).toBe(415);
    expect(put).not.toHaveBeenCalled();
  });

  it('serves internally stored SVG under a restrictive document sandbox', async () => {
    const assets: AssetStorage = {
      put: vi.fn(),
      get: vi.fn(async () => ({
        stream: Readable.from(['<svg xmlns="http://www.w3.org/2000/svg"></svg>']),
        mime: 'image/svg+xml',
      })),
    };
    const response = new TestResponse();
    await serveAsset('0123456789abcdef.svg', response as unknown as http.ServerResponse, assets);
    expect(response.status).toBe(200);
    expect(response.responseHeaders['x-content-type-options']).toBe('nosniff');
    expect(response.responseHeaders['content-security-policy']).toContain("default-src 'none'");
    expect(response.responseHeaders['content-security-policy']).toContain('sandbox');
  });

  it('serves asset metadata without streaming a body for HEAD requests', async () => {
    const stream = Readable.from([Buffer.alloc(42)]);
    const assets: AssetStorage = {
      put: vi.fn(),
      get: vi.fn(async () => ({
        stream,
        mime: 'image/png',
        size: 42,
      })),
    };
    const response = new TestResponse();
    await serveAsset(`${'a'.repeat(64)}.png`, response as unknown as http.ServerResponse, assets, {
      head: true,
    });
    expect(response.status).toBe(200);
    expect(response.responseHeaders['content-length']).toBe('42');
    expect(response.body).toHaveLength(0);
    expect(stream.destroyed).toBe(true);
  });
});
