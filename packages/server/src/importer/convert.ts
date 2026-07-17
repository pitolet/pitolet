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
  type Fill,
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
  'font/woff': 'woff',
  'font/woff2': 'woff2',
};

export function assetIdFor(data: Buffer, mime: string): string {
  const ext = MIME_EXT[mime];
  if (!ext) throw new Error(`unsupported captured asset type ${mime}`);
  return `${createHash('sha256').update(data).digest('hex')}.${ext}`;
}

export function convertCapture(capture: WebCapture, name?: string): ImportConversion {
  if (capture.snapshots.length < 1) throw new Error('capture contains no viewport snapshots');
  const snapshots = [...capture.snapshots].sort((a, b) => a.width - b.width);
  const base = snapshots[0]!;
  const widest = snapshots.at(-1)!;
  const rootKey = base.rootKey;
  const breakpointWidths = [
    ...new Set(capture.breakpointWidths ?? snapshots.slice(1).map((s) => s.width)),
  ]
    .filter((width) => width > base.width && snapshots.some((snapshot) => snapshot.width === width))
    .sort((left, right) => left - right);
  if (!snapshots.every((s) => s.rootKey === rootKey)) {
    capture.warnings.push('selected root could not be matched identically across every viewport');
  }

  const document = createDocument({ name: name?.trim() || capture.title || 'Imported website' });
  document.breakpoints = breakpointWidths.map((width) => ({
    id: importedBreakpointId(width),
    name: importedBreakpointName(width),
    minWidth: width,
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
  for (const family of capture.fonts.map(cleanFont).filter(Boolean)) {
    if (
      Object.values(document.tokens.typography.fontFamily).some((token) => token.$value === family)
    ) {
      continue;
    }
    const baseName =
      family
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '') || 'font';
    let name = baseName;
    let suffix = 2;
    while (document.tokens.typography.fontFamily[name]) name = `${baseName}-${suffix++}`;
    document.tokens.typography.fontFamily[name] = { $value: family };
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
      ...(asset.fontFace
        ? {
            fontFace: {
              family: asset.fontFace.family,
              ...(asset.fontFace.style ? { style: asset.fontFace.style } : {}),
              ...(asset.fontFace.weight ? { weight: asset.fontFace.weight } : {}),
              ...(asset.fontFace.display ? { display: asset.fontFace.display } : {}),
            },
          }
        : {}),
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
    const node = snapshots.map((s) => s.nodes[key]).find(Boolean);
    if (node) canonical.set(key, { ...node, children: unionChildren(key, snapshots) });
  }
  const reparentedNodes = [...allKeys].filter((key) => {
    const parents = new Set(
      snapshots.map((snapshot) => snapshot.nodes[key]?.parentKey).filter((value) => value != null),
    );
    return parents.size > 1;
  });
  if (reparentedNodes.length > 0) {
    capture.warnings.push(
      `${reparentedNodes.length} nodes move between parents across viewports; the mobile DOM position was kept`,
    );
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
  if (!rootCapture.unsupportedReason)
    applyResponsiveStyles(frame, rootKey, snapshots, breakpointWidths);
  attach(document, null, frame);

  let rasterizedRegions = 0;
  const emitted = new Set<string>([rootKey]);

  if (rootCapture.unsupportedReason) {
    const rootImages = convertRasterNodes(
      rootCapture,
      rootKey,
      snapshots,
      breakpointWidths,
      assetIds,
    );
    if (rootImages.length === 0) throw new Error('captured root could not be rasterized');
    for (const rootImage of rootImages) attach(document, frame.id, rootImage);
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
      if (captured.unsupportedReason) {
        const rasterNodes = convertRasterNodes(
          captured,
          childKey,
          snapshots,
          breakpointWidths,
          assetIds,
        );
        for (const rasterNode of rasterNodes) attach(document, parentId, rasterNode);
        if (rasterNodes.length > 0) rasterizedRegions += 1;
        continue;
      }
      const pitoletNode = convertNode(captured, childKey, snapshots, breakpointWidths, assetIds);
      if (!pitoletNode) continue;
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
  breakpointWidths: number[],
  assetIds: Map<string, string>,
): PitoletNode | null {
  const styles = styleForKey(key, 0, snapshots);
  let node: PitoletNode;

  if (captured.tag === 'img' && captured.assetUrl) {
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
  applyResponsiveStyles(node, key, snapshots, breakpointWidths);
  return node;
}

function convertRasterNodes(
  captured: CapturedNode,
  key: string,
  snapshots: WebCapture['snapshots'],
  breakpointWidths: number[],
  assetIds: Map<string, string>,
): PitoletNode[] {
  const result: PitoletNode[] = [];
  const available = snapshots
    .map((snapshot, index) => ({
      snapshot,
      index,
      captured: snapshot.nodes[key],
      assetId: assetIds.get(`raster:${key}:${snapshot.width}`),
    }))
    .filter(
      (
        entry,
      ): entry is {
        snapshot: WebCapture['snapshots'][number];
        index: number;
        captured: CapturedNode;
        assetId: string;
      } => !!entry.captured && !!entry.assetId,
    );

  for (let variantIndex = 0; variantIndex < available.length; variantIndex++) {
    const entry = available[variantIndex]!;
    const isMobileBase = entry.index === 0;
    const activeDisplay = styleForKey(key, entry.index, snapshots).display ?? 'block';
    const baseStyles = styleForKey(key, entry.index, snapshots);
    if (!isMobileBase) baseStyles.display = 'none';
    const image = createImage({
      name:
        variantIndex === 0
          ? captured.name || `Rasterized ${captured.tag}`
          : `${captured.name || captured.tag} fallback ${entry.snapshot.width}px`,
      src: { asset: entry.assetId },
      alt: captured.attrs.alt ?? '',
      styles: baseStyles,
    });
    const activationWidth = isMobileBase ? undefined : entry.snapshot.width;
    const nextWidth = available[variantIndex + 1]?.snapshot.width;
    if (activationWidth !== undefined || nextWidth !== undefined) {
      image.styles.breakpoints ??= {};
      if (activationWidth !== undefined && breakpointWidths.includes(activationWidth)) {
        image.styles.breakpoints[importedBreakpointId(activationWidth)] = {
          display: activeDisplay,
        };
      }
      if (nextWidth !== undefined && breakpointWidths.includes(nextWidth)) {
        image.styles.breakpoints[importedBreakpointId(nextWidth)] = { display: 'none' };
      }
    }
    result.push(image);
  }
  return result;
}

function applyResponsiveStyles(
  node: PitoletNode,
  key: string,
  snapshots: WebCapture['snapshots'],
  breakpointWidths: number[],
): void {
  let previous = styleForKey(key, 0, snapshots);
  for (const width of breakpointWidths) {
    const i = snapshots.findIndex((snapshot) => snapshot.width === width);
    if (i < 0) continue;
    const current = styleForKey(key, i, snapshots);
    const patch = diffStyle(previous, current);
    if (Object.keys(patch).length > 0) {
      node.styles.breakpoints ??= {};
      node.styles.breakpoints[importedBreakpointId(width)] = patch;
    }
    previous = current;
  }
}

function styleForKey(key: string, index: number, snapshots: WebCapture['snapshots']): StyleDecl {
  const snapshot = snapshots[index]!;
  const node = snapshot.nodes[key];
  if (!node) return { display: 'none' };
  const decl = capturedStylesToDecl(
    node.styles,
    node.rect,
    node.tag,
    node.unsupportedReason !== undefined,
  );
  const parent = node.parentKey ? snapshot.nodes[node.parentKey] : undefined;
  const fluidImage = node.tag === 'img' && imageKeepsAspectRatio(key, snapshots);
  if (parent && shouldFillAvailableWidth(node, parent) && (node.tag !== 'img' || fluidImage)) {
    decl.width = 'fill';
    if (fluidImage) decl.height = 'auto';
    const alignment = inferConstrainedFillAlignment(node, parent);
    if (alignment) decl.alignSelf = alignment;
  }
  return decl;
}

/**
 * Computed styles expose used pixel widths, not whether the source asked a
 * block to fill its container. Recreate that intent from the captured
 * geometry so centered flex sections and max-width content columns do not
 * collapse to their intrinsic width after import.
 */
export function shouldFillAvailableWidth(node: CapturedNode, parent: CapturedNode): boolean {
  if (
    node.kind === 'text' ||
    TEXT_TAGS.has(node.tag) ||
    node.unsupportedReason !== undefined ||
    ['absolute', 'fixed'].includes(node.styles.position ?? '') ||
    (node.tag !== 'img' && ['inline', 'inline-flex', 'none'].includes(node.styles.display ?? ''))
  ) {
    return false;
  }

  const parentInnerWidth = Math.max(
    0,
    parent.rect.width -
      finiteNumber(parent.styles.paddingLeft, 0) -
      finiteNumber(parent.styles.paddingRight, 0),
  );
  if (near(node.rect.width, parentInnerWidth)) return true;

  const maxWidth = finiteLength(node.styles.maxWidth);
  return (
    maxWidth !== null &&
    maxWidth > 0 &&
    parentInnerWidth >= maxWidth - 2 &&
    near(node.rect.width, maxWidth)
  );
}

function imageKeepsAspectRatio(key: string, snapshots: WebCapture['snapshots']): boolean {
  const rects = snapshots
    .map((snapshot) => snapshot.nodes[key]?.rect)
    .filter((rect): rect is CaptureRect => !!rect && rect.width > 0 && rect.height > 0);
  if (rects.length < 2) return false;

  const widths = rects.map((rect) => rect.width);
  if (Math.max(...widths) - Math.min(...widths) <= 2) return false;
  const ratios = rects.map((rect) => rect.width / rect.height);
  const smallestRatio = Math.min(...ratios);
  return Math.max(...ratios) - smallestRatio <= Math.max(0.01, smallestRatio * 0.01);
}

function importedBreakpointId(width: number): string {
  return `import-${width}`;
}

function importedBreakpointName(width: number): string {
  const familiarNames: Record<number, string> = {
    640: 'Small',
    768: 'Tablet',
    1024: 'Desktop',
    1280: 'Wide',
    1440: 'Wide',
  };
  return familiarNames[width] ?? `${width}px`;
}

/**
 * A computed `align-self: stretch` does not tell us where a max-width flex
 * item actually sat. Recover that intent from its captured bounds so a
 * centered `width: 100%; max-width: ...` wrapper stays centered after import.
 */
export function inferConstrainedFillAlignment(
  node: CapturedNode,
  parent: CapturedNode,
): 'start' | 'center' | 'end' | undefined {
  if (
    parent.styles.display !== 'flex' ||
    !['column', 'column-reverse'].includes(parent.styles.flexDirection ?? '')
  ) {
    return undefined;
  }

  const maxWidth = finiteLength(node.styles.maxWidth);
  if (maxWidth === null || maxWidth <= 0 || !near(node.rect.width, maxWidth)) return undefined;

  const innerStart = parent.rect.x + finiteNumber(parent.styles.paddingLeft, 0);
  const innerEnd = parent.rect.x + parent.rect.width - finiteNumber(parent.styles.paddingRight, 0);
  const freeSpace = innerEnd - innerStart - node.rect.width;
  if (freeSpace <= 2) return undefined;

  const startSpace = node.rect.x - innerStart;
  const endSpace = innerEnd - (node.rect.x + node.rect.width);
  const tolerance = Math.max(2, freeSpace * 0.02);

  if (Math.abs(startSpace - endSpace) <= tolerance) return 'center';
  if (Math.abs(startSpace) <= tolerance) return 'start';
  if (Math.abs(endSpace) <= tolerance) return 'end';
  return undefined;
}

function near(left: number, right: number): boolean {
  return Math.abs(left - right) <= Math.max(2, Math.min(left, right) * 0.005);
}

function finiteLength(value?: string): number | null {
  if (!value || value === 'none' || value.endsWith('%')) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function capturedStylesToDecl(
  styles: CapturedStyles,
  rect: CaptureRect,
  tag: string,
  forceSize = false,
): StyleDecl {
  const display = displayValue(styles.display);
  const backgroundColor =
    parseColor(styles.backgroundColor || 'transparent') ?? parseColor('transparent')!;
  const gradient = parseGradientFill(styles.backgroundImage);
  const fills: Fill[] = gradient
    ? backgroundColor.alpha === undefined || backgroundColor.alpha > 0
      ? [{ type: 'solid', color: backgroundColor }, gradient]
      : [gradient]
    : [{ type: 'solid', color: backgroundColor }];
  const position = ['static', 'relative', 'absolute', 'sticky'].includes(styles.position ?? '')
    ? (styles.position as 'static' | 'relative' | 'absolute' | 'sticky')
    : undefined;
  const decl: StyleDecl = {
    display,
    flexDirection: flexDirectionValue(styles.flexDirection),
    flexWrap: flexWrapValue(styles.flexWrap),
    alignItems: alignValue(styles.alignItems),
    justifyContent: justifyValue(styles.justifyContent),
    gap: { row: length(styles.rowGap), column: length(styles.columnGap) },
    alignSelf: alignSelfValue(styles.alignSelf),
    flexGrow: finiteNumber(styles.flexGrow, 0),
    padding: sides4(styles, 'padding'),
    margin: sides4(styles, 'margin'),
    position,
    fontFamily: cleanFont(styles.fontFamily),
    fontSize: length(styles.fontSize),
    fontWeight: clamp(finiteNumber(styles.fontWeight, 400), 1, 1000),
    lineHeight: lineHeightValue(styles.lineHeight, styles.fontSize),
    letterSpacing: length(styles.letterSpacing),
    textAlign: textAlign(styles.textAlign),
    color: parseColor(styles.color || 'transparent') ?? undefined,
    fills,
    border: borderValue(styles),
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

  decl.shadows = parseShadows(styles.boxShadow);
  decl.blendMode = styles.mixBlendMode || 'normal';

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
  decl.gridTemplateRows = rowTracks;
  decl.gridTemplateColumns = columnTracks;
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
  } else if (tag !== '#text') {
    decl.width = 'auto';
    if (styles.maxWidth && styles.maxWidth !== 'none') decl.maxWidth = length(styles.maxWidth);
    if (styles.minWidth && parseFloat(styles.minWidth) > 0) decl.minWidth = length(styles.minWidth);
    if (display === 'inline') decl.width = px(Math.max(1, round(rect.width)));
  }
  return removeUndefined(decl);
}

/** Parse the single linear/radial gradients supported by Pitolet fills. */
export function parseGradientFill(value?: string): Fill | null {
  const input = value?.trim();
  if (!input || input === 'none') return null;
  const match = /^(linear|radial)-gradient\((.*)\)$/is.exec(input);
  if (!match) return null;

  const kind = match[1]!;
  const parts = splitCssList(match[2]!);
  if (parts.length < 2) return null;

  let angle = 180;
  if (kind === 'linear') {
    const parsedAngle = gradientAngle(parts[0]!);
    if (parsedAngle !== null) {
      angle = parsedAngle;
      parts.shift();
    }
  } else if (!parseGradientStop(parts[0]!)) {
    // Shapes and positions are not represented in the schema yet. Pitolet's
    // radial fill is centered and circular, which matches the common case.
    parts.shift();
  }

  const parsedStops = parts.map(parseGradientStop);
  if (parsedStops.some((stop) => stop === null)) return null;
  const stops = interpolateStopPositions(
    parsedStops as Array<{
      color: NonNullable<ReturnType<typeof parseColor>>;
      position: number | null;
    }>,
  );
  if (stops.length < 2) return null;
  return kind === 'linear' ? { type: 'linear', angle, stops } : { type: 'radial', stops };
}

function splitCssList(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (character === '(') depth += 1;
    else if (character === ')') depth -= 1;
    else if (character === ',' && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts.filter(Boolean);
}

function gradientAngle(value: string): number | null {
  const input = value.trim().toLowerCase();
  const degrees = /^(-?\d+(?:\.\d+)?)deg$/.exec(input);
  if (degrees) return normalizeAngle(Number(degrees[1]));
  const turns = /^(-?\d+(?:\.\d+)?)turn$/.exec(input);
  if (turns) return normalizeAngle(Number(turns[1]) * 360);
  const directions: Record<string, number> = {
    'to top': 0,
    'to top right': 45,
    'to right top': 45,
    'to right': 90,
    'to bottom right': 135,
    'to right bottom': 135,
    'to bottom': 180,
    'to bottom left': 225,
    'to left bottom': 225,
    'to left': 270,
    'to top left': 315,
    'to left top': 315,
  };
  return directions[input] ?? null;
}

function normalizeAngle(value: number): number {
  return ((value % 360) + 360) % 360;
}

function parseGradientStop(value: string): {
  color: NonNullable<ReturnType<typeof parseColor>>;
  position: number | null;
} | null {
  const match = /^(.*?)(?:\s+(-?\d+(?:\.\d+)?)%)?$/.exec(value.trim());
  if (!match) return null;
  const color = parseColor(match[1]!.trim());
  if (!color) return null;
  return {
    color,
    position: match[2] === undefined ? null : clamp(Number(match[2]) / 100, 0, 1),
  };
}

function interpolateStopPositions(
  input: Array<{
    color: NonNullable<ReturnType<typeof parseColor>>;
    position: number | null;
  }>,
): Array<{ color: NonNullable<ReturnType<typeof parseColor>>; position: number }> {
  const stops = input.map((stop) => ({ ...stop }));
  if (stops[0]!.position === null) stops[0]!.position = 0;
  if (stops.at(-1)!.position === null) stops.at(-1)!.position = 1;

  let anchor = 0;
  while (anchor < stops.length - 1) {
    let next = anchor + 1;
    while (next < stops.length && stops[next]!.position === null) next += 1;
    if (next >= stops.length) break;
    const start = stops[anchor]!.position!;
    const end = Math.max(start, stops[next]!.position!);
    for (let index = anchor + 1; index < next; index++) {
      stops[index]!.position = start + ((end - start) * (index - anchor)) / (next - anchor);
    }
    anchor = next;
  }
  return stops as Array<{
    color: NonNullable<ReturnType<typeof parseColor>>;
    position: number;
  }>;
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
  const sanitized = Object.fromEntries(
    Object.entries(attrs).filter(([key, value]) => {
      if (!(INERT_ATTRS.has(key) || key.startsWith('aria-'))) return false;
      if (key === 'href' && !isSafeNavigationUrl(value)) return false;
      if (['checked', 'disabled', 'selected'].includes(key) && value === 'false') return false;
      return true;
    }),
  );
  if (sanitized.target === '_blank') {
    const rel = new Set((sanitized.rel ?? '').split(/\s+/).filter(Boolean));
    rel.add('noopener');
    rel.add('noreferrer');
    sanitized.rel = [...rel].join(' ');
  }
  return sanitized;
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

function lineHeightValue(value?: string, fontSize?: string): StyleDecl['lineHeight'] {
  if (!value || value === 'normal') return 1.2;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return 1.2;
  if (/^-?\d*\.?\d+$/.test(value.trim())) return parsed;
  if (value.endsWith('px')) return px(round(parsed));
  const size = Number.parseFloat(fontSize ?? '');
  return Number.isFinite(size) && size > 0 ? round(parsed / size) : px(round(parsed));
}

function flexDirectionValue(value?: string): NonNullable<StyleDecl['flexDirection']> {
  if (
    value === 'row' ||
    value === 'row-reverse' ||
    value === 'column' ||
    value === 'column-reverse'
  ) {
    return value;
  }
  return 'column';
}

function flexWrapValue(value?: string): NonNullable<StyleDecl['flexWrap']> {
  if (value === 'wrap' || value === 'wrap-reverse') return value;
  return 'nowrap';
}

function borderValue(styles: CapturedStyles): NonNullable<StyleDecl['border']> {
  const sides = (['Top', 'Right', 'Bottom', 'Left'] as const).map((side) => ({
    side: side.toLowerCase() as 'top' | 'right' | 'bottom' | 'left',
    width: finiteNumber(styles[`border${side}Width`], 0),
    style: styles[`border${side}Style`],
    color: styles[`border${side}Color`],
  }));
  const active = sides.filter((side) => side.width > 0 && side.style !== 'none');
  const representative = active[0] ?? sides[0]!;
  const border: NonNullable<StyleDecl['border']> = {
    width: px(round(representative.width)),
    style: borderStyle(representative.style),
    color: parseColor(representative.color || 'transparent') ?? parseColor('transparent')!,
  };
  if (active.length > 0 && active.length < 4) {
    border.sides = Object.fromEntries(
      sides.map((side) => [side.side, active.some((entry) => entry.side === side.side)]),
    );
  }
  return border;
}

function isSafeNavigationUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (
    trimmed.startsWith('/') ||
    trimmed.startsWith('./') ||
    trimmed.startsWith('../') ||
    trimmed.startsWith('#') ||
    trimmed.startsWith('?')
  ) {
    return true;
  }
  try {
    const parsed = new URL(trimmed);
    return ['http:', 'https:', 'mailto:', 'tel:'].includes(parsed.protocol);
  } catch {
    return false;
  }
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

function alignSelfValue(value?: string): NonNullable<StyleDecl['alignSelf']> {
  if (!value || value === 'auto') return 'auto';
  return alignValue(value);
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
