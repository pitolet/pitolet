import type http from 'node:http';
import {
  ASSET_EXT_BY_MIME,
  ASSET_ID_PATTERN,
  type AssetStorage,
} from './storage/StorageAdapter.js';

const MAX_ASSET_BYTES = 20 * 1024 * 1024;

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
  const mime = req.headers['content-type'] ?? '';
  if (!ASSET_EXT_BY_MIME[mime]) {
    res.writeHead(415, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `unsupported image type ${mime}` }));
    return;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_ASSET_BYTES) {
      res.writeHead(413).end();
      return;
    }
    chunks.push(chunk as Buffer);
  }
  const { assetId } = await assets.put(Buffer.concat(chunks), mime);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ assetId, mime }));
}

export async function serveAsset(
  assetId: string,
  res: http.ServerResponse,
  assets: AssetStorage,
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
  res.writeHead(200, {
    'content-type': found.mime,
    'cache-control': 'public, max-age=31536000, immutable',
  });
  // A read error mid-stream (deleted/corrupt blob) must kill this response,
  // not the process — 'error' on an unhandled Readable throws globally.
  found.stream.on('error', (err) => {
    console.error('[pitolet] asset stream failed:', err);
    res.destroy();
  });
  found.stream.pipe(res);
}
