import { z } from 'zod';
import { SCHEMA_VERSION, type PitoletDocument } from './document.js';
import { parseVariantKey } from './components.js';
import type { PitoletNode } from './nodes.js';
import { isAncestor, subtreeIds } from './traverse.js';

/**
 * Runtime validation for the whole document format. The server revalidates
 * every node a patch touches; MCP tool inputs validate before entering the
 * patch pipeline; documents validate fully on load.
 */

// --- primitives ---

export const zTokenRef = z.object({ $token: z.string().min(1) }).strict();

const sv = <T extends z.ZodType>(t: T) => z.union([t, zTokenRef]);

export const zLength = z
  .object({
    value: z.number().finite(),
    unit: z.enum(['px', 'rem', 'em', '%', 'vw', 'vh']),
  })
  .strict();

export const zColor = z
  .object({
    space: z.literal('oklch'),
    l: z.number().finite().min(0).max(1),
    c: z.number().finite().min(0),
    h: z.number().finite(),
    alpha: z.number().finite().min(0).max(1).optional(),
  })
  .strict();

const zSize = z.union([zLength, z.literal('auto'), z.literal('fill')]);

const zSidesLength = z
  .object({
    top: sv(zLength),
    right: sv(zLength),
    bottom: sv(zLength),
    left: sv(zLength),
  })
  .strict();

const zGradientStop = z
  .object({
    color: sv(zColor),
    position: z.number().finite().min(0).max(1),
  })
  .strict();

const zFill = z.discriminatedUnion('type', [
  z.object({ type: z.literal('solid'), color: sv(zColor) }).strict(),
  z
    .object({
      type: z.literal('linear'),
      angle: z.number().finite(),
      stops: z.array(zGradientStop).min(2),
    })
    .strict(),
  z.object({ type: z.literal('radial'), stops: z.array(zGradientStop).min(2) }).strict(),
]);

const zShadow = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    blur: z.number().finite().min(0),
    spread: z.number().finite(),
    color: sv(zColor),
    inset: z.literal(true).optional(),
  })
  .strict();

const zTrack = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('fr'), value: z.number().finite().positive() }).strict(),
  z.object({ kind: z.literal('px'), value: z.number().finite().positive() }).strict(),
  z.object({ kind: z.literal('auto') }).strict(),
  z
    .object({
      kind: z.literal('minmax'),
      min: z.number().finite().min(0),
      max: z
        .object({
          kind: z.enum(['fr', 'px']),
          value: z.number().finite().positive(),
        })
        .strict(),
    })
    .strict(),
]);

const zAlign = z.enum(['start', 'center', 'end', 'stretch', 'baseline']);
const zAlignSelf = z.enum(['auto', 'start', 'center', 'end', 'stretch', 'baseline']);
const zJustify = z.enum(['start', 'center', 'end', 'between', 'around', 'evenly']);

