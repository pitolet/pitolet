import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type http from 'node:http';
import type { AuthContext, AuthHooks } from './types.js';

const COOKIE_NAME = 'pitolet_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_LOGIN_ATTEMPTS = 10; // per IP per window
const RATE_WINDOW_MS = 60_000;
const MAX_LOGIN_BODY = 10_000;
const MAX_RATE_LIMIT_KEYS = 1_000;
const OVERFLOW_RATE_KEY = '__overflow__';

export interface SharedPasswordOptions {
  /**
   * Trust the first X-Forwarded-For value. Leave false unless requests can
   * only arrive through a proxy that overwrites this header.
   */
  trustProxy?: boolean;
}

/**
 * Shared-password auth for self-hosters. One password, full access:
 *
 * - `Authorization: Bearer <password>` (MCP clients, curl) — compared in
 *   constant time via sha256-then-timingSafeEqual (hashing equalizes length).
 * - Session cookie `pitolet_session=<expiryEpochMs>.<hmac>` minted by
 *   POST /api/login. The HMAC key is derived from the password alone
 *   (sha256('pitolet-cookie' + password)) so sessions survive server
 *   restarts but are invalidated whenever the password changes.
 */
export function sharedPasswordAuth(
  password: string,
  options: SharedPasswordOptions = {},
): AuthHooks {
  if (!password) throw new Error('sharedPasswordAuth requires a non-empty password');

  const passwordHash = sha256(password);
  const cookieKey = sha256('pitolet-cookie' + password);
  const loginAttempts = new Map<string, { count: number; windowStart: number }>();

  const context: AuthContext = { kind: 'user', displayName: 'self-host' };

  const passwordMatches = (provided: string): boolean =>
    timingSafeEqual(sha256(provided), passwordHash);

  const mintCookieValue = (): string => {
    const expiry = String(Date.now() + SESSION_TTL_MS);
    return `${expiry}.${hmacHex(cookieKey, expiry)}`;
  };

  const cookieValid = (value: string): boolean => {
    const dot = value.indexOf('.');
    if (dot <= 0) return false;
    const expiryPart = value.slice(0, dot);
    const macPart = value.slice(dot + 1);
    const expiry = Number(expiryPart);
    if (!Number.isFinite(expiry) || expiry <= Date.now()) return false;
    const expected = Buffer.from(hmacHex(cookieKey, expiryPart), 'utf8');
    const provided = Buffer.from(macPart, 'utf8');
    if (provided.length !== expected.length) return false;
    return timingSafeEqual(provided, expected);
  };

  const rateKey = (ip: string, now: number): string => {
    if (loginAttempts.has(ip)) return ip;
    for (const [key, entry] of loginAttempts) {
      if (now - entry.windowStart > RATE_WINDOW_MS) loginAttempts.delete(key);
    }
    return loginAttempts.size < MAX_RATE_LIMIT_KEYS - 1 ? ip : OVERFLOW_RATE_KEY;
  };

  const isRateLimited = (ip: string): boolean => {
    const now = Date.now();
    const entry = loginAttempts.get(rateKey(ip, now));
    return Boolean(
      entry && now - entry.windowStart <= RATE_WINDOW_MS && entry.count >= MAX_LOGIN_ATTEMPTS,
    );
  };

  const recordFailure = (ip: string): void => {
    const now = Date.now();
    const key = rateKey(ip, now);
    const entry = loginAttempts.get(key);
    if (!entry || now - entry.windowStart > RATE_WINDOW_MS) {
      loginAttempts.set(key, { count: 1, windowStart: now });
      return;
    }
    entry.count += 1;
  };

  const clearFailures = (ip: string): void => {
    loginAttempts.delete(ip);
  };

  return {
    authenticate: async (req) => {
      const authz = req.headers.authorization;
      if (typeof authz === 'string' && authz.startsWith('Bearer ')) {
        const ip = clientIp(req, options.trustProxy);
        if (isRateLimited(ip)) return null;
        if (passwordMatches(authz.slice('Bearer '.length))) {
          clearFailures(ip);
          return context;
        }
        recordFailure(ip);
        return null; // an explicit wrong Bearer never falls back to cookies
      }
      const session = readCookie(req.headers.cookie, COOKIE_NAME);
      if (session !== undefined && cookieValid(session)) return context;
      return null;
    },

    // Shared password = full access once authenticated.
    authorize: () => ({ ok: true }),

    handleLogin: async (req, res) => {
      const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(body));
      };

      const ip = clientIp(req, options.trustProxy);
      if (isRateLimited(ip)) {
        json(429, { error: 'too many login attempts — try again in a minute' });
        return;
      }

      let provided: string;
      try {
        const body = await readBody(req, MAX_LOGIN_BODY);
        const parsed = JSON.parse(body || '{}') as { password?: unknown };
        provided = typeof parsed.password === 'string' ? parsed.password : '';
      } catch {
        json(400, { error: 'invalid request body' });
        return;
      }

      if (!passwordMatches(provided)) {
        recordFailure(ip);
        json(401, { error: 'invalid password' });
        return;
      }
      clearFailures(ip);

      const secure =
        firstForwarded(req.headers['x-forwarded-proto']) === 'https' ||
        ('encrypted' in req.socket && Boolean((req.socket as { encrypted?: boolean }).encrypted));
      const cookie =
        `${COOKIE_NAME}=${mintCookieValue()}; HttpOnly; Path=/; ` +
        `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; SameSite=Lax${secure ? '; Secure' : ''}`;
      json(200, { ok: true }, { 'set-cookie': cookie });
    },
  };
}

// ---------------------------------------------------------------------------

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function hmacHex(key: Buffer, value: string): string {
  return createHmac('sha256', key).update(value).digest('hex');
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

function firstForwarded(header: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(header) ? header[0] : header;
  return raw?.split(',')[0]?.trim();
}

function clientIp(req: http.IncomingMessage, trustProxy = false): string {
  return (
    (trustProxy ? firstForwarded(req.headers['x-forwarded-for']) : undefined) ||
    req.socket.remoteAddress ||
    'unknown'
  );
}

function readBody(req: http.IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > limit) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}
