import {
  attach,
  createDocument,
  createElement,
  createFrame,
  createImage,
  createText,
  mergeParsedTokens,
  parseColor,
  parseCssTokens,
  px,
  sides,
  validateDocument,
  type PitoletNode,
  type PitoletDocument,
  type Shadow,
  type StyleDecl,
} from '@pitolet/schema';
import { createHash } from 'node:crypto';
import type {
  CapturedNode,
  CapturedStyles,
  CaptureRect,
  ImportConversion,
  WebCapture,
} from './types.js';

const TEXT_TAGS = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'span',
  'blockquote',
  'figcaption',
  'code',
  'a',
  'button',
  'label',
  'option',
  'td',
  'th',
]);

const INERT_ATTRS = new Set([
  'alt',
  'aria-label',
  'aria-labelledby',
  'aria-describedby',
  'aria-hidden',
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

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};

export function assetIdFor(data: Buffer, mime: string): string {
  const ext = MIME_EXT[mime];
  if (!ext) throw new Error(`unsupported captured asset type ${mime}`);
  return `${createHash('sha256').update(data).digest('hex').slice(0, 16)}.${ext}`;
}

export function convertCapture(capture: WebCapture, name?: string): ImportConversion {
  if (capture.snapshots.length < 1) throw new Error('capture contains no viewport snapshots');
  const snapshots = [...capture.snapshots].sort((a, b) => a.width - b.width);
  const base = snapshots[0]!;
  const widest = snapshots.at(-1)!;
  const rootKey = base.rootKey;
  if (!snapshots.every((s) => s.rootKey === rootKey)) {
    capture.warnings.push('selected root could not be matched identically across every viewport');
  }

  const document = createDocument({ name: name?.trim() || capture.title || 'Imported website' });
  document.breakpoints = snapshots.slice(1).map((snapshot, index) => ({
    id: index === 0 ? 'import-tablet' : `import-${index === 1 ? 'desktop' : snapshot.width}`,
    name:
      index === 0
        ? 'Imported tablet'
        : index === 1
          ? 'Imported desktop'
          : `Imported ${snapshot.width}`,
    minWidth: snapshot.width,
  }));

  if (Object.keys(capture.cssVariables).length > 0) {
    const css = `:root {\n${Object.entries(capture.cssVariables)
      .map(([key, value]) => `  ${key}: ${value};`)
      .join('\n')}\n}`;
    const parsed = parseCssTokens(css);
    if (parsed.count > 0) mergeParsedTokens(document.tokens, parsed.tokens);
    if (parsed.skipped.length > 0) {
      capture.warnings.push(
        `${parsed.skipped.length} CSS custom properties were not token-compatible`,
      );
    }
  }

  const assetIds = new Map<string, string>();
  for (const asset of capture.assets) {
    const assetId = assetIdFor(asset.data, asset.mime);
    assetIds.set(asset.key, assetId);
    document.assets[assetId] = {
      fileName: asset.fileName,
      width: asset.width,
      height: asset.height,
      mime: asset.mime,
    };
  }

  const allKeys = new Set<string>();
  for (const snapshot of snapshots) {
    for (const key of Object.keys(snapshot.nodes)) allKeys.add(key);
  }
  const unmatchedResponsiveNodes = [...allKeys].filter((key) =>
    snapshots.some((snapshot) => !snapshot.nodes[key]),
  ).length;
  const unsupportedCss = [
    ...new Set(
      snapshots.flatMap((snapshot) =>
        Object.values(snapshot.nodes)
          .map((node) => node.unsupportedReason)
          .filter(
            (reason): reason is string =>
              !!reason &&
              [
                'background image',
                'CSS transform',
                'CSS filter',
                'fixed positioning',
                'pseudo-element content',
              ].includes(reason),
          ),
      ),
    ),
  ];
  if (unmatchedResponsiveNodes > 0) {
    capture.warnings.push(
      `${unmatchedResponsiveNodes} nodes were not present at every viewport; visibility overrides were inferred`,
    );
  }

  const canonical = new Map<string, CapturedNode>();
  for (const key of allKeys) {
    const node = [...snapshots]
      .reverse()
      .map((s) => s.nodes[key])
      .find(Boolean);
    if (node) canonical.set(key, { ...node, children: unionChildren(key, snapshots) });
  }

  const rootCapture = canonical.get(rootKey) ?? widest.nodes[widest.rootKey];
  if (!rootCapture) throw new Error('captured root is missing');
  const rootStyles = rootCapture.unsupportedReason
    ? { display: 'block' as const }
    : styleForKey(rootKey, 0, snapshots);
  if (!['body', 'html'].includes(capture.rootSelector.trim())) {
    rootStyles.width = px(Math.max(1, round(rootCapture.rect.width)));
  }
  const frame = createFrame({
    name: document.name,
    x: 100,
    y: 100,
    width: widest.width,
    height: 'auto',
    styles: rootStyles,
  });
  if (!rootCapture.unsupportedReason) applyResponsiveStyles(frame, rootKey, snapshots);
  attach(document, null, frame);

  let rasterizedRegions = 0;
  const emitted = new Set<string>([rootKey]);

  if (rootCapture.unsupportedReason) {
    const rootImage = convertNode(rootCapture, rootKey, snapshots, assetIds);
    if (!rootImage) throw new Error('captured root could not be rasterized');
    attach(document, frame.id, rootImage);
    rasterizedRegions += 1;
  }

  const appendChildren = (parentKey: string, parentId: string): void => {
    const parentCapture = canonical.get(parentKey);
    if (!parentCapture) return;
    for (const childKey of parentCapture.children) {
      if (emitted.has(childKey)) continue;
      const captured = canonical.get(childKey);
      if (!captured) continue;
      emitted.add(childKey);
      const pitoletNode = convertNode(captured, childKey, snapshots, assetIds);
      if (!pitoletNode) continue;
      if (captured.unsupportedReason) rasterizedRegions += 1;
      attach(document, parentId, pitoletNode);
      if (pitoletNode.type === 'element' || pitoletNode.type === 'frame') {
        appendChildren(childKey, pitoletNode.id);
      }
    }
  };
  if (!rootCapture.unsupportedReason) appendChildren(rootKey, frame.id);

  bindRepeatedTokens(document);

  const validated = validateDocument(document);
  const nodeCount = Object.keys(validated.nodes).length;
  if (nodeCount > 10_000) throw new Error(`captured page has ${nodeCount} nodes; maximum is 10000`);
  return {
    document: validated,
    nodeCount,
    assetCount: Object.keys(validated.assets).length,
    rasterizedRegions,
    unsupportedCss,
    unmatchedResponsiveNodes,
    warnings: [...new Set(capture.warnings)],
  };
}

function unionChildren(key: string, snapshots: WebCapture['snapshots']): string[] {
  const result: string[] = [];
  for (const snapshot of snapshots) {
    for (const child of snapshot.nodes[key]?.children ?? []) {
      if (!result.includes(child)) result.push(child);
    }
  }
  return result;
}

function convertNode(
  captured: CapturedNode,
  key: string,
  snapshots: WebCapture['snapshots'],
  assetIds: Map<string, string>,
): PitoletNode | null {
  const styles = styleForKey(key, 0, snapshots);
  let node: PitoletNode;

  if (captured.unsupportedReason) {
    const rasterKey = `raster:${key}:${snapshots.at(-1)!.width}`;
    const assetId = assetIds.get(rasterKey);
    if (!assetId) return null;
    node = createImage({
      name: captured.name || `Rasterized ${captured.tag}`,
      src: { asset: assetId },
      alt: captured.attrs.alt ?? '',
      styles,
    });
  } else if (captured.tag === 'img' && captured.assetUrl) {
    const assetId = assetIds.get(`url:${captured.assetUrl}`);
    if (!assetId) return null;
    node = createImage({
      name: captured.name || 'Image',
      src: { asset: assetId },
      alt: captured.attrs.alt ?? '',
      styles,
    });
  } else if (captured.kind === 'text') {
    if (!captured.text) return null;
    node = createText({ name: captured.name || 'Text', tag: 'span', text: captured.text, styles });
  } else if (
    TEXT_TAGS.has(captured.tag) &&
    captured.children.every((childKey) =>
      snapshots.every((s) => s.nodes[childKey]?.kind !== 'element'),
    )
  ) {
    const text =
      captured.children
        .map((childKey) => snapshots.map((s) => s.nodes[childKey]?.text).find(Boolean) ?? '')
        .join('')
        .trim() || captured.text;
    node = createText({
      name: captured.name || titleCase(captured.tag),
      tag: captured.tag,
      text,
      styles,
    });
  } else {
    node = createElement({
      name: captured.name || titleCase(captured.tag),
      tag: captured.tag,
      styles,
    });
  }

  const attrs = sanitizeAttrs(captured.attrs);
  if (Object.keys(attrs).length > 0) node.attrs = attrs;
  applyResponsiveStyles(node, key, snapshots);
  return node;
}

function applyResponsiveStyles(
  node: PitoletNode,
  key: string,
  snapshots: WebCapture['snapshots'],
): void {
  let previous = styleForKey(key, 0, snapshots);
  for (let i = 1; i < snapshots.length; i++) {
    const current = styleForKey(key, i, snapshots);
    const patch = diffStyle(previous, current);
    if (Object.keys(patch).length > 0) {
      node.styles.breakpoints ??= {};
      const id = i === 1 ? 'import-tablet' : `import-${i === 2 ? 'desktop' : snapshots[i]!.width}`;
      node.styles.breakpoints[id] = patch;
    }
    previous = current;
  }
}

function styleForKey(key: string, index: number, snapshots: WebCapture['snapshots']): StyleDecl {
  const snapshot = snapshots[index]!;
  const node = snapshot.nodes[key];
  if (!node) return { display: 'none' };
  return capturedStylesToDecl(
    node.styles,
    node.rect,
    node.tag,
    node.unsupportedReason !== undefined,
  );
}

export function capturedStylesToDecl(
  styles: CapturedStyles,
  rect: CaptureRect,
  tag: string,
  forceSize = false,
): StyleDecl {
  const display = displayValue(styles.display);
  const position = ['relative', 'absolute', 'sticky'].includes(styles.position ?? '')
    ? (styles.position as 'relative' | 'absolute' | 'sticky')
    : undefined;
  const decl: StyleDecl = {
    display,
    flexDirection: styles.flexDirection === 'row' ? 'row' : 'column',
    flexWrap: styles.flexWrap === 'wrap' ? 'wrap' : 'nowrap',
    alignItems: alignValue(styles.alignItems),
    justifyContent: justifyValue(styles.justifyContent),
    gap: { row: length(styles.rowGap), column: length(styles.columnGap) },
    alignSelf: alignValue(styles.alignSelf),
    flexGrow: finiteNumber(styles.flexGrow, 0),
    padding: sides4(styles, 'padding'),
    margin: sides4(styles, 'margin'),
    position,
    fontFamily: cleanFont(styles.fontFamily),
    fontSize: length(styles.fontSize),
    fontWeight: clamp(finiteNumber(styles.fontWeight, 400), 1, 1000),
    lineHeight: length(styles.lineHeight),
    letterSpacing: length(styles.letterSpacing),
    textAlign: textAlign(styles.textAlign),
    color: parseColor(styles.color || 'transparent') ?? undefined,
    fills: [
      {
        type: 'solid',
        color: parseColor(styles.backgroundColor || 'transparent') ?? parseColor('transparent')!,
      },
    ],
    border: {
      width: length(styles.borderTopWidth),
      style: borderStyle(styles.borderTopStyle),
      color: parseColor(styles.borderTopColor || 'transparent') ?? parseColor('transparent')!,
    },
    radius: {
      tl: length(styles.borderTopLeftRadius),
      tr: length(styles.borderTopRightRadius),
      br: length(styles.borderBottomRightRadius),
      bl: length(styles.borderBottomLeftRadius),
    },
    opacity: clamp(finiteNumber(styles.opacity, 1), 0, 1),
    overflow: overflowValue(styles.overflow),
    cursor: styles.cursor || 'auto',
    objectFit: objectFit(styles.objectFit),
  };

  const shadows = parseShadows(styles.boxShadow);
  if (shadows.length > 0) decl.shadows = shadows;
  if (styles.mixBlendMode && styles.mixBlendMode !== 'normal') {
    decl.blendMode = styles.mixBlendMode;
  }

  if (tag === '#text') {
    decl.display = 'inline';
    decl.padding = sides(px(0));
    decl.margin = sides(px(0));
    decl.fills = [{ type: 'solid', color: parseColor('transparent')! }];
    decl.border = {
      width: px(0),
      style: 'solid',
      color: parseColor('transparent')!,
    };
    delete decl.position;
  }

  const rowTracks = tracks(styles.gridTemplateRows);
  const columnTracks = tracks(styles.gridTemplateColumns);
  if (rowTracks.length > 0) decl.gridTemplateRows = rowTracks;
  if (columnTracks.length > 0) decl.gridTemplateColumns = columnTracks;
  if (styles.gridColumn && styles.gridColumn !== 'auto') decl.gridColumn = styles.gridColumn;
  if (styles.gridRow && styles.gridRow !== 'auto') decl.gridRow = styles.gridRow;
  if (styles.zIndex && styles.zIndex !== 'auto')
    decl.zIndex = Math.trunc(finiteNumber(styles.zIndex, 0));

  if (position) {
    decl.inset = {};
    for (const side of ['top', 'right', 'bottom', 'left'] as const) {
      if (styles[side] && styles[side] !== 'auto') decl.inset[side] = length(styles[side]);
    }
    if (Object.keys(decl.inset).length === 0) delete decl.inset;
  }

  if (forceSize || tag === 'img' || position === 'absolute') {
    decl.width = px(Math.max(1, round(rect.width)));
    decl.height = px(Math.max(1, round(rect.height)));
  } else {
    if (styles.maxWidth && styles.maxWidth !== 'none') decl.maxWidth = length(styles.maxWidth);
    if (styles.minWidth && parseFloat(styles.minWidth) > 0) decl.minWidth = length(styles.minWidth);
    if (display === 'inline') decl.width = px(Math.max(1, round(rect.width)));
  }
  return removeUndefined(decl);
}

function diffStyle(previous: StyleDecl, current: StyleDecl): Partial<StyleDecl> {
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(current)) {
    if (JSON.stringify(value) !== JSON.stringify((previous as Record<string, unknown>)[key])) {
      patch[key] = value;
    }
  }
  return patch as Partial<StyleDecl>;
}

