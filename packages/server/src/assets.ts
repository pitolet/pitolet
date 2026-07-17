import type http from 'node:http';
import {
  ASSET_EXT_BY_MIME,
  ASSET_ID_PATTERN,
  type AssetStorage,
} from './storage/StorageAdapter.js';

const MAX_ASSET_BYTES = 20 * 1024 * 1024;
const MAX_CONCURRENT_ASSET_UPLOADS = 4;
let activeAssetUploads = 0;

/**
 * HTTP layer for content-addressed assets. Upload with POST /api/assets
 * (raw body + content-type); serve at /assets-store/<id>. The bytes
 * themselves live behind the storage adapter's AssetStorage.
 */
export async function handleAssetUpload(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  assets: AssetStorage,
): Promise<void> {
  const declaredSize = Number(req.headers['content-length']);
  if (Number.isFinite(declaredSize) && declaredSize > MAX_ASSET_BYTES) {
    res.writeHead(413).end();
    return;
  }
  if (activeAssetUploads >= MAX_CONCURRENT_ASSET_UPLOADS) {
    res.writeHead(503, {
      'content-type': 'application/json',
      'retry-after': '1',
    });
    res.end(JSON.stringify({ error: 'too many concurrent asset uploads' }));
    return;
  }
  activeAssetUploads += 1;
  try {
    const mime = (req.headers['content-type'] ?? '').split(';', 1)[0]!.trim().toLowerCase();
    if (!ASSET_EXT_BY_MIME[mime]) {
      res.writeHead(415, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `unsupported asset type ${mime}` }));
      return;
    }
    // Active SVG documents are not accepted from untrusted HTTP clients. The
    // importer may still place SVG in the content-addressed store internally;
    // those files are served below under a restrictive sandbox.
    if (mime === 'image/svg+xml') {
      res.writeHead(415, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'SVG uploads are not supported; upload a raster image' }));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_ASSET_BYTES) {
        res.writeHead(413).end();
        return;
      }
      chunks.push(buffer);
    }
    const data = Buffer.concat(chunks);
    if (!matchesAssetSignature(data, mime)) {
      res.writeHead(415, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `file contents do not match ${mime}` }));
      return;
    }
    const { assetId } = await assets.put(data, mime);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ assetId, mime }));
  } finally {
    activeAssetUploads -= 1;
  }
}

export async function serveAsset(
  assetId: string,
  res: http.ServerResponse,
  assets: AssetStorage,
  options: { head?: boolean } = {},
): Promise<void> {
  // Content-addressed names only — no traversal.
  if (!ASSET_ID_PATTERN.test(assetId)) {
    res.writeHead(400).end();
    return;
  }
  const found = await assets.get(assetId);
  if (!found) {
    res.writeHead(404).end();
    return;
  }
  const headers: Record<string, string> = {
    'content-type': found.mime,
    'cache-control': 'public, max-age=31536000, immutable',
    'x-content-type-options': 'nosniff',
    'cross-origin-resource-policy': 'same-origin',
  };
  if (found.size !== undefined) headers['content-length'] = String(found.size);
  if (found.mime === 'image/svg+xml') {
    headers['content-security-policy'] =
      "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:";
  }
  res.writeHead(200, headers);
  if (options.head) {
    found.stream.destroy();
    res.end();
    return;
  }
  // A read error mid-stream (deleted/corrupt blob) must kill this response,
  // not the process — 'error' on an unhandled Readable throws globally.
  found.stream.on('error', (err) => {
    console.error('[pitolet] asset stream failed:', err);
    res.destroy();
  });
  found.stream.pipe(res);
}

function matchesAssetSignature(data: Buffer, mime: string): boolean {
  switch (mime) {
    case 'image/png':
      return (
        data.length >= 8 &&
        data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      );
    case 'image/jpeg':
      return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
    case 'image/gif':
      return (
        data.length >= 6 && ['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString('ascii'))
      );
    case 'image/webp':
      return (
        data.length >= 12 &&
        data.subarray(0, 4).toString('ascii') === 'RIFF' &&
        data.subarray(8, 12).toString('ascii') === 'WEBP'
      );
    case 'font/woff':
      return data.length >= 4 && data.subarray(0, 4).toString('ascii') === 'wOFF';
    case 'font/woff2':
      return data.length >= 4 && data.subarray(0, 4).toString('ascii') === 'wOF2';
    default:
      return false;
  }
}
