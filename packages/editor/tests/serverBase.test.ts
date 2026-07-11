import { describe, expect, it } from 'vitest';
import {
  appendShareToken,
  apiUrl,
  computeBase,
  computeShareToken,
  isShareSession,
  wsUrl,
} from '../src/sync/serverBase.js';

describe('computeBase', () => {
  it('returns empty string when root-mounted', () => {
    expect(computeBase('/')).toBe('');
    expect(computeBase('/index.html')).toBe('');
    expect(computeBase('')).toBe('');
  });

  it('extracts the /w/:slug workspace prefix', () => {
    expect(computeBase('/w/acme')).toBe('/w/acme');
    expect(computeBase('/w/acme/')).toBe('/w/acme');
    expect(computeBase('/w/acme/anything/else')).toBe('/w/acme');
  });

  it('only matches the prefix at the start of the path', () => {
    expect(computeBase('/foo/w/acme')).toBe('');
  });
});

describe('computeShareToken', () => {
  it('returns null when no share param is present', () => {
    expect(computeShareToken('')).toBeNull();
    expect(computeShareToken('?')).toBeNull();
    expect(computeShareToken('?foo=bar')).toBeNull();
  });

  it('returns null for an empty share param', () => {
    expect(computeShareToken('?share=')).toBeNull();
  });

  it('extracts the share token', () => {
    expect(computeShareToken('?share=pshare_abc123')).toBe('pshare_abc123');
    expect(computeShareToken('?foo=bar&share=pshare_abc123')).toBe('pshare_abc123');
  });

  it('decodes URL-encoded tokens', () => {
    expect(computeShareToken('?share=pshare_a%2Db')).toBe('pshare_a-b');
  });
});

describe('appendShareToken', () => {
  it('passes URLs through untouched without a token', () => {
    expect(appendShareToken('/api/documents', null)).toBe('/api/documents');
    expect(appendShareToken('/api/documents?limit=5', null)).toBe('/api/documents?limit=5');
  });

  it('appends with ? on a bare URL', () => {
    expect(appendShareToken('/w/acme/api/documents', 'pshare_t0k')).toBe(
      '/w/acme/api/documents?share=pshare_t0k',
    );
  });

  it('appends with & when the URL already has a query', () => {
    expect(appendShareToken('/w/acme/api/documents?limit=5', 'pshare_t0k')).toBe(
      '/w/acme/api/documents?limit=5&share=pshare_t0k',
    );
  });

  it('works on absolute WebSocket URLs', () => {
    expect(appendShareToken('ws://host/w/acme/ws', 'pshare_t0k')).toBe(
      'ws://host/w/acme/ws?share=pshare_t0k',
    );
  });

  it('URL-encodes the token', () => {
    expect(appendShareToken('/api', 'a&b=c')).toBe('/api?share=a%26b%3Dc');
  });
});

describe('module-level session state (jsdom: root-mounted, no share)', () => {
  it('is not a share session and builds unsuffixed URLs', () => {
    expect(isShareSession).toBe(false);
    expect(apiUrl('/api/documents')).toBe('/api/documents');
    expect(wsUrl().endsWith('/ws')).toBe(true);
  });
});
