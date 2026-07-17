import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const DNS_TIMEOUT_MS = 5_000;

type NetworkScope = 'public' | 'loopback' | 'private';
interface HostResolution {
  scope: NetworkScope;
  addresses: Set<string>;
}

export interface ImportResourcePolicy {
  assertAllowed(resourceUrl: string): Promise<void>;
}

interface PolicyOptions {
  allowInsecureHttp?: boolean;
}

/**
 * Build the network policy used by the capture browser and the asset
 * downloader. The source host itself is an explicit user choice. A page from
 * the public internet is not, however, allowed to pivot into loopback, a LAN,
 * or a cloud metadata address through subresources or redirects.
 */
export async function createImportResourcePolicy(
  sourceUrl: string,
  options: PolicyOptions = {},
): Promise<ImportResourcePolicy> {
  const source = parseNetworkUrl(sourceUrl, 'source URL');
  if (source.protocol !== 'http:' && source.protocol !== 'https:') {
    throw new Error('source URL must use http or https');
  }
  if (source.username || source.password) {
    throw new Error('source URL must not contain embedded credentials');
  }
  const sourceResolution = await resolveHost(source.hostname);
  if (
    isPlaintextProtocol(source.protocol) &&
    sourceResolution.scope !== 'loopback' &&
    !options.allowInsecureHttp
  ) {
    throw new Error(
      `refusing plaintext source ${source.origin}. Use HTTPS, or pass ` +
        '--allow-insecure-http if you understand that page data and capture credentials can be intercepted.',
    );
  }

  const sourceScope = sourceResolution.scope;
  const sourceHostname = normalizeHostname(source.hostname);

  return {
    async assertAllowed(resourceUrl: string): Promise<void> {
      const resource = parseNetworkUrl(resourceUrl, 'page resource');
      if (resource.username || resource.password) {
        throw new Error('resource URLs containing credentials are not allowed');
      }

      const resourceHostname = normalizeHostname(resource.hostname);
      const sameSourceHost = resourceHostname === sourceHostname;
      const resourceResolution = await resolveHost(resource.hostname);
      const resourceScope = resourceResolution.scope;

      if (sameSourceHost) {
        // Re-resolve public source names on every policy check. This catches
        // names that start public and later rebind to a private address.
        if (sourceScope === 'public' && resourceScope !== 'public') {
          throw new Error('the source host resolved to a non-public address');
        }
        if (
          sourceScope === 'private' &&
          [...resourceResolution.addresses].some(
            (address) => !sourceResolution.addresses.has(address),
          )
        ) {
          throw new Error('the private source host changed network addresses during capture');
        }
      } else if (sourceScope === 'loopback' && resourceScope === 'loopback') {
        // Local development commonly splits the page, assets, and API across
        // localhost ports or the localhost/127.0.0.1 aliases.
      } else if (resourceScope !== 'public') {
        throw new Error('private, loopback, link-local, and metadata addresses are blocked');
      }

      if (
        isPlaintextProtocol(resource.protocol) &&
        resourceScope === 'public' &&
        !options.allowInsecureHttp
      ) {
        throw new Error('plaintext public resources are blocked');
      }
    },
  };
}

/**
 * HTTP and WebSocket are the only network protocols the capture may use.
 * Browser-internal data/blob/about URLs do not reach this policy.
 */
function parseNetworkUrl(value: string, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} is not a valid URL`);
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) {
    throw new Error(`${label} uses blocked protocol ${parsed.protocol || 'unknown'}`);
  }
  if (!parsed.hostname) throw new Error(`${label} has no hostname`);
  return parsed;
}

function isPlaintextProtocol(protocol: string): boolean {
  return protocol === 'http:' || protocol === 'ws:';
}

function normalizeHostname(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  return normalized === 'localhost' || normalized.endsWith('.localhost');
}

async function resolveHost(hostname: string): Promise<HostResolution> {
  const normalized = normalizeHostname(hostname);
  if (isLoopbackHostname(normalized)) return { scope: 'loopback', addresses: new Set() };
  if (isIP(normalized)) {
    return { scope: addressScope(normalized), addresses: new Set([normalized]) };
  }

  let timer: NodeJS.Timeout | undefined;
  try {
    const addresses = await Promise.race([
      lookup(normalized, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`DNS lookup timed out for ${normalized}`)),
          DNS_TIMEOUT_MS,
        );
        timer.unref?.();
      }),
    ]);
    if (addresses.length === 0) throw new Error(`DNS returned no addresses for ${normalized}`);
    const normalizedAddresses = new Set(
      addresses.map((entry) => normalizeHostname(entry.address).split('%')[0]!),
    );
    const scopes = [...normalizedAddresses].map(addressScope);
    const scope = scopes.every((entry) => entry === 'public')
      ? 'public'
      : scopes.every((entry) => entry === 'loopback')
        ? 'loopback'
        : 'private';
    return { scope, addresses: normalizedAddresses };
  } catch (error) {
    throw new Error(
      `could not safely resolve ${normalized}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function isPublicNetworkAddress(address: string): boolean {
  return addressScope(address) === 'public';
}

