import { z } from 'zod';
import type { PitoletDocument } from './document.js';
import type { PitoletNode } from './nodes.js';

/**
 * Runtime validation for the whole document format. The server revalidates
 * every node a patch touches; MCP tool inputs validate before entering the
 * patch pipeline; documents validate fully on load.
 */

// --- primitives ---

export const zTokenRef = z.object({ $token: z.string().min(1) }).strict();

const sv = <T extends z.ZodType>(t: T) => z.union([t, zTokenRef]);

export const zLength = z.object({
  value: z.number().finite(),
  unit: z.enum(['px', 'rem', 'em', '%', 'vw', 'vh']),
});

export const zColor = z.object({
  space: z.literal('oklch'),
  l: z.number().min(0).max(1),
  c: z.number().min(0),
  h: z.number(),
  alpha: z.number().min(0).max(1).optional(),
});

const zSize = z.union([zLength, z.literal('auto'), z.literal('fill')]);

const zSidesLength = z.object({
  top: sv(zLength),
  right: sv(zLength),
  bottom: sv(zLength),
  left: sv(zLength),
});

const zGradientStop = z.object({ color: sv(zColor), position: z.number().min(0).max(1) });

const zFill = z.discriminatedUnion('type', [
  z.object({ type: z.literal('solid'), color: sv(zColor) }),
  z.object({ type: z.literal('linear'), angle: z.number(), stops: z.array(zGradientStop).min(2) }),
  z.object({ type: z.literal('radial'), stops: z.array(zGradientStop).min(2) }),
]);

const zShadow = z.object({
  x: z.number(),
  y: z.number(),
  blur: z.number().min(0),
  spread: z.number(),
  color: sv(zColor),
  inset: z.literal(true).optional(),
});

const zTrack = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('fr'), value: z.number().positive() }),
  z.object({ kind: z.literal('px'), value: z.number().positive() }),
  z.object({ kind: z.literal('auto') }),
  z.object({
    kind: z.literal('minmax'),
    min: z.number().min(0),
    max: z.object({ kind: z.enum(['fr', 'px']), value: z.number().positive() }),
  }),
]);

const zAlign = z.enum(['start', 'center', 'end', 'stretch', 'baseline']);
const zJustify = z.enum(['start', 'center', 'end', 'between', 'around', 'evenly']);

export const zStyleDecl = z
  .object({
    display: z.enum(['flex', 'grid', 'block', 'inline', 'none']),
    flexDirection: z.enum(['row', 'column']),
    flexWrap: z.enum(['wrap', 'nowrap']),
    alignItems: zAlign,
    justifyContent: zJustify,
    gap: z.object({ row: sv(zLength), column: sv(zLength) }),
    gridTemplateColumns: z.array(zTrack),
    gridTemplateRows: z.array(zTrack),
    alignSelf: zAlign,
    flexGrow: z.number().min(0),
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
    position: z.enum(['relative', 'absolute', 'sticky']),
    inset: zSidesLength.partial(),
    zIndex: z.number().int(),
    fontFamily: sv(z.string()),
    fontSize: sv(zLength),
    fontWeight: sv(z.number().min(1).max(1000)),
    lineHeight: sv(z.union([z.number(), zLength])),
    letterSpacing: sv(zLength),
    textAlign: z.enum(['left', 'center', 'right', 'justify']),
    color: sv(zColor),
    fills: z.array(zFill),
    border: z.object({
      width: sv(zLength),
      style: z.enum(['solid', 'dashed', 'dotted']),
      color: sv(zColor),
      sides: z
        .object({ top: z.boolean(), right: z.boolean(), bottom: z.boolean(), left: z.boolean() })
        .partial()
        .optional(),
    }),
    radius: z.object({ tl: sv(zLength), tr: sv(zLength), br: sv(zLength), bl: sv(zLength) }),
    shadows: z.array(zShadow),
    opacity: z.number().min(0).max(1),
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
      .optional(),
  })
  .strict();

// --- nodes ---

const zTextSpan = z.object({
  text: z.string(),
  marks: z
    .object({
      bold: z.literal(true).optional(),
      italic: z.literal(true).optional(),
      link: z.string().optional(),
    })
    .optional(),
});

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

export const zFrameNode = z.object({
  ...nodeBase,
  type: z.literal('frame'),
  canvas: z.object({
    x: z.number(),
    y: z.number(),
    width: z.number().positive(),
    height: z.union([z.number().positive(), z.literal('auto')]),
  }),
  isComponentMaster: z.string().optional(),
});

export const zElementNode = z.object({ ...nodeBase, type: z.literal('element') });

export const zTextNode = z.object({
  ...nodeBase,
  type: z.literal('text'),
  content: z.array(zTextSpan),
});

export const zImageNode = z.object({
  ...nodeBase,
  type: z.literal('image'),
  src: zImageSrc,
  alt: z.string(),
});

const zInstanceOverride = z
  .object({
    content: z.array(zTextSpan).optional(),
    src: zImageSrc.optional(),
    styles: zStyleDecl.optional(),
    visible: z.boolean().optional(),
  })
  .strict();

export const zInstanceNode = z.object({
  ...nodeBase,
  type: z.literal('instance'),
  componentId: z.string(),
  variant: z.record(z.string(), z.string()),
  overrides: z.record(z.string(), zInstanceOverride),
});

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
    variantProps: z.array(
      z.object({ name: z.string().min(1), values: z.array(z.string()).min(1), default: z.string() }),
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

export const zBreakpoint = z.object({
  id: z.string().min(1),
  name: z.string(),
  minWidth: z.number().positive(),
});

export const zAsset = z.object({
  fileName: z.string(),
  width: z.number(),
  height: z.number(),
  mime: z.string(),
});

export const zComment = z
  .object({
    id: z.string().min(1),
    nodeId: z.string().min(1),
    text: z.string().min(1),
    author: z.string().min(1),
    createdAt: z.number(),
    resolved: z.literal(true).optional(),
  })
  .strict();

export const zDocument = z
  .object({
    schemaVersion: z.literal(1),
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

export function validateDocument(raw: unknown): PitoletDocument {
  return zDocument.parse(raw) as PitoletDocument;
}

export function validateNode(raw: unknown): PitoletNode {
  return zNode.parse(raw) as PitoletNode;
}

/**
 * Structural coherence beyond per-node shape: parent/children symmetry,
 * rootOrder integrity, no dangling references. Returns human-readable
 * problems (empty = coherent).
 */
export function structuralProblems(doc: PitoletDocument): string[] {
  const problems: string[] = [];
  for (const rootId of doc.rootOrder) {
    const node = doc.nodes[rootId];
    if (!node) problems.push(`rootOrder references missing node ${rootId}`);
    else if (node.parent !== null) problems.push(`root node ${rootId} has non-null parent`);
    else if (node.type !== 'frame') problems.push(`root node ${rootId} is not a frame`);
  }
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
    for (const childId of node.children) {
      const child = doc.nodes[childId];
      if (!child) problems.push(`node ${id} references missing child ${childId}`);
      else if (child.parent !== id)
        problems.push(`child ${childId} of ${id} has parent ${child.parent}`);
    }
    if (node.type === 'instance' && !doc.components[node.componentId])
      problems.push(`instance ${id} references missing component ${node.componentId}`);
  }
  for (const [cid, comp] of Object.entries(doc.components)) {
    if (!doc.nodes[comp.rootId]) problems.push(`component ${cid} references missing root ${comp.rootId}`);
  }
  return problems;
}
