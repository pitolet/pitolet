import {
  componentContentBaseStyles,
  matchingVariantKeys,
  subtreeIds,
  variantCombinations,
  variantKey,
  type ComponentDef,
  type Display,
  type FlexDirection,
  type PitoletDocument,
  type PitoletNode,
  type NodeId,
  type TextSpan,
  type VariantProp,
} from '@pitolet/schema';
import { twMerge } from 'tailwind-merge';
import { styleDeclToClasses } from './classes.js';
import { componentNameForId, variantPropNames } from './jsx.js';
import {
  booleanAttributeEnabled,
  breakpointVariantNames,
  safeAttributes,
  safeCommentValue,
  safeImageUrl,
  safeTag,
} from './safety.js';
import { TokenMaps } from './tokenMaps.js';

/** Generate a typed React component with compound variants and instance overrides. */
export function generateComponent(doc: PitoletDocument, def: ComponentDef): string {
  const maps = new TokenMaps(doc.tokens);
  const master = doc.nodes[def.rootId];
  const contentRoot = doc.nodes[def.contentRootId];
  if (!master || !contentRoot) {
    return `// component ${safeCommentValue(def.name)}: missing master content\n`;
  }

  const name = componentNameForId(doc, def.id);
  const labelNodeId = singleTextNode(doc, def.contentRootId);
  const combinations = variantCombinations(def.variantProps);
  const propNames = variantPropNames(def.variantProps.map((prop) => prop.name));
  const breakpointNames = breakpointVariantNames(doc.breakpoints);

  const propsParts = def.variantProps.map(
    (prop) => `${propNames.get(prop.name)} = ${JSON.stringify(prop.default)}`,
  );
  propsParts.push('className', 'overrides');
  if (labelNodeId) propsParts.push('children');

  const propsType = def.variantProps.map(
    (prop) =>
      `${propNames.get(prop.name)}?: ${prop.values.map((value) => JSON.stringify(value)).join(' | ')}`,
  );
  propsType.push('className?: string');
  propsType.push(
    'overrides?: Record<string, { content?: React.ReactNode; src?: string; className?: string; visible?: boolean }>',
  );
  if (labelNodeId) propsType.push('children?: React.ReactNode');

  const body = renderMasterNode({
    doc,
    nodeId: def.contentRootId,
    def,
    maps,
    combinations,
    labelNodeId,
    depth: 2,
    isComponentRoot: true,
    parent: {},
    breakpointNames,
  });

  const lines: string[] = [];
  lines.push(`export interface ${name}Props {`);
  for (const prop of propsType) lines.push(`  ${prop};`);
  lines.push('}');
  lines.push('');
  lines.push(`export function ${name}({ ${propsParts.join(', ')} }: ${name}Props) {`);
  if (def.variantProps.length > 0) {
    const segments = def.variantProps
      .map((prop) => `${JSON.stringify(`${prop.name}=`)} + ${propNames.get(prop.name)}`)
      .join(', ');
    lines.push(`  const variantKey = [${segments}].sort().join(',');`);
  }
  lines.push('  return (');
  lines.push(body);
  lines.push('  );');
  lines.push('}');
  lines.push('');
  return lines.join('\n');
}

interface RenderMasterOptions {
  doc: PitoletDocument;
  nodeId: NodeId;
  def: ComponentDef;
  maps: TokenMaps;
  combinations: Record<string, string>[];
  labelNodeId: NodeId | null;
  depth: number;
  isComponentRoot?: boolean;
  parent: LayoutContext;
  breakpointNames: Map<string, string>;
}