function addressScope(address: string): NetworkScope {
  const normalized = normalizeHostname(address).split('%')[0]!;
  const version = isIP(normalized);
  if (version === 4) return ipv4Scope(normalized);
  if (version === 6) return ipv6Scope(normalized);
  return 'private';
}

function ipv4Scope(address: string): NetworkScope {
  const octets = address.split('.').map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return 'private';
  }
  const [a, b, c] = octets as [number, number, number, number];
  if (a === 127) return 'loopback';
  if (
    a === 0 ||
    a === 10 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  ) {
    return 'private';
  }
  return 'public';
}

function ipv6Scope(address: string): NetworkScope {
  const parts = parseIpv6(address);
  if (!parts) return 'private';
  if (parts.every((part) => part === 0)) return 'private';
  if (parts.slice(0, 7).every((part) => part === 0) && parts[7] === 1) return 'loopback';

  // IPv4-mapped and the deprecated IPv4-compatible form.
  if (parts.slice(0, 5).every((part) => part === 0) && parts[5] === 0xffff) {
    return embeddedIpv4Scope(parts[6]!, parts[7]!);
  }
  if (parts.slice(0, 6).every((part) => part === 0)) {
    return embeddedIpv4Scope(parts[6]!, parts[7]!);
  }

  const first = parts[0]!;
  if ((first & 0xfe00) === 0xfc00) return 'private'; // unique-local
  if ((first & 0xffc0) === 0xfe80) return 'private'; // link-local
  if ((first & 0xff00) === 0xff00) return 'private'; // multicast

  // Only globally routable 2000::/3 addresses are accepted. IANA reserves
  // 2001:0000::/23 for protocol assignments (including Teredo, benchmarking
  // and ORCHID), and 3ffe::/16 is the retired 6bone range. Treat all of them
  // as non-public: some encode another address and none are safe SSRF
  // destinations merely because they sit inside 2000::/3.
  if ((first & 0xe000) !== 0x2000) return 'private';
  if (first === 0x2001 && parts[1]! <= 0x01ff) return 'private';
  if (first === 0x2001 && parts[1] === 0x0db8) return 'private';
  if (first === 0x2002) return 'private'; // deprecated 6to4, embeds IPv4
  if (first === 0x3ffe) return 'private'; // retired 6bone
  return 'public';
}

function embeddedIpv4Scope(high: number, low: number): NetworkScope {
  return ipv4Scope(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
}

function parseIpv6(address: string): number[] | null {
  const normalized = address.toLowerCase();
  if (normalized.includes(':::')) return null;
  const doubleColon = normalized.indexOf('::');
  if (doubleColon !== normalized.lastIndexOf('::')) return null;

  const [headText, tailText] =
    doubleColon >= 0
      ? [normalized.slice(0, doubleColon), normalized.slice(doubleColon + 2)]
      : [normalized, ''];
  const head = headText ? headText.split(':') : [];
  const tail = tailText ? tailText.split(':') : [];

  const expandIpv4Tail = (parts: string[]): boolean => {
    const last = parts.at(-1);
    if (!last?.includes('.')) return true;
    const octets = last.split('.').map(Number);
    if (
      octets.length !== 4 ||
      octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
    ) {
      return false;
    }
    parts.splice(
      parts.length - 1,
      1,
      ((octets[0]! << 8) | octets[1]!).toString(16),
      ((octets[2]! << 8) | octets[3]!).toString(16),
    );
    return true;
  };
  if (!expandIpv4Tail(head) || !expandIpv4Tail(tail)) return null;
  if ([...head, ...tail].some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;

  const missing = 8 - head.length - tail.length;
  if (doubleColon < 0 && missing !== 0) return null;
  if (doubleColon >= 0 && missing < 1) return null;
  return [
    ...head.map((part) => Number.parseInt(part, 16)),
    ...Array.from({ length: missing }, () => 0),
    ...tail.map((part) => Number.parseInt(part, 16)),
  ];
}
