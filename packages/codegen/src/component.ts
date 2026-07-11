import {
  subtreeIds,
  type ComponentDef,
  type PitoletDocument,
  type PitoletNode,
  type NodeId,
  type TextSpan,
} from '@pitolet/schema';
import { twMerge } from 'tailwind-merge';
import { styleDeclToClasses } from './classes.js';
import { componentName } from './jsx.js';
import { TokenMaps } from './tokenMaps.js';

/**
 * ComponentDef → a real React component file with a typed variant prop.
 * Variant style patches compile to per-value class strings (merged at
 * generation time — no runtime class-merge dependency in the output).
 * If the component has exactly one text node, it becomes `children`.
 */
export function generateComponent(doc: PitoletDocument, def: ComponentDef): string {
  const maps = new TokenMaps(doc.tokens);
  const master = doc.nodes[def.rootId];
  if (!master) return `// component ${def.name}: missing master\n`;
  const contentRootId = master.children.length === 1 ? master.children[0]! : def.rootId;

  const name = componentName(def.name);
  const prop = def.variantProps[0]; // v1: one variant prop drives codegen
  const labelNodeId = singleTextNode(doc, contentRootId);

  const propsParts: string[] = [];
  if (prop) {
    propsParts.push(`${prop.name} = '${prop.default}'`);
  }
  if (labelNodeId) propsParts.push('children');

  const propsType: string[] = [];
  if (prop) propsType.push(`${prop.name}?: ${prop.values.map((v) => `'${v}'`).join(' | ')}`);
  if (labelNodeId) propsType.push('children?: React.ReactNode');

  const body = renderMasterNode(doc, contentRootId, def, maps, prop?.name ?? null, labelNodeId, 2);

  const lines: string[] = [];
  if (propsType.length > 0) {
    lines.push(`export interface ${name}Props {`);
    for (const p of propsType) lines.push(`  ${p};`);
    lines.push(`}`);
    lines.push('');
    lines.push(
      `export function ${name}({ ${propsParts.join(', ')} }: ${name}Props) {`,
    );
  } else {
    lines.push(`export function ${name}() {`);
  }
  lines.push('  return (');
  lines.push(body);
  lines.push('  );');
  lines.push('}');
  lines.push('');
  return lines.join('\n');
}

function renderMasterNode(
  doc: PitoletDocument,
  nodeId: NodeId,
  def: ComponentDef,
  maps: TokenMaps,
  propName: string | null,
  labelNodeId: NodeId | null,
  depth: number,
): string {
  const node = doc.nodes[nodeId];
  if (!node || !node.visible) return '';
  const pad = '  '.repeat(depth);

  const baseClasses = twMerge(styleDeclToClasses(node.styles.base, { maps }).join(' '));
  let classAttr = baseClasses ? `className="${baseClasses}"` : '';

  if (propName) {
    const prop = def.variantProps.find((p) => p.name === propName)!;
    const perValue = new Map<string, string>();
    let differs = false;
    for (const value of prop.values) {
      const patch = def.variants[`${propName}=${value}`]?.[nodeId]?.styles;
      const merged = patch
        ? twMerge(
            [
              ...styleDeclToClasses(node.styles.base, { maps }),
              ...styleDeclToClasses(patch, { maps }),
            ].join(' '),
          )
        : baseClasses;
      perValue.set(value, merged);
      if (merged !== baseClasses) differs = true;
    }
    if (differs) {
      const entries = prop.values
        .map((v) => `${JSON.stringify(v)}: ${JSON.stringify(perValue.get(v))}`)
        .join(', ');
      classAttr = `className={{ ${entries} }[${propName}]}`;
    }
  }

  const attrs = [classAttr, ...Object.entries(node.attrs ?? {}).map(([k, v]) => `${k}="${v}"`)]
    .filter(Boolean)
    .join(' ');
  const attrString = attrs ? ` ${attrs}` : '';

  if (node.type === 'text') {
    const content =
      nodeId === labelNodeId
        ? `{children ?? ${JSON.stringify(plainText(node.content))}}`
        : escapeText(plainText(node.content));
    return `${pad}<${node.tag}${attrString}>${content}</${node.tag}>`;
  }
  if (node.type === 'image') {
    const src = 'url' in node.src ? node.src.url : `/assets/${node.src.asset}`;
    return `${pad}<img${attrString} src="${src}" alt="${node.alt}" />`;
  }
  const children = node.children
    .map((childId) => renderMasterNode(doc, childId, def, maps, propName, labelNodeId, depth + 1))
    .filter(Boolean);
  if (children.length === 0) return `${pad}<${node.tag}${attrString} />`;
  return `${pad}<${node.tag}${attrString}>\n${children.join('\n')}\n${pad}</${node.tag}>`;
}

/** The component's single text node (if exactly one) — becomes `children`. */
export function singleTextNode(doc: PitoletDocument, rootId: NodeId): NodeId | null {
  const textIds = subtreeIds(doc.nodes, rootId).filter((id) => doc.nodes[id]?.type === 'text');
  return textIds.length === 1 ? textIds[0]! : null;
}

function plainText(content: TextSpan[]): string {
  return content.map((s) => s.text).join('');
}

function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function componentFileImports(doc: PitoletDocument, rootId: NodeId): string[] {
  const used = new Set<string>();
  for (const id of subtreeIds(doc.nodes, rootId)) {
    const node = doc.nodes[id] as PitoletNode | undefined;
    if (node?.type === 'instance') {
      const def = doc.components[node.componentId];
      if (def) used.add(componentName(def.name));
    }
  }
  return [...used].sort();
}