function renderMasterNode(options: RenderMasterOptions): string {
  const { doc, nodeId, def, maps, combinations, labelNodeId, depth } = options;
  const node = doc.nodes[nodeId];
  if (!node || node.type === 'instance') return '';
  const pad = '  '.repeat(depth);
  const perVariant = variantPresentation(
    doc,
    node,
    def,
    maps,
    combinations,
    options.parent,
    options.breakpointNames,
  );
  const classAttr = componentClassAttribute(node, perVariant, Boolean(options.isComponentRoot));
  const attrs = [
    classAttr,
    ...safeAttributes(node.attrs)
      .filter(([key]) => node.type !== 'image' || key !== 'alt')
      .map(([key, value]) => {
        if (BOOLEAN_ATTRS.has(key)) {
          return booleanAttributeEnabled(value) ? jsxAttrName(key) : '';
        }
        return `${jsxAttrName(key)}=${JSON.stringify(value)}`;
      }),
  ]
    .filter(Boolean)
    .join(' ');
  const attrString = attrs ? ` ${attrs}` : '';

  let core: string;
  const tag = safeTag(node.tag, node.type === 'text' ? 'span' : 'div');
  if (node.type === 'text') {
    const fallback = JSON.stringify(plainText(node.content));
    const content =
      nodeId === labelNodeId
        ? `{children ?? overrides?.[${JSON.stringify(nodeId)}]?.content ?? ${fallback}}`
        : `{overrides?.[${JSON.stringify(nodeId)}]?.content ?? ${fallback}}`;
    core = `${pad}<${tag}${attrString}>${content}</${tag}>`;
  } else if (node.type === 'image') {
    const source =
      'url' in node.src
        ? JSON.stringify(safeImageUrl(node.src.url))
        : `new URL(${JSON.stringify(`../assets/${node.src.asset}`)}, import.meta.url).href`;
    const src = `{overrides?.[${JSON.stringify(nodeId)}]?.src ?? ${source}}`;
    core = `${pad}<img${attrString} src=${src} alt=${JSON.stringify(node.alt)} />`;
  } else {
    if (VOID_TAGS.has(tag)) {
      core = `${pad}<${tag}${attrString} />`;
      const variantVisible = variantVisibilityExpression(perVariant, def.variantProps);
      const visibleExpression = `overrides?.[${JSON.stringify(nodeId)}]?.visible ?? ${variantVisible}`;
      return wrapConditional(core, visibleExpression, pad, Boolean(options.isComponentRoot));
    }
    const childParent = childLayoutContext(node, doc);
    const children = node.children
      .map((childId) =>
        renderMasterNode({
          ...options,
          nodeId: childId,
          depth: depth + 1,
          isComponentRoot: false,
          parent: childParent,
        }),
      )
      .filter(Boolean);
    core =
      children.length === 0
        ? `${pad}<${tag}${attrString} />`
        : `${pad}<${tag}${attrString}>\n${children.join('\n')}\n${pad}</${tag}>`;
  }

  const variantVisible = variantVisibilityExpression(perVariant, def.variantProps);
  const visibleExpression = `overrides?.[${JSON.stringify(nodeId)}]?.visible ?? ${variantVisible}`;
  return wrapConditional(core, visibleExpression, pad, Boolean(options.isComponentRoot));
}

interface VariantPresentation {
  key: string;
  classes: string;
  visible: boolean;
}

function variantPresentation(
  doc: PitoletDocument,
  node: PitoletNode,
  def: ComponentDef,
  maps: TokenMaps,
  combinations: Record<string, string>[],
  parent: LayoutContext,
  breakpointNames: Map<string, string>,
): VariantPresentation[] {
  return combinations.map((values) => {
    const decl = componentContentBaseStyles(def, node);
    let visible = node.visible;
    for (const key of matchingVariantKeys(values, def.variantProps)) {
      const patch = def.variants[key]?.[node.id];
      if (patch?.styles) Object.assign(decl, patch.styles);
      if (patch?.visible !== undefined) visible = patch.visible;
    }
    const baseContext = {
      maps,
      parentDisplay: parent.display,
      parentDirection: parent.direction,
    };
    const classes = [...styleDeclToClasses(decl, baseContext)];
    let effectiveDecl = { ...decl };
    let previousParent: {
      parentDisplay?: Display;
      parentDirection?: FlexDirection;
    } = {
      parentDisplay: parent.display,
      parentDirection: parent.direction,
    };
    for (const breakpoint of doc.breakpoints) {
      const layer = node.styles.breakpoints?.[breakpoint.id];
      if (layer) effectiveDecl = { ...effectiveDecl, ...layer };
      const currentParent = parent.breakpoints?.[breakpoint.id] ?? previousParent;
      const parentChanged =
        currentParent.parentDisplay !== previousParent.parentDisplay ||
        currentParent.parentDirection !== previousParent.parentDirection;
      if (!layer && !parentChanged) {
        previousParent = currentParent;
        continue;
      }
      const breakpointContext = {
        maps,
        ...currentParent,
        previousParentDisplay: previousParent.parentDisplay,
        previousParentDirection: previousParent.parentDirection,
        isOverrideLayer: true,
      };
      classes.push(
        ...styleDeclToClasses(effectiveDecl, breakpointContext).map(
          (className) => `${breakpointNames.get(breakpoint.id)}:${className}`,
        ),
      );
      previousParent = currentParent;
    }
    for (const state of ['hover', 'focus', 'active'] as const) {
      const layer = node.styles.states?.[state];
      if (layer) {
        classes.push(
          ...styleDeclToClasses(
            { ...decl, ...layer },
            { ...baseContext, isOverrideLayer: true },
          ).map((className) => `${state}:${className}`),
        );
      }
    }
    return {
      key: variantKey(values, def.variantProps),
      classes: twMerge(classes.join(' ')),
      visible,
    };
  });
}