function sanitizeAttrs(attrs: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(attrs).filter(([key]) => INERT_ATTRS.has(key) || key.startsWith('aria-')),
  );
}

function sides4(styles: CapturedStyles, prefix: 'padding' | 'margin') {
  return {
    top: length(styles[`${prefix}Top`]),
    right: length(styles[`${prefix}Right`]),
    bottom: length(styles[`${prefix}Bottom`]),
    left: length(styles[`${prefix}Left`]),
  };
}

function length(value?: string) {
  return px(round(finiteNumber(value, 0)));
}

function finiteNumber(value: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat(value ?? '');
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function displayValue(value?: string): StyleDecl['display'] {
  if (value === 'none') return 'none';
  if (value === 'flex' || value === 'inline-flex') return 'flex';
  if (value === 'grid' || value === 'inline-grid') return 'grid';
  if (value === 'inline' || value === 'inline-block') return 'inline';
  return 'block';
}

function alignValue(value?: string): NonNullable<StyleDecl['alignItems']> {
  const mapped: Record<string, NonNullable<StyleDecl['alignItems']>> = {
    'flex-start': 'start',
    start: 'start',
    center: 'center',
    'flex-end': 'end',
    end: 'end',
    stretch: 'stretch',
    baseline: 'baseline',
    normal: 'stretch',
    auto: 'stretch',
  };
  return mapped[value ?? ''] ?? 'stretch';
}

function justifyValue(value?: string): NonNullable<StyleDecl['justifyContent']> {
  const mapped: Record<string, NonNullable<StyleDecl['justifyContent']>> = {
    'flex-start': 'start',
    start: 'start',
    center: 'center',
    'flex-end': 'end',
    end: 'end',
    'space-between': 'between',
    'space-around': 'around',
    'space-evenly': 'evenly',
    normal: 'start',
  };
  return mapped[value ?? ''] ?? 'start';
}

function textAlign(value?: string): NonNullable<StyleDecl['textAlign']> {
  return value === 'center' || value === 'right' || value === 'justify' ? value : 'left';
}

function borderStyle(value?: string): 'solid' | 'dashed' | 'dotted' {
  return value === 'dashed' || value === 'dotted' ? value : 'solid';
}

function overflowValue(value?: string): NonNullable<StyleDecl['overflow']> {
  return value === 'hidden' || value === 'auto' || value === 'scroll' ? value : 'visible';
}

function objectFit(value?: string): NonNullable<StyleDecl['objectFit']> {
  return value === 'contain' || value === 'fill' || value === 'none' ? value : 'cover';
}

function cleanFont(value?: string): string {
  return (value ?? 'system-ui')
    .split(',')[0]!
    .trim()
    .replace(/^['"]|['"]$/g, '');
}

function tracks(value?: string): Array<{ kind: 'px'; value: number }> {
  if (!value || value === 'none') return [];
  return value
    .split(/\s+/)
    .map((part) => finiteNumber(part, 0))
    .filter((part) => part > 0)
    .map((part) => ({ kind: 'px' as const, value: round(part) }));
}

function parseShadows(value?: string): Shadow[] {
  if (!value || value === 'none') return [];
  const first = value.match(
    /^(inset\s+)?(rgba?\([^)]+\)|oklch\([^)]+\)|#[0-9a-fA-F]{3,8})\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+([\d.]+)px(?:\s+(-?[\d.]+)px)?/,
  );
  const alternate = value.match(
    /^(inset\s+)?(-?[\d.]+)px\s+(-?[\d.]+)px\s+([\d.]+)px(?:\s+(-?[\d.]+)px)?\s+(rgba?\([^)]+\)|oklch\([^)]+\)|#[0-9a-fA-F]{3,8})/,
  );
  const match = first ?? alternate;
  if (!match) return [];
  const colorText = first ? match[2]! : match[6]!;
  const color = parseColor(colorText);
  if (!color) return [];
  return [
    {
      x: finiteNumber(first ? match[3] : match[2], 0),
      y: finiteNumber(first ? match[4] : match[3], 0),
      blur: Math.max(0, finiteNumber(first ? match[5] : match[4], 0)),
      spread: finiteNumber(first ? match[6] : match[5], 0),
      color,
      ...(match[1] ? { inset: true as const } : {}),
    },
  ];
}

/** Bind exact CSS-variable values, then promote values repeated at least three times. */
function bindRepeatedTokens(document: PitoletDocument): void {
  const counts = {
    color: new Map<string, { value: unknown; count: number }>(),
    spacing: new Map<string, { value: unknown; count: number }>(),
    radius: new Map<string, { value: unknown; count: number }>(),
    fontSize: new Map<string, { value: unknown; count: number }>(),
    fontFamily: new Map<string, { value: unknown; count: number }>(),
  };
  forEachDecl(document, (decl) => collectDeclValues(decl as Record<string, unknown>, counts));

  addInferredTokens(document, counts.color, 'color');
  addInferredTokens(document, counts.spacing, 'spacing');
  addInferredTokens(document, counts.radius, 'radius');
  addInferredTokens(document, counts.fontSize, 'fontSize');
  addInferredTokens(document, counts.fontFamily, 'fontFamily');

  const maps = {
    color: tokenMap(document.tokens.color, 'color'),
    spacing: tokenMap(document.tokens.spacing, 'spacing'),
    radius: tokenMap(document.tokens.radius, 'radius'),
    fontSize: tokenMap(document.tokens.typography.fontSize, 'typography.fontSize'),
    fontFamily: tokenMap(document.tokens.typography.fontFamily, 'typography.fontFamily'),
  };
  forEachDecl(document, (decl) => bindDeclValues(decl as Record<string, unknown>, maps));
}

type Counts = {
  color: Map<string, { value: unknown; count: number }>;
  spacing: Map<string, { value: unknown; count: number }>;
  radius: Map<string, { value: unknown; count: number }>;
  fontSize: Map<string, { value: unknown; count: number }>;
  fontFamily: Map<string, { value: unknown; count: number }>;
};

function forEachDecl(document: PitoletDocument, callback: (decl: StyleDecl) => void): void {
  for (const node of Object.values(document.nodes)) {
    callback(node.styles.base);
    for (const layer of Object.values(node.styles.breakpoints ?? {})) callback(layer);
  }
}

function collectDeclValues(decl: Record<string, unknown>, counts: Counts): void {
  collect(counts.color, decl.color);
  const fills = decl.fills as Array<{ type?: string; color?: unknown }> | undefined;
  for (const fill of fills ?? []) if (fill.type === 'solid') collect(counts.color, fill.color);
  const border = decl.border as { color?: unknown } | undefined;
  collect(counts.color, border?.color);
  const shadows = decl.shadows as Array<{ color?: unknown }> | undefined;
  for (const shadow of shadows ?? []) collect(counts.color, shadow.color);

  for (const field of ['padding', 'margin'] as const) {
    const box = decl[field] as Record<string, unknown> | undefined;
    for (const value of Object.values(box ?? {})) collectLength(counts.spacing, value);
  }
  const gap = decl.gap as Record<string, unknown> | undefined;
  for (const value of Object.values(gap ?? {})) collectLength(counts.spacing, value);
  const radius = decl.radius as Record<string, unknown> | undefined;
  for (const value of Object.values(radius ?? {})) collectLength(counts.radius, value);
  collectLength(counts.fontSize, decl.fontSize);
  collect(counts.fontFamily, decl.fontFamily);
}

function collect(map: Map<string, { value: unknown; count: number }>, value: unknown): void {
  if (value === undefined || isToken(value)) return;
  const key = JSON.stringify(value);
  const current = map.get(key);
  map.set(key, { value, count: (current?.count ?? 0) + 1 });
}

function collectLength(map: Map<string, { value: unknown; count: number }>, value: unknown): void {
  if (isLength(value) && value.value !== 0) collect(map, value);
}

function addInferredTokens(
  document: PitoletDocument,
  map: Map<string, { value: unknown; count: number }>,
  category: 'color' | 'spacing' | 'radius' | 'fontSize' | 'fontFamily',
): void {
  let index = 1;
  const target =
    category === 'color'
      ? document.tokens.color
      : category === 'spacing'
        ? document.tokens.spacing
        : category === 'radius'
          ? document.tokens.radius
          : category === 'fontSize'
            ? document.tokens.typography.fontSize
            : document.tokens.typography.fontFamily;
  for (const entry of map.values()) {
    if (entry.count < 3) continue;
    if (
      Object.values(target).some(
        (token) => JSON.stringify(token.$value) === JSON.stringify(entry.value),
      )
    ) {
      continue;
    }
    const name = `imported-${index++}`;
    if (category === 'color') document.tokens.color[name] = { $value: entry.value as never };
    else if (category === 'spacing')
      document.tokens.spacing[name] = { $value: entry.value as never };
    else if (category === 'radius') document.tokens.radius[name] = { $value: entry.value as never };
    else if (category === 'fontSize')
      document.tokens.typography.fontSize[name] = { $value: entry.value as never };
    else document.tokens.typography.fontFamily[name] = { $value: entry.value as string };
  }
}

function tokenMap(
  tokens: Record<string, { $value: unknown }>,
  prefix: string,
): Map<string, { $token: string }> {
  return new Map(
    Object.entries(tokens).map(([name, token]) => [
      JSON.stringify(token.$value),
      { $token: `${prefix}.${name}` },
    ]),
  );
}

function bindDeclValues(
  decl: Record<string, unknown>,
  maps: {
    color: Map<string, { $token: string }>;
    spacing: Map<string, { $token: string }>;
    radius: Map<string, { $token: string }>;
    fontSize: Map<string, { $token: string }>;
    fontFamily: Map<string, { $token: string }>;
  },
): void {
  decl.color = bind(decl.color, maps.color);
  const fills = decl.fills as Array<{ type?: string; color?: unknown }> | undefined;
  for (const fill of fills ?? [])
    if (fill.type === 'solid') fill.color = bind(fill.color, maps.color);
  const border = decl.border as { color?: unknown } | undefined;
  if (border) border.color = bind(border.color, maps.color);
  const shadows = decl.shadows as Array<{ color?: unknown }> | undefined;
  for (const shadow of shadows ?? []) shadow.color = bind(shadow.color, maps.color);
  for (const field of ['padding', 'margin'] as const) {
    const box = decl[field] as Record<string, unknown> | undefined;
    for (const key of Object.keys(box ?? {})) box![key] = bind(box![key], maps.spacing);
  }
  const gap = decl.gap as Record<string, unknown> | undefined;
  for (const key of Object.keys(gap ?? {})) gap![key] = bind(gap![key], maps.spacing);
  const radius = decl.radius as Record<string, unknown> | undefined;
  for (const key of Object.keys(radius ?? {})) radius![key] = bind(radius![key], maps.radius);
  decl.fontSize = bind(decl.fontSize, maps.fontSize);
  decl.fontFamily = bind(decl.fontFamily, maps.fontFamily);
}

function bind(value: unknown, map: Map<string, { $token: string }>): unknown {
  if (value === undefined || isToken(value)) return value;
  return map.get(JSON.stringify(value)) ?? value;
}

function isToken(value: unknown): value is { $token: string } {
  return typeof value === 'object' && value !== null && '$token' in value;
}

function isLength(value: unknown): value is { value: number; unit: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { value?: unknown }).value === 'number' &&
    typeof (value as { unit?: unknown }).unit === 'string'
  );
}

function removeUndefined<T extends object>(value: T): T {
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (record[key] === undefined) delete record[key];
  }
  return value;
}

function titleCase(value: string): string {
  return value ? value[0]!.toUpperCase() + value.slice(1) : 'Element';
}