export const zStyleDecl = z
  .object({
    display: z.enum(['flex', 'grid', 'block', 'inline', 'none']),
    flexDirection: z.enum(['row', 'row-reverse', 'column', 'column-reverse']),
    flexWrap: z.enum(['wrap', 'nowrap', 'wrap-reverse']),
    alignItems: zAlign,
    justifyContent: zJustify,
    gap: z.object({ row: sv(zLength), column: sv(zLength) }).strict(),
    gridTemplateColumns: z.array(zTrack),
    gridTemplateRows: z.array(zTrack),
    alignSelf: zAlignSelf,
    flexGrow: z.number().finite().min(0),
    gridColumn: z.string(),
    gridRow: z.string(),
    padding: zSidesLength,
    margin: zSidesLength,
    width: sv(zSize),
    height: sv(zSize),
    minWidth: sv(zSize),
    maxWidth: sv(zSize),
    minHeight: sv(zSize),
    maxHeight: sv(zSize),
    position: z.enum(['static', 'relative', 'absolute', 'sticky']),
    inset: zSidesLength.partial(),
    zIndex: z.number().int(),
    fontFamily: sv(z.string()),
    fontSize: sv(zLength),
    fontWeight: sv(z.number().finite().min(1).max(1000)),
    lineHeight: sv(z.union([z.number().finite(), zLength])),
    letterSpacing: sv(zLength),
    textAlign: z.enum(['left', 'center', 'right', 'justify']),
    color: sv(zColor),
    fills: z.array(zFill),
    border: z
      .object({
        width: sv(zLength),
        style: z.enum(['solid', 'dashed', 'dotted']),
        color: sv(zColor),
        sides: z
          .object({ top: z.boolean(), right: z.boolean(), bottom: z.boolean(), left: z.boolean() })
          .partial()
          .strict()
          .optional(),
      })
      .strict(),
    radius: z
      .object({ tl: sv(zLength), tr: sv(zLength), br: sv(zLength), bl: sv(zLength) })
      .strict(),
    shadows: z.array(zShadow),
    opacity: z.number().finite().min(0).max(1),
    blendMode: z.string(),
    overflow: z.enum(['visible', 'hidden', 'auto', 'scroll']),
    cursor: z.string(),
    objectFit: z.enum(['cover', 'contain', 'fill', 'none']),
  })
  .partial()
  .strict();

export const zStyleSheet = z
  .object({
    base: zStyleDecl,
    breakpoints: z.record(z.string(), zStyleDecl).optional(),
    states: z
      .object({ hover: zStyleDecl, focus: zStyleDecl, active: zStyleDecl })
      .partial()
      .strict()
      .optional(),
  })
  .strict();

// --- nodes ---

