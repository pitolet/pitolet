import { CONTAINER_TAGS, TEXT_TAGS, type Breakpoint } from '@pitolet/schema';

const TAGS = new Set<string>([...CONTAINER_TAGS, ...TEXT_TAGS, 'img']);
const ATTRIBUTES = new Set([
  'id',
  'alt',
  'role',
  'placeholder',
  'title',
  'type',
  'name',
  'value',
  'for',
  'href',
  'target',
  'rel',
  'colspan',
  'rowspan',
  'scope',
  'autocomplete',
  'inputmode',
  'pattern',
  'min',
  'max',
  'step',
  'rows',
  'cols',
  'checked',
  'disabled',
  'selected',
]);
const RESERVED_ATTRIBUTES = new Set([
  'style',
  'ref',
  'key',
  'children',
  'dangerouslysetinnerhtml',
  'contenteditable',
  'autofocus',
  'data-node-id',
  'data-ptl-id',
]);

export function safeTag(tag: string, fallback: string): string {
  return TAGS.has(tag.toLowerCase()) ? tag.toLowerCase() : fallback;
}

export function safeAttributes(attrs: Record<string, string> | undefined): Array<[string, string]> {
  if (!attrs) return [];
  return Object.entries(attrs).filter(([rawKey, value]) => {
    const key = rawKey.toLowerCase();
    if (!/^[a-z][a-z0-9-]*$/.test(key)) return false;
    if (key.startsWith('on') || RESERVED_ATTRIBUTES.has(key)) return false;
    if (!(ATTRIBUTES.has(key) || key.startsWith('aria-') || key.startsWith('data-'))) return false;
    if (key === 'href' && !safeNavigationUrl(value)) return false;
    return true;
  });
}

export function booleanAttributeEnabled(value: string): boolean {
  return !['false', '0', 'no', 'off'].includes(value.trim().toLowerCase());
}

export function safeNavigationUrl(value: string): boolean {
  const input = value.trim();
  if (!input) return true;
  if (
    input.startsWith('/') ||
    input.startsWith('./') ||
    input.startsWith('../') ||
    input.startsWith('#') ||
    input.startsWith('?')
  ) {
    return true;
  }
  try {
    return ['http:', 'https:', 'mailto:', 'tel:'].includes(new URL(input).protocol);
  } catch {
    return false;
  }
}

export function safeImageUrl(value: string): string {
  const input = value.trim();
  if (
    input.startsWith('/') ||
    input.startsWith('./') ||
    input.startsWith('../') ||
    input.startsWith('assets/')
  ) {
    return input;
  }
  try {
    return ['http:', 'https:'].includes(new URL(input).protocol) ? input : '';
  } catch {
    return '';
  }
}

export function safeCssValue(value: string | number): string | number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  // HTML snippets embed the generated stylesheet in a <style> element, so
  // angle brackets are source delimiters as well as braces and semicolons.
  if (
    value.includes('\0') ||
    /[\r\n{};<>]/.test(value) ||
    value.includes('/*') ||
    value.includes('*/')
  ) {
    return null;
  }
  return value;
}

export function safeCommentValue(value: string): string {
  return encodeURIComponent(value);
}

export function allocateNames(values: string[], fallback: string): Map<string, string> {
  const result = new Map<string, string>();
  const used = new Set<string>();
  for (const value of values) {
    const base = sanitizeCssName(value) || fallback;
    let name = base;
    let suffix = 2;
    while (used.has(name)) name = `${base}-${suffix++}`;
    used.add(name);
    result.set(value, name);
  }
  return result;
}

export function allocateIdentifierNames(
  values: string[],
  fallback: string,
  reserved: Iterable<string> = [],
): Map<string, string> {
  const result = new Map<string, string>();
  const used = new Set([
    // JavaScript + TypeScript keywords/contextual keywords cannot be emitted
    // as destructured parameter or interface property identifiers.
    'as',
    'async',
    'await',
    'break',
    'case',
    'catch',
    'class',
    'const',
    'continue',
    'debugger',
    'declare',
    'default',
    'delete',
    'do',
    'else',
    'enum',
    'export',
    'extends',
    'false',
    'finally',
    'for',
    'from',
    'function',
    'get',
    'if',
    'implements',
    'import',
    'in',
    'infer',
    'instanceof',
    'interface',
    'is',
    'keyof',
    'let',
    'module',
    'namespace',
    'never',
    'new',
    'null',
    'of',
    'package',
    'private',
    'protected',
    'public',
    'readonly',
    'return',
    'satisfies',
    'set',
    'static',
    'super',
    'switch',
    'this',
    'throw',
    'true',
    'try',
    'type',
    'typeof',
    'undefined',
    'unique',
    'unknown',
    'var',
    'void',
    'while',
    'with',
    'yield',
    ...reserved,
  ]);
  for (const value of values) {
    const cleaned = value.replace(/[^a-zA-Z0-9_$]/g, '_');
    const base = (/^[A-Za-z_$]/.test(cleaned) ? cleaned : `${fallback}_${cleaned}`) || fallback;
    let name = base;
    let suffix = 2;
    while (used.has(name)) name = `${base}_${suffix++}`;
    used.add(name);
    result.set(value, name);
  }
  return result;
}

export function breakpointVariantNames(breakpoints: Breakpoint[]): Map<string, string> {
  const builtInBreakpoints: Record<string, number> = {
    sm: 640,
    md: 768,
    lg: 1024,
    xl: 1280,
    '2xl': 1536,
  };
  const reserved = new Set([
    ...Object.keys(builtInBreakpoints),
    'hover',
    'focus',
    'focus-within',
    'focus-visible',
    'active',
    'visited',
    'target',
    'first',
    'last',
    'only',
    'odd',
    'even',
    'disabled',
    'enabled',
    'checked',
    'indeterminate',
    'required',
    'valid',
    'invalid',
    'read-only',
    'open',
    'dark',
    'print',
    'portrait',
    'landscape',
    'motion-safe',
    'motion-reduce',
    'contrast-more',
    'contrast-less',
    'rtl',
    'ltr',
    'group-hover',
    'peer-hover',
  ]);
  const canonicalClaims = new Set<string>();
  const result = new Map<string, string>();
  for (const breakpoint of breakpoints) {
    const base = sanitizeCssName(breakpoint.id) || 'breakpoint';
    if (builtInBreakpoints[base] === breakpoint.minWidth && !canonicalClaims.has(base)) {
      canonicalClaims.add(base);
      result.set(breakpoint.id, base);
      continue;
    }
    let name = base;
    let suffix = 2;
    while (reserved.has(name)) name = `${base}-${suffix++}`;
    reserved.add(name);
    result.set(breakpoint.id, name);
  }
  return result;
}

export function sanitizeCssName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

export function escapeCssString(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/[\r\n\f]/g, ' ');
}