function componentClassAttribute(
  node: PitoletNode,
  perVariant: VariantPresentation[],
  isRoot: boolean,
): string {
  const base = perVariant[0]?.classes ?? '';
  const differs = perVariant.some((entry) => entry.classes !== base);
  const runtimeOverride = `overrides?.[${JSON.stringify(node.id)}]?.className`;
  const dynamicParts: string[] = [];
  if (differs) {
    dynamicParts.push(`(${recordExpression(perVariant, (entry) => entry.classes)}[variantKey])`);
  } else if (base) {
    dynamicParts.push(JSON.stringify(base));
  }
  if (isRoot) dynamicParts.push('className');
  dynamicParts.push(runtimeOverride);
  if (dynamicParts.length === 1 && base && !isRoot) return `className=${JSON.stringify(base)}`;
  return `className={[${dynamicParts.join(', ')}].filter(Boolean).join(' ')}`;
}

function variantVisibilityExpression(
  perVariant: VariantPresentation[],
  props: VariantProp[],
): string {
  if (props.length === 0) return String(perVariant[0]?.visible ?? true);
  const first = perVariant[0]?.visible ?? true;
  if (perVariant.every((entry) => entry.visible === first)) return String(first);
  return `(${recordExpression(perVariant, (entry) => entry.visible)}[variantKey])`;
}

function recordExpression<T>(
  entries: VariantPresentation[],
  value: (entry: VariantPresentation) => T,
): string {
  return `{ ${entries
    .map((entry) => `${JSON.stringify(entry.key)}: ${JSON.stringify(value(entry))}`)
    .join(', ')} }`;
}

function wrapConditional(
  core: string,
  visibleExpression: string,
  pad: string,
  isRoot: boolean,
): string {
  const indented = core
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
  if (isRoot) return `${pad}(${visibleExpression}) && (\n${indented}\n${pad})`;
  return `${pad}{(${visibleExpression}) && (\n${indented}\n${pad})}`;
}

/** The component's single text node (if exactly one) becomes children. */
export function singleTextNode(doc: PitoletDocument, rootId: NodeId): NodeId | null {
  const textIds = subtreeIds(doc.nodes, rootId).filter((id) => doc.nodes[id]?.type === 'text');
  return textIds.length === 1 ? textIds[0]! : null;
}

function plainText(content: TextSpan[]): string {
  return content.map((span) => span.text).join('');
}

const BOOLEAN_ATTRS = new Set(['checked', 'disabled', 'selected']);
const VOID_TAGS = new Set(['input', 'br', 'hr', 'meta', 'link', 'source', 'track', 'wbr']);

function jsxAttrName(key: string): string {
  if (key === 'class') return 'className';
  if (key === 'for') return 'htmlFor';
  if (key === 'colspan') return 'colSpan';
  if (key === 'rowspan') return 'rowSpan';
  if (key === 'autocomplete') return 'autoComplete';
  if (key === 'inputmode') return 'inputMode';
  return key;
}

export function componentFileImports(doc: PitoletDocument, rootId: NodeId): string[] {
  const used = new Set<string>();
  for (const id of subtreeIds(doc.nodes, rootId)) {
    const node = doc.nodes[id];
    if (node?.type === 'instance') {
      const def = doc.components[node.componentId];
      if (def) used.add(componentNameForId(doc, def.id));
    }
  }
  return [...used].sort();
}

interface LayoutContext {
  display?: Display;
  direction?: FlexDirection;
  breakpoints?: Record<
    string,
    {
      parentDisplay?: Display;
      parentDirection?: FlexDirection;
    }
  >;
}

function childLayoutContext(node: PitoletNode, doc: PitoletDocument): LayoutContext {
  let effective = { ...node.styles.base };
  const breakpoints: NonNullable<LayoutContext['breakpoints']> = {};
  for (const breakpoint of doc.breakpoints) {
    const layer = node.styles.breakpoints?.[breakpoint.id];
    if (layer) effective = { ...effective, ...layer };
    breakpoints[breakpoint.id] = {
      parentDisplay: effective.display,
      parentDirection: effective.flexDirection,
    };
  }
  return {
    display: node.styles.base.display,
    direction: node.styles.base.flexDirection,
    breakpoints,
  };
}