const zTextSpan = z
  .object({
    text: z.string(),
    marks: z
      .object({
        bold: z.literal(true).optional(),
        italic: z.literal(true).optional(),
        link: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const zImageSrc = z.union([
  z.object({ asset: z.string() }).strict(),
  z.object({ url: z.string() }).strict(),
]);

const nodeBase = {
  id: z.string().min(1),
  name: z.string(),
  parent: z.string().nullable(),
  children: z.array(z.string()),
  tag: z.string().min(1),
  visible: z.boolean(),
  locked: z.boolean(),
  styles: zStyleSheet,
  attrs: z.record(z.string(), z.string()).optional(),
};

export const zFrameNode = z
  .object({
    ...nodeBase,
    type: z.literal('frame'),
    canvas: z
      .object({
        x: z.number().finite(),
        y: z.number().finite(),
        width: z.number().finite().positive(),
        height: z.union([z.number().finite().positive(), z.literal('auto')]),
      })
      .strict(),
    isComponentMaster: z.string().optional(),
  })
  .strict();

export const zElementNode = z.object({ ...nodeBase, type: z.literal('element') }).strict();

export const zTextNode = z
  .object({
    ...nodeBase,
    type: z.literal('text'),
    content: z.array(zTextSpan),
  })
  .strict();

export const zImageNode = z
  .object({
    ...nodeBase,
    type: z.literal('image'),
    src: zImageSrc,
    alt: z.string(),
  })
  .strict();

const zInstanceOverride = z
  .object({
    content: z.array(zTextSpan).optional(),
    src: zImageSrc.optional(),
    styles: zStyleDecl.optional(),
    visible: z.boolean().optional(),
  })
  .strict();

export const zInstanceNode = z
  .object({
    ...nodeBase,
    type: z.literal('instance'),
    componentId: z.string(),
    variant: z.record(z.string(), z.string()),
    overrides: z.record(z.string(), zInstanceOverride),
  })
  .strict();

export const zNode = z.discriminatedUnion('type', [
  zFrameNode,
  zElementNode,
  zTextNode,
  zImageNode,
  zInstanceNode,
]);

// --- tokens ---

const token = <T extends z.ZodType>(t: T) =>
  z.object({ $value: t, $description: z.string().optional() }).strict();

export const zTokenSet = z
  .object({
    color: z.record(z.string(), token(zColor)),
    spacing: z.record(z.string(), token(zLength)),
    radius: z.record(z.string(), token(zLength)),
    shadow: z.record(z.string(), token(z.array(zShadow))),
    typography: z
      .object({
        fontFamily: z.record(z.string(), token(z.string())),
        fontSize: z.record(z.string(), token(zLength)),
      })
      .strict(),
  })
  .strict();

// --- components / document ---

export const zComponentDef = z
  .object({
    id: z.string(),
    name: z.string().min(1),
    rootId: z.string(),
    contentRootId: z.string(),
    variantProps: z.array(
      z
        .object({
          name: z.string().min(1),
          values: z.array(z.string().min(1)).min(1),
          default: z.string().min(1),
        })
        .strict(),
    ),
    variants: z.record(
      z.string(),
      z.record(
        z.string(),
        z.object({ styles: zStyleDecl.optional(), visible: z.boolean().optional() }).strict(),
      ),
    ),
  })
  .strict();

export const zBreakpoint = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    minWidth: z.number().finite().positive(),
  })
  .strict();

export const zAsset = z
  .object({
    fileName: z.string(),
    width: z.number().finite().nonnegative(),
    height: z.number().finite().nonnegative(),
    mime: z.string(),
    fontFace: z
      .object({
        family: z.string().min(1).max(200),
        style: z.string().max(40).optional(),
        weight: z.string().max(40).optional(),
        display: z.string().max(40).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const zComment = z
  .object({
    id: z.string().min(1),
    nodeId: z.string().min(1),
    text: z.string().min(1),
    author: z.string().min(1),
    createdAt: z.number().finite(),
    resolved: z.literal(true).optional(),
  })
  .strict();

export const zDocument = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    id: z.string().min(1),
    name: z.string(),
    rootOrder: z.array(z.string()),
    nodes: z.record(z.string(), zNode),
    components: z.record(z.string(), zComponentDef),
    tokens: zTokenSet,
    breakpoints: z.array(zBreakpoint),
    assets: z.record(z.string(), zAsset),
    comments: z.record(z.string(), zComment).optional(),
  })
  .strict();

// --- entry points ---

export const DOCUMENT_LIMITS = {
  maxNodes: 10_000,
  maxDepth: 100,
  maxComponents: 1_000,
  maxAssets: 10_000,
  maxComments: 10_000,
  maxBreakpoints: 32,
} as const;

const VOID_ELEMENT_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

export interface DocumentStructureLimits {
  maxNodes?: number;
  maxDepth?: number;
  maxComponents?: number;
  maxAssets?: number;
  maxComments?: number;
  maxBreakpoints?: number;
}

export function validateDocument(raw: unknown): PitoletDocument {
  const document = zDocument.parse(raw) as PitoletDocument;
  const problems = structuralProblems(document);
  if (problems.length > 0) {
    throw new Error(`invalid document structure: ${problems[0]}`);
  }
  return document;
}

export function validateNode(raw: unknown): PitoletNode {
  return zNode.parse(raw) as PitoletNode;
}

/**
 * Structural coherence beyond per-node shape. This is intentionally shared
 * by file loading, imports and the authoritative patch pipeline so a document
 * cannot enter through one path with weaker invariants than another.
 *
 * Returns human-readable problems (empty = coherent). It is cycle-safe even
 * when called on hostile or already-corrupt input.
 */
export function structuralProblems(
  doc: PitoletDocument,
  overrides: DocumentStructureLimits = {},
): string[] {
  const limits = { ...DOCUMENT_LIMITS, ...overrides };
  const problems: string[] = [];
  const nodeIds = Object.keys(doc.nodes);
  const componentIds = Object.keys(doc.components);
  const assetIds = Object.keys(doc.assets);
  const commentIds = Object.keys(doc.comments ?? {});

  if (nodeIds.length > limits.maxNodes) {
    problems.push(`document has ${nodeIds.length} nodes; maximum is ${limits.maxNodes}`);
  }
  if (componentIds.length > limits.maxComponents) {
    problems.push(
      `document has ${componentIds.length} components; maximum is ${limits.maxComponents}`,
    );
  }
  if (assetIds.length > limits.maxAssets) {
    problems.push(`document has ${assetIds.length} assets; maximum is ${limits.maxAssets}`);
  }
  if (commentIds.length > limits.maxComments) {
    problems.push(`document has ${commentIds.length} comments; maximum is ${limits.maxComments}`);
  }
  if (doc.breakpoints.length > limits.maxBreakpoints) {
    problems.push(
      `document has ${doc.breakpoints.length} breakpoints; maximum is ${limits.maxBreakpoints}`,
    );
  }

  const rootIds = new Set<string>();
  for (const rootId of doc.rootOrder) {
    if (rootIds.has(rootId)) problems.push(`rootOrder repeats node ${rootId}`);
    rootIds.add(rootId);
    const node = doc.nodes[rootId];
    if (!node) problems.push(`rootOrder references missing node ${rootId}`);
    else if (node.parent !== null) problems.push(`root node ${rootId} has non-null parent`);
    else if (node.type !== 'frame') problems.push(`root node ${rootId} is not a frame`);
  }

  const breakpointIds = new Set<string>();
  const breakpointWidths = new Set<number>();
  let previousBreakpointWidth = -Infinity;
  for (const breakpoint of doc.breakpoints) {
    if (breakpointIds.has(breakpoint.id)) {
      problems.push(`breakpoints repeat id ${breakpoint.id}`);
    }
    breakpointIds.add(breakpoint.id);
    if (breakpointWidths.has(breakpoint.minWidth)) {
      problems.push(`breakpoints repeat minimum width ${breakpoint.minWidth}`);
    }
    breakpointWidths.add(breakpoint.minWidth);
    if (breakpoint.minWidth <= previousBreakpointWidth) {
      problems.push('breakpoints must be sorted by strictly increasing minimum width');
    }
    previousBreakpointWidth = breakpoint.minWidth;
  }

  const childOwner = new Map<string, string>();
  for (const [id, node] of Object.entries(doc.nodes)) {
    if (node.id !== id) problems.push(`node key ${id} != node.id ${node.id}`);
    if (node.parent !== null) {
      const parent = doc.nodes[node.parent];
      if (!parent) problems.push(`node ${id} has missing parent ${node.parent}`);
      else if (!parent.children.includes(id))
        problems.push(`node ${id} not listed in parent ${node.parent} children`);
    } else if (node.type === 'frame' && !doc.rootOrder.includes(id) && !node.isComponentMaster) {
      // Component masters may live outside rootOrder only if referenced by a component.
      const referenced = Object.values(doc.components).some((c) => c.rootId === id);
      if (!referenced) problems.push(`top-level frame ${id} missing from rootOrder`);
    }
    const localChildren = new Set<string>();
    if (VOID_ELEMENT_TAGS.has(node.tag.toLowerCase()) && node.children.length > 0) {
      problems.push(`void element ${id} (${node.tag}) cannot contain children`);
    }
    if (
      (node.type === 'text' || node.type === 'image' || node.type === 'instance') &&
      node.children.length > 0
    ) {
      problems.push(`${node.type} node ${id} cannot contain children`);
    }
    if (node.type === 'text' && VOID_ELEMENT_TAGS.has(node.tag.toLowerCase())) {
      problems.push(`text node ${id} cannot use void tag ${node.tag}`);
    }
    for (const childId of node.children) {
      if (localChildren.has(childId)) problems.push(`node ${id} repeats child ${childId}`);
      localChildren.add(childId);
      const previousOwner = childOwner.get(childId);
      if (previousOwner && previousOwner !== id) {
        problems.push(`node ${childId} is referenced by both ${previousOwner} and ${id}`);
      } else if (!previousOwner) {
        childOwner.set(childId, id);
      }
      const child = doc.nodes[childId];
      if (!child) problems.push(`node ${id} references missing child ${childId}`);
      else if (child.parent !== id)
        problems.push(`child ${childId} of ${id} has parent ${child.parent}`);
    }
    for (const breakpointId of Object.keys(node.styles.breakpoints ?? {})) {
      if (!breakpointIds.has(breakpointId)) {
        problems.push(`node ${id} uses unknown breakpoint ${breakpointId}`);
      }
    }
    if (node.type === 'image' && 'asset' in node.src && !doc.assets[node.src.asset]) {
      problems.push(`image ${id} references undeclared asset ${node.src.asset}`);
    }
    if (node.type === 'instance' && !doc.components[node.componentId])
      problems.push(`instance ${id} references missing component ${node.componentId}`);
  }

  for (const [commentId, comment] of Object.entries(doc.comments ?? {})) {
    if (comment.id !== commentId) {
      problems.push(`comment key ${commentId} != comment.id ${comment.id}`);
    }
    if (!doc.nodes[comment.nodeId]) {
      problems.push(`comment ${commentId} references missing node ${comment.nodeId}`);
    }
  }

  // Traverse every public root and component root first. A second pass over
  // unvisited nodes finds cycles even inside an otherwise unreachable island.
  const reachable = new Set<string>();
  const finished = new Set<string>();
  const active = new Set<string>();
  const reportedCycles = new Set<string>();
  const reportedDepth = new Set<string>();
  const walk = (startId: string, markReachable: boolean): void => {
    if (!doc.nodes[startId] || finished.has(startId)) {
      if (markReachable && finished.has(startId)) reachable.add(startId);
      return;
    }
    const stack: Array<{ id: string; depth: number; exit: boolean }> = [
      { id: startId, depth: 1, exit: false },
    ];
    while (stack.length > 0) {
      const frame = stack.pop()!;
      if (frame.exit) {
        active.delete(frame.id);
        finished.add(frame.id);
        continue;
      }
      if (active.has(frame.id)) {
        if (!reportedCycles.has(frame.id)) {
          problems.push(`document tree contains a cycle at ${frame.id}`);
          reportedCycles.add(frame.id);
        }
        continue;
      }
      if (finished.has(frame.id)) {
        if (markReachable) reachable.add(frame.id);
        continue;
      }
      const node = doc.nodes[frame.id];
      if (!node) continue;
      active.add(frame.id);
      if (markReachable) reachable.add(frame.id);
      if (frame.depth > limits.maxDepth && !reportedDepth.has(frame.id)) {
        problems.push(`document tree exceeds maximum depth ${limits.maxDepth} at ${frame.id}`);
        reportedDepth.add(frame.id);
      }
      stack.push({ ...frame, exit: true });
      for (let index = node.children.length - 1; index >= 0; index -= 1) {
        stack.push({ id: node.children[index]!, depth: frame.depth + 1, exit: false });
      }
    }
  };

  const entryRoots = new Set<string>(doc.rootOrder);
  for (const component of Object.values(doc.components)) entryRoots.add(component.rootId);
  for (const rootId of entryRoots) walk(rootId, true);
  const unreachable = nodeIds.filter((id) => !reachable.has(id));
  if (unreachable.length > 0) {
    problems.push(
      `document contains ${unreachable.length} unreachable node(s), including ${unreachable[0]}`,
    );
  }
  for (const nodeId of unreachable) walk(nodeId, false);

  const componentRootOwner = new Map<string, string>();
  for (const [cid, comp] of Object.entries(doc.components)) {
    if (comp.id !== cid) problems.push(`component key ${cid} != component.id ${comp.id}`);
    const previousComponent = componentRootOwner.get(comp.rootId);
    if (previousComponent && previousComponent !== cid) {
      problems.push(`components ${previousComponent} and ${cid} share master root ${comp.rootId}`);
    } else {
      componentRootOwner.set(comp.rootId, cid);
    }
    const root = doc.nodes[comp.rootId];
    if (!root) {
      problems.push(`component ${cid} references missing root ${comp.rootId}`);
    } else if (root.type !== 'frame') {
      problems.push(`component ${cid} root ${comp.rootId} is not a frame`);
    } else if (root.isComponentMaster !== cid) {
      problems.push(`component ${cid} root ${comp.rootId} is not marked as its master`);
    }
    const contentRoot = doc.nodes[comp.contentRootId];
    if (!contentRoot) {
      problems.push(`component ${cid} references missing content root ${comp.contentRootId}`);
    } else if (
      comp.contentRootId !== comp.rootId &&
      !isAncestor(doc.nodes, comp.rootId, comp.contentRootId)
    ) {
      problems.push(`component ${cid} content root ${comp.contentRootId} is outside its master`);
    }

    const propNames = new Set<string>();
    for (const prop of comp.variantProps) {
      if (propNames.has(prop.name))
        problems.push(`component ${cid} repeats variant prop ${prop.name}`);
      propNames.add(prop.name);
      if (!prop.values.includes(prop.default)) {
        problems.push(`component ${cid} default ${prop.default} is not a value of ${prop.name}`);
      }
      if (new Set(prop.values).size !== prop.values.length) {
        problems.push(`component ${cid} variant prop ${prop.name} repeats a value`);
      }
    }

    const componentNodeIds = root ? new Set(subtreeIds(doc.nodes, comp.rootId)) : new Set<string>();
    for (const [key, patches] of Object.entries(comp.variants)) {
      const selector = parseVariantKey(key);
      if (!selector) {
        problems.push(`component ${cid} has invalid variant selector ${key}`);
        continue;
      }
      for (const [name, value] of Object.entries(selector)) {
        const prop = comp.variantProps.find((candidate) => candidate.name === name);
        if (!prop || !prop.values.includes(value)) {
          problems.push(`component ${cid} variant selector ${key} is not declared`);
        }
      }
      for (const nodeId of Object.keys(patches)) {
        if (!componentNodeIds.has(nodeId)) {
          problems.push(
            `component ${cid} variant ${key} patches node outside its master: ${nodeId}`,
          );
        }
      }
    }

    for (const nodeId of componentNodeIds) {
      const node = doc.nodes[nodeId];
      if (node?.type === 'instance') {
        problems.push(
          `component ${cid} contains nested instance ${nodeId}; nested components are unsupported`,
        );
      }
    }
  }
  for (const [id, node] of Object.entries(doc.nodes)) {
    if (node.type !== 'frame' || !node.isComponentMaster) continue;
    const component = doc.components[node.isComponentMaster];
    if (!component) {
      problems.push(`master frame ${id} references missing component ${node.isComponentMaster}`);
    } else if (component.rootId !== id) {
      problems.push(
        `master frame ${id} claims component ${node.isComponentMaster}, whose root is ${component.rootId}`,
      );
    }
  }
  for (const [id, node] of Object.entries(doc.nodes)) {
    if (node.type !== 'instance') continue;
    const component = doc.components[node.componentId];
    if (!component) continue;
    for (const [name, value] of Object.entries(node.variant)) {
      const prop = component.variantProps.find((candidate) => candidate.name === name);
      if (!prop || !prop.values.includes(value)) {
        problems.push(`instance ${id} has invalid ${name} variant value ${value}`);
      }
    }
    const componentNodeIds = new Set(subtreeIds(doc.nodes, component.rootId));
    for (const nodeId of Object.keys(node.overrides)) {
      if (!componentNodeIds.has(nodeId)) {
        problems.push(`instance ${id} overrides node outside component ${nodeId}`);
      }
    }
    for (const override of Object.values(node.overrides)) {
      if (override.src && 'asset' in override.src && !doc.assets[override.src.asset]) {
        problems.push(`instance ${id} references undeclared asset ${override.src.asset}`);
      }
    }
  }
  return problems;
}
