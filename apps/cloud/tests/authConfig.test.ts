import type { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  requiresEmailVerification,
  validateCloudAuthConfig,
  type CloudAuthConfig,
} from '../src/auth/auth.js';

function config(baseURL: string, requireEmailVerification?: boolean): CloudAuthConfig {
  return {
    pool: {} as Pool,
    baseURL,
    secret: 'auth-config-test-secret',
    ...(requireEmailVerification === undefined ? {} : { requireEmailVerification }),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('cloud authentication configuration', () => {
  it('always requires verified email addresses in production', () => {
    vi.stubEnv('NODE_ENV', 'production');

    expect(requiresEmailVerification(config('https://app.pitolet.com', false))).toBe(true);
    expect(requiresEmailVerification(config('http://localhost:8080', false))).toBe(true);
  });

  it('requires a clean HTTPS public origin in production', () => {
    vi.stubEnv('NODE_ENV', 'production');

    expect(() => validateCloudAuthConfig(config('http://app.pitolet.com'))).toThrow(
      'must use HTTPS in production',
    );
    expect(() => validateCloudAuthConfig(config('https://user:secret@app.pitolet.com'))).toThrow(
      'credential-free',
    );
    expect(() => validateCloudAuthConfig(config('https://app.pitolet.com/auth'))).toThrow(
      'must not contain a path',
    );
    expect(() => validateCloudAuthConfig(config('https://app.pitolet.com'))).not.toThrow();
  });

  it('keeps local HTTP development available without weakening HTTPS environments', () => {
    vi.stubEnv('NODE_ENV', 'test');

    expect(requiresEmailVerification(config('http://localhost:8080'))).toBe(false);
    expect(requiresEmailVerification(config('https://preview.example.test'))).toBe(true);
    expect(() => validateCloudAuthConfig(config('http://localhost:8080'))).not.toThrow();
  });
});
