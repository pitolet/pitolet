import { buildPreviewHtml, generateSelection } from '@pitolet/codegen';
import {
  createDocument,
  createElement,
  createFrame,
  createImage,
  createText,
  DOCUMENT_LIMITS,
  mergeParsedTokens,
  isJsonWithinLimits,
  MAX_PATCH_VALUE_DEPTH,
  MAX_PATCH_VALUE_ENTRIES,
  newId,
  parseCssTokens,
  pruneCommentsForNodes,
  subtreeIds,
  type PitoletComment,
  zStyleDecl,
  zStyleSheet,
  type PitoletDocument,
  type PitoletNode,
  type NodeId,
  type StyleDecl,
  type StyleSheet,
  type StateName,
  type TextSpan,
} from '@pitolet/schema';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  actorFromContext,
  ANONYMOUS,
  check,
  type AuthAction,
  type AuthContext,
  type AuthHooks,
} from '../auth/types.js';
import { checkDrift, exportProject } from '../export.js';
import type { StorageAdapter } from '../storage/StorageAdapter.js';
import type { DocumentStore } from '../store/DocumentStore.js';
import type { WsHub } from '../sync/wsHub.js';
import { confirmLine, MAX_DEPTH, styleSummary, summarizeNode } from './summarize.js';
import { launchChromium } from '../importer/capture.js';

/**
 * MCP tools for reading and editing Pitolet documents. Writes use the same
 * validation and history as editor changes.
 *
 * Reads return compact summaries rather than raw document JSON.
 */

/** Recursive node input for insert_nodes. */
interface NodeSpec {
  type?: 'element' | 'text' | 'image' | 'frame';
  tag?: string;
  name?: string;
  text?: string;
  src?: string;
  alt?: string;
  styles?: StyleDecl;
  children?: NodeSpec[];
}

// Keep the public MCP schema deliberately shallow. Expanding the recursive
// children schema to DOCUMENT_LIMITS.maxDepth produced a ~1.8 MB tools/list
// response and made some MCP clients close during discovery. The complete
// recursive validation still happens below before a mutation is applied.
const zNodeSpecs = z
  .array(z.record(z.string(), z.unknown()))
  .min(1)
  .max(DOCUMENT_LIMITS.maxNodes)
  .describe(
    'Node objects with optional type, tag, name, text, src, alt, styles, and recursive children',
  );

const zNodeSpecFields = z
  .object({
    type: z.enum(['element', 'text', 'image', 'frame']).optional(),
    tag: z.string().max(80).optional(),
    name: z.string().max(500).optional(),
    text: z.string().max(1_000_000).optional(),
    src: z.string().max(2_000_000).optional(),
    alt: z.string().max(10_000).optional(),
    styles: zStyleDecl.optional(),
    children: z.array(z.unknown()).max(DOCUMENT_LIMITS.maxNodes).optional(),
  })
  .strict();

function parseNodeSpecs(input: unknown): NodeSpec[] {
  if (!Array.isArray(input) || input.length === 0) throw new Error('nodes must not be empty');
  let count = 0;
  const visit = (value: unknown, depth: number): NodeSpec => {
    if (depth > DOCUMENT_LIMITS.maxDepth) {
      throw new Error(`node subtree exceeds the maximum depth of ${DOCUMENT_LIMITS.maxDepth}`);
    }
    count += 1;
    if (count > DOCUMENT_LIMITS.maxNodes) {
      throw new Error(`node subtree exceeds ${DOCUMENT_LIMITS.maxNodes} nodes`);
    }
    const parsed = zNodeSpecFields.safeParse(value);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new Error(
        `invalid node${issue?.path.length ? ` at ${issue.path.join('.')}` : ''}: ${issue?.message ?? 'invalid value'}`,
      );
    }
    const { children, ...fields } = parsed.data;
    return {
      ...fields,
      children: children?.map((child) => visit(child, depth + 1)),
    };
  };
  return input.map((root) => visit(root, 1));
}

export function registerTools(
  server: McpServer,
  store: DocumentStore,
  hub: WsHub,
  adapter: StorageAdapter,
  options: { ctx?: AuthContext; auth?: AuthHooks } = {},
): void {
  const ctx = options.ctx;
  // Per-user attribution for MCP writes: undefined today (agent tokens carry
  // no userId yet), so patches ride actor-free — no behavior change.
  const actor = actorFromContext(ctx);
  // Scopes absent = unrestricted; a scope list without 'write' hides every
  // write tool (unregistered tools cannot be called through the SDK).
  const canWrite = ctx?.scopes === undefined || ctx.scopes.includes('write');
  // Share contexts are pinned to one document — every other doc is invisible.
  const docVisible = (id: string) => ctx?.docId === undefined || id === ctx.docId;
  const authorize = (action: AuthAction, docId?: string): void => {
    const result = check(options.auth, ctx ?? ANONYMOUS, action, docId);
    if (!result.ok) {
      throw new Error(result.reason ?? `not authorized for ${action}`);
    }
  };

  const text = (value: unknown) => ({
    content: [
      {
        type: 'text' as const,
        text: typeof value === 'string' ? value : JSON.stringify(value, null, 1),
      },
    ],
  });

  const requireDoc = (
    docId: string | undefined,
    action: AuthAction = 'doc:read',
  ): { doc: PitoletDocument; id: string } => {
    const id = docId ?? ctx?.docId ?? store.list()[0]?.id;
    const entry = id && docVisible(id) ? store.get(id) : undefined;
    if (!entry) throw new Error(`unknown document${docId ? ` ${docId}` : ' (none loaded)'}`);
    authorize(action, entry.doc.id);
    return { doc: entry.doc, id: entry.doc.id };
  };

  const docIdParam = z
    .string()
    .optional()
    .describe('Document id (defaults to the first open document)');

  // ------------------------------------------------------------- reads ---

  server.registerTool(
    'list_documents',
    {
      description: 'List open Pitolet documents with ids and frame counts.',
    },
    () => {
      authorize('doc:list');
      return text({ documents: store.list().filter((d) => docVisible(d.id)) });
    },
  );

  server.registerTool(
    'list_frames',
    {
      description:
        'List the top-level frames in a document with their ids, names, sizes, and child counts.',
      inputSchema: { docId: docIdParam },
    },
    ({ docId }) => {
      const { doc } = requireDoc(docId);
      const frames = doc.rootOrder.map((id) => {
        const node = doc.nodes[id];
        if (node?.type !== 'frame') return null;
        return {
          id,
          name: node.name,
          width: node.canvas.width,
          height: node.canvas.height,
          childCount: node.children.length,
        };
      });
      return text({ frames: frames.filter(Boolean) });
    },
  );

  server.registerTool(
    'get_node',
    {
      description:
        'Return a compact node summary. Use get_design_as_code for complete generated code.',
      inputSchema: {
        docId: docIdParam,
        nodeId: z.string().describe('Node id'),
        depth: z.number().int().min(0).max(MAX_DEPTH).default(1).optional(),
      },
    },
    ({ docId, nodeId, depth }) => {
      const { doc } = requireDoc(docId);
      const summary = summarizeNode(doc, nodeId, depth ?? 1);
      if (!summary) throw new Error(`no node ${nodeId}`);
      return text(summary);
    },
  );

  server.registerTool(
    'get_selection',
    {
      description: "The user's current selection in the open editor (summaries, depth 1).",
      inputSchema: { docId: docIdParam },
    },
    ({ docId }) => {
      const { doc, id } = requireDoc(docId);
      const ids = hub.getSelection(id);
      if (ids.length === 0) return text('nothing selected');
      return text(ids.map((nid) => summarizeNode(doc, nid, 1)).filter(Boolean));
    },
  );

  server.registerTool(
    'get_tokens',
    {
      description:
        'Design tokens (colors, spacing, radius, shadows, typography) as compact path: value lines.',
      inputSchema: {
        docId: docIdParam,
        category: z.enum(['color', 'spacing', 'radius', 'shadow', 'typography']).optional(),
      },
    },
    ({ docId, category }) => {
      const { doc } = requireDoc(docId);
      const lines: string[] = [];
      const t = doc.tokens;
      if (!category || category === 'color') {
        for (const [k, v] of Object.entries(t.color)) {
          lines.push(`color.${k}: oklch(${v.$value.l} ${v.$value.c} ${v.$value.h})`);
        }
      }
      if (!category || category === 'spacing') {
        for (const [k, v] of Object.entries(t.spacing))
          lines.push(`spacing.${k}: ${v.$value.value}px`);
      }
      if (!category || category === 'radius') {
        for (const [k, v] of Object.entries(t.radius))
          lines.push(`radius.${k}: ${v.$value.value}px`);
      }
      if (!category || category === 'shadow') {
        for (const k of Object.keys(t.shadow)) lines.push(`shadow.${k}: (shadow list)`);
      }
      if (!category || category === 'typography') {
        for (const [k, v] of Object.entries(t.typography.fontFamily))
          lines.push(`typography.fontFamily.${k}: ${v.$value}`);
        for (const [k, v] of Object.entries(t.typography.fontSize))
          lines.push(`typography.fontSize.${k}: ${v.$value.value}px`);
      }
      return text(lines.join('\n'));
    },
  );

  server.registerTool(
    'get_design_as_code',
    {
      description: 'Return a node subtree as React with Tailwind or HTML with CSS.',
      inputSchema: {
        docId: docIdParam,
        nodeId: z.string().describe('Node id (a frame id from list_frames, or any node)'),
        target: z.enum(['react-tailwind', 'html']).default('react-tailwind').optional(),
      },
    },
    ({ docId, nodeId, target }) => {
      const { doc } = requireDoc(docId);
      if (!doc.nodes[nodeId]) throw new Error(`no node ${nodeId}`);
      return text(generateSelection(doc, nodeId, target ?? 'react-tailwind'));
    },
  );

  server.registerTool(
    'get_screenshot',
    {
      description:
        'Render a frame as a JPEG for visual review. Set viewportWidth to inspect a responsive breakpoint and state to force hover, focus, or active styling.',
      inputSchema: {
        docId: docIdParam,
        frameId: z.string(),
        maxSize: z.number().int().min(100).max(2000).default(800).optional(),
        viewportWidth: z
          .number()
          .int()
          .min(240)
          .max(4096)
          .optional()
          .describe('Browser viewport width in pixels; defaults to the frame width'),
        state: z
          .enum(['hover', 'focus', 'active'])
          .optional()
          .describe('Force this interaction state on rendered elements'),
      },
    },
    async ({ docId, frameId, maxSize, viewportWidth, state }) => {
      const { doc, id } = requireDoc(docId);
      let dataUrl: string;
      if (hub.hasEditorFor(id) && viewportWidth === undefined && state === undefined) {
        dataUrl = await hub.requestScreenshot(id, frameId, maxSize ?? 800);
      } else {
        dataUrl = await headlessScreenshot(
          doc,
          frameId,
          maxSize ?? 800,
          adapter.assets,
          viewportWidth,
          state,
        );
      }
      const match = dataUrl.match(/^data:(image\/\w+);base64,(.+)$/);
      if (!match) throw new Error('screenshot produced invalid image data');
      return {
        content: [
          {
            type: 'text' as const,
            text: `Rendered ${doc.name} at ${viewportWidth ?? 'the frame width'}${state ? ` with :${state} forced` : ''}. Inspect the image before deciding the design is finished.`,
          },
          { type: 'image' as const, mimeType: match[1]!, data: match[2]! },
        ],
      };
    },
  );

  // Write tool (registered in the reads section for discoverability, but it
  // mutates state): hidden from read-only scopes like every other write.
  if (canWrite)
    server.registerTool(
      'create_document',
      {
        description:
          'Create a new, empty Pitolet document (with the default token set). Returns its id; use create_frame next.',
        inputSchema: { name: z.string().min(1).max(120) },
      },
      async ({ name }) => {
        authorize('doc:create');
        const doc = createDocument({ name });
        await adapter.saveNow(doc, 0);
        store.load(doc);
        return text({ docId: doc.id, name: doc.name });
      },
    );

  // ------------------------------------------------------------ writes ---

  if (canWrite)
    server.registerTool(
      'set_selection',
      {
        description: 'Select nodes in the open editor.',
        inputSchema: { docId: docIdParam, nodeIds: z.array(z.string()).max(1_000) },
      },
      ({ docId, nodeIds }) => {
        const { doc, id } = requireDoc(docId, 'doc:write');
        const valid = nodeIds.filter((nid) => doc.nodes[nid]);
        hub.setSelection(id, valid, 'mcp');
        return text(`selected ${valid.length} node(s)`);
      },
    );

  if (canWrite)
    server.registerTool(
      'create_frame',
      {
        description:
          'Create a new top-level frame (artboard). Auto-placed right of existing frames unless x/y given.',
        inputSchema: {
          docId: docIdParam,
          name: z.string(),
          width: z.number().positive().default(1280).optional(),
          height: z
            .union([z.number().positive(), z.literal('auto')])
            .default(800)
            .optional(),
          x: z.number().optional(),
          y: z.number().optional(),
        },
      },
      ({ docId, name, width, height, x, y }) => {
        const { doc, id } = requireDoc(docId, 'doc:write');
        let px = x;
        let py = y;
        if (px === undefined || py === undefined) {
          let maxRight = 100;
          let minY = 100;
          for (const rootId of doc.rootOrder) {
            const node = doc.nodes[rootId];
            if (node?.type === 'frame') {
              maxRight = Math.max(maxRight, node.canvas.x + node.canvas.width + 80);
              minY = Math.min(minY, node.canvas.y);
            }
          }
          px = px ?? maxRight;
          py = py ?? minY;
        }
        const frame = createFrame({
          name,
          x: px,
          y: py,
          width: width ?? 1280,
          height: height ?? 800,
        });
        store.applyRecipe(
          id,
          'mcp',
          `MCP: create frame "${name}"`,
          (draft) => {
            draft.nodes[frame.id] = frame;
            draft.rootOrder.push(frame.id);
          },
          actor,
        );
        return text({ frameId: frame.id, x: px, y: py });
      },
    );

  if (canWrite)
    server.registerTool(
      'insert_nodes',
      {
        description:
          'Insert a subtree into a container. Each node may include type, tag, name, text, styles, and children. Returns the ids of the new root nodes.',
        inputSchema: {
          docId: docIdParam,
          parentId: z.string().describe('Container node id (frame or element)'),
          index: z.number().int().min(0).optional().describe('Insertion index (default: append)'),
          nodes: zNodeSpecs,
        },
      },
      ({ docId, parentId, index, nodes }) => {
        const { doc, id } = requireDoc(docId, 'doc:write');
        const parent = doc.nodes[parentId];
        if (!parent) throw new Error(`no node ${parentId}`);
        if (parent.type !== 'frame' && parent.type !== 'element')
          throw new Error(`${parentId} is a ${parent.type}, not a container`);

        const specs = parseNodeSpecs(nodes);
        const rootIds: string[] = [];
        store.applyRecipe(
          id,
          'mcp',
          'MCP: insert nodes',
          (draft) => {
            const expand = (spec: NodeSpec, parentNodeId: string): string => {
              const node = specToNode(spec);
              node.parent = parentNodeId;
              draft.nodes[node.id] = node;
              for (const childSpec of spec.children ?? []) {
                const childId = expand(childSpec, node.id);
                node.children.push(childId);
              }
              return node.id;
            };
            const target = draft.nodes[parentId]!;
            const insertAt = Math.min(index ?? target.children.length, target.children.length);
            const created = specs.map((spec) => expand(spec, parentId));
            target.children.splice(insertAt, 0, ...created);
            rootIds.push(...created);
          },
          actor,
        );
        const after = store.get(id)!.doc;
        return text({
          created: rootIds,
          parent: confirmLine(after, parentId),
          live: hub.hasEditorFor(id) ? 'visible on canvas now' : 'no editor open',
        });
      },
    );

  if (canWrite)
    server.registerTool(
      'rename_document',
      {
        description: 'Rename a Pitolet document. Returns the updated name and revision.',
        inputSchema: {
          docId: docIdParam,
          name: z.string().trim().min(1).max(120),
        },
      },
      ({ docId, name }) => {
        const { doc, id } = requireDoc(docId, 'doc:write');
        const nextName = name.trim();
        const rev = store.applyRecipe(
          id,
          'mcp',
          `MCP: rename document to "${nextName}"`,
          (draft) => {
            draft.name = nextName;
          },
          actor,
        );
        return text({ docId: id, previousName: doc.name, name: nextName, revision: rev });
      },
    );

  if (canWrite && adapter.deleteDoc)
    server.registerTool(
      'delete_document',
      {
        description:
          'Delete a document created by mistake or a failed attempt. Requires its exact current name and refuses while an editor has it open.',
        inputSchema: {
          docId: z.string().describe('Document id to delete'),
          confirmName: z.string().describe('Exact current document name'),
        },
      },
      async ({ docId, confirmName }) => {
        const { doc, id } = requireDoc(docId, 'doc:write');
        if (confirmName !== doc.name) throw new Error('confirmation does not match document name');
        if (hub.hasEditorFor(id))
          throw new Error('close this document in the editor before deleting it');
        await adapter.deleteDoc!(id);
        store.unload(id);
        return text({ deleted: true, docId: id, name: doc.name });
      },
    );

  if (canWrite)
    server.registerTool(
      'update_node',
      {
        description:
          'Update a node: name, tag, visible, text content, and/or styles (deep-merged into base/breakpoints/states layers). Only pass what changes.',
        inputSchema: {
          docId: docIdParam,
          nodeId: z.string(),
          set: z
            .object({
              name: z.string().max(500).optional(),
              tag: z.string().max(80).optional(),
              visible: z.boolean().optional(),
              text: z
                .string()
                .max(1_000_000)
                .optional()
                .describe('Replace text content (text nodes only)'),
              // As with insert_nodes, keep discovery compact and run the full
              // nested schema at execution time. This avoids publishing the
              // style schema repeatedly for every breakpoint/state branch.
              styles: z
                .record(z.string(), z.unknown())
                .optional()
                .describe('StyleSheet patch with base, breakpoints, and states layers'),
            })
            .strict(),
        },
      },
      ({ docId, nodeId, set }) => {
        const { doc, id } = requireDoc(docId, 'doc:write');
        if (!doc.nodes[nodeId]) throw new Error(`no node ${nodeId}`);
        const parsedStyles =
          set.styles === undefined ? undefined : zStyleSheet.partial().safeParse(set.styles);
        if (parsedStyles && !parsedStyles.success) {
          const issue = parsedStyles.error.issues[0];
          throw new Error(
            `invalid styles${issue?.path.length ? ` at ${issue.path.join('.')}` : ''}: ${issue?.message ?? 'invalid value'}`,
          );
        }
        store.applyRecipe(
          id,
          'mcp',
          `MCP: update ${doc.nodes[nodeId]!.name}`,
          (draft) => {
            const node = draft.nodes[nodeId]!;
            if (set.name !== undefined) node.name = set.name;
            if (set.tag !== undefined) node.tag = set.tag;
            if (set.visible !== undefined) node.visible = set.visible;
            if (set.text !== undefined && node.type === 'text') {
              node.content = [{ text: set.text }] as TextSpan[];
            }
            if (parsedStyles?.success) mergeStyles(node.styles as StyleSheet, parsedStyles.data);
          },
          actor,
        );
        const after = store.get(id)!.doc;
        return text({
          ok: true,
          node: confirmLine(after, nodeId),
          styles: styleSummary(after.nodes[nodeId]!.styles.base),
        });
      },
    );

  if (canWrite)
    server.registerTool(
      'delete_nodes',
      {
        description:
          'Delete ordinary nodes and their subtrees. Component masters and component content roots are protected.',
        inputSchema: { docId: docIdParam, nodeIds: z.array(z.string()).min(1) },
      },
      ({ docId, nodeIds }) => {
        const { doc, id } = requireDoc(docId, 'doc:write');
        const names = nodeIds.map((nid) => doc.nodes[nid]?.name ?? nid);
        const requestedDeletion = new Set(nodeIds.flatMap((nid) => subtreeIds(doc.nodes, nid)));
        const protectedComponent = Object.values(doc.components).find(
          (component) =>
            requestedDeletion.has(component.rootId) ||
            requestedDeletion.has(component.contentRootId),
        );
        if (protectedComponent) {
          throw new Error(
            `cannot delete the ${protectedComponent.name} component root; manage the component in the editor`,
          );
        }
        store.applyRecipe(
          id,
          'mcp',
          `MCP: delete ${names.join(', ')}`,
          (draft) => {
            const allDeleted: string[] = [];
            for (const nid of nodeIds) {
              const node = draft.nodes[nid];
              if (!node) continue;
              if (node.parent) {
                const parent = draft.nodes[node.parent];
                if (parent) parent.children = parent.children.filter((c) => c !== nid);
              } else {
                draft.rootOrder = draft.rootOrder.filter((r) => r !== nid);
              }
              // Delete subtree.
              const stack = [nid];
              while (stack.length > 0) {
                const cur = stack.pop()!;
                const n = draft.nodes[cur];
                if (!n) continue;
                stack.push(...n.children);
                delete draft.nodes[cur];
                allDeleted.push(cur);
              }
            }
            pruneCommentsForNodes(draft.comments, allDeleted);
            const deleted = new Set(allDeleted);
            for (const component of Object.values(draft.components)) {
              for (const [key, patches] of Object.entries(component.variants)) {
                for (const deletedId of deleted) delete patches[deletedId];
                if (Object.keys(patches).length === 0) delete component.variants[key];
              }
            }
            for (const node of Object.values(draft.nodes)) {
              if (node.type !== 'instance') continue;
              for (const deletedId of deleted) delete node.overrides[deletedId];
            }
          },
          actor,
        );
        return text({ deleted: names });
      },
    );

  // Export + drift need a local directory to write into — a capability
  // only some storage adapters provide.
  const exportBaseDir = adapter.exportBaseDir;
  if (exportBaseDir !== undefined) {
    if (canWrite)
      server.registerTool(
        'export_project',
        {
          description:
            'Export the document as a code project with a manifest for drift checks. Set annotate=true to add source node ids to JSX.',
          inputSchema: {
            docId: docIdParam,
            annotate: z.boolean().default(false).optional(),
          },
        },
        async ({ docId, annotate }) => {
          const { doc } = requireDoc(docId, 'export');
          const result = await exportProject(doc, exportBaseDir, { annotate }, adapter.assets);
          return text({ dir: result.dir, files: result.files });
        },
      );

    server.registerTool(
      'check_drift',
      {
        description:
          'Compare the current document and project files with the last export. Returns in-sync, design-updated, file-edited, both, or missing for each file.',
        inputSchema: { docId: docIdParam },
      },
      ({ docId }) => {
        const { doc } = requireDoc(docId);
        const entries = checkDrift(doc, exportBaseDir);
        if (entries === null) {
          return text('no export found for this document; run export_project first');
        }
        const drifted = entries.filter((e) => e.status !== 'in-sync');
        const lines = entries.map((e) => `${e.status.padEnd(15)} ${e.path}`);
        const advice: string[] = [];
        if (
          drifted.some(
            (e) => e.status === 'design-updated' || e.status === 'both' || e.status === 'missing',
          )
        ) {
          advice.push(
            'design changed since the last export; run export_project or update the files from get_design_as_code',
          );
        }
        if (drifted.some((e) => e.status === 'file-edited' || e.status === 'both')) {
          advice.push(
            'files were edited since the last export. A new export will overwrite them; update the document first or export selectively',
          );
        }
        if (drifted.length === 0) advice.push('everything in sync');
        return text([...lines, '', ...advice].join('\n'));
      },
    );
  }

  if (canWrite)
    server.registerTool(
      'import_design_system',
      {
        description:
          'Import design tokens from CSS. Pass Tailwind v4 @theme or :root variables with --color-*, --spacing-*, --radius-*, --shadow-*, --font-*, or --text-* prefixes. Existing token names are overwritten.',
        inputSchema: {
          docId: docIdParam,
          css: z.string().min(1).max(500_000).describe('Raw CSS text containing the variables'),
        },
      },
      ({ docId, css }) => {
        const { id } = requireDoc(docId, 'doc:write');
        const parsed = parseCssTokens(css);
        if (parsed.count === 0) {
          throw new Error(
            `no recognizable tokens found${parsed.skipped.length > 0 ? ` (${parsed.skipped.length} declarations could not be parsed)` : ''}; expected --color-*/--spacing-*/--radius-*/--shadow-*/--font-*/--text-* custom properties`,
          );
        }
        store.applyRecipe(
          id,
          'mcp',
          `MCP: import ${parsed.count} design tokens`,
          (draft) => {
            mergeParsedTokens(draft.tokens, parsed.tokens);
          },
          actor,
        );
        return text({
          imported: {
            color: Object.keys(parsed.tokens.color).length,
            spacing: Object.keys(parsed.tokens.spacing).length,
            radius: Object.keys(parsed.tokens.radius).length,
            shadow: Object.keys(parsed.tokens.shadow).length,
            fontFamily: Object.keys(parsed.tokens.fontFamily).length,
            fontSize: Object.keys(parsed.tokens.fontSize).length,
          },
          skipped: parsed.skipped.slice(0, 20),
        });
      },
    );

  if (canWrite)
    server.registerTool(
      'add_comment',
      {
        description: 'Add a comment to a node in the editor.',
        inputSchema: {
          docId: docIdParam,
          nodeId: z.string(),
          text: z.string().min(1).max(2000),
        },
      },
      ({ docId, nodeId, text: commentText }) => {
        const { doc, id } = requireDoc(docId, 'doc:write');
        const node = doc.nodes[nodeId];
        if (!node) throw new Error(`no node ${nodeId}`);
        const comment: PitoletComment = {
          id: newId(),
          nodeId,
          text: commentText,
          author: 'agent',
          createdAt: Date.now(),
        };
        store.applyRecipe(
          id,
          'mcp',
          `MCP: comment on ${node.name}`,
          (draft) => {
            draft.comments = draft.comments ?? {};
            draft.comments[comment.id] = comment;
          },
          actor,
        );
        return text({ commentId: comment.id, on: confirmLine(doc, nodeId) });
      },
    );

  server.registerTool(
    'get_comments',
    {
      description: 'List comments, optionally filtered by node.',
      inputSchema: {
        docId: docIdParam,
        nodeId: z.string().optional().describe('Only comments on this node'),
        includeResolved: z.boolean().default(false).optional(),
      },
    },
    ({ docId, nodeId, includeResolved }) => {
      const { doc } = requireDoc(docId);
      const comments = Object.values(doc.comments ?? {})
        .filter((c) => doc.nodes[c.nodeId]) // skip orphans
        .filter((c) => (nodeId ? c.nodeId === nodeId : true))
        .filter((c) => (includeResolved ? true : !c.resolved))
        .sort((a, b) => a.createdAt - b.createdAt);
      if (comments.length === 0) return text('no comments');
      const lines = comments.map((c) => {
        const node = doc.nodes[c.nodeId]!;
        return `[${c.id}] on "${node.name}" (${c.nodeId}) by ${c.author}${c.resolved ? ' [resolved]' : ''}: ${c.text}`;
      });
      return text(lines.join('\n'));
    },
  );

  if (canWrite)
    server.registerTool(
      'resolve_comment',
      {
        description: 'Mark a comment as resolved (e.g. after addressing its request).',
        inputSchema: { docId: docIdParam, commentId: z.string() },
      },
      ({ docId, commentId }) => {
        const { doc, id } = requireDoc(docId, 'doc:write');
        if (!doc.comments?.[commentId]) throw new Error(`no comment ${commentId}`);
        store.applyRecipe(
          id,
          'mcp',
          'MCP: resolve comment',
          (draft) => {
            const comment = draft.comments?.[commentId];
            if (comment) comment.resolved = true;
          },
          actor,
        );
        return text({ resolved: commentId });
      },
    );

  if (canWrite)
    server.registerTool(
      'set_tokens',
      {
        description:
          'Merge design-token changes. Set a token to null to delete it. Updates appear on every bound layer.',
        inputSchema: {
          docId: docIdParam,
          patch: z
            .record(z.string(), z.unknown())
            .refine(
              (value) => isJsonWithinLimits(value, MAX_PATCH_VALUE_DEPTH, MAX_PATCH_VALUE_ENTRIES),
              'token patch is too deeply nested or complex',
            ),
        },
      },
      ({ docId, patch }) => {
        const { id } = requireDoc(docId, 'doc:write');
        store.applyRecipe(
          id,
          'mcp',
          'MCP: update tokens',
          (draft) => {
            mergeTokens(draft.tokens as unknown as Record<string, unknown>, patch);
          },
          actor,
        );
        const t = store.get(id)!.doc.tokens;
        return text({
          counts: {
            color: Object.keys(t.color).length,
            spacing: Object.keys(t.spacing).length,
            radius: Object.keys(t.radius).length,
            shadow: Object.keys(t.shadow).length,
            fontFamily: Object.keys(t.typography.fontFamily).length,
            fontSize: Object.keys(t.typography.fontSize).length,
          },
        });
      },
    );
}

// ---------------------------------------------------------------------------

function specToNode(spec: NodeSpec): PitoletNode {
  const type =
    spec.type ?? (spec.text !== undefined ? 'text' : spec.src !== undefined ? 'image' : 'element');
  switch (type) {
    case 'text':
      return createText({
        name: spec.name ?? 'Text',
        tag: spec.tag,
        text: spec.text ?? 'Text',
        styles: spec.styles,
      });
    case 'image':
      return createImage({
        name: spec.name,
        src: { url: spec.src ?? '' },
        alt: spec.alt ?? '',
        styles: spec.styles,
      });
    case 'frame':
    case 'element':
    default:
      return createElement({ name: spec.name ?? 'Box', tag: spec.tag, styles: spec.styles });
  }
}

function mergeStyles(target: StyleSheet, patch: Partial<StyleSheet>): void {
  if (patch.base) Object.assign(target.base, patch.base);
  if (patch.breakpoints) {
    target.breakpoints = target.breakpoints ?? {};
    for (const [bp, decl] of Object.entries(patch.breakpoints)) {
      target.breakpoints[bp] = { ...target.breakpoints[bp], ...decl };
    }
  }
  if (patch.states) {
    target.states = target.states ?? {};
    for (const [state, decl] of Object.entries(patch.states)) {
      const key = state as keyof NonNullable<StyleSheet['states']>;
      target.states[key] = { ...target.states[key], ...decl };
    }
  }
}

/**
 * Screenshot without an editor: render the frame's generated HTML in headless
 * Chromium. Docker runtimes install the matching browser during the image
 * build; local operators can install it explicitly. We never trigger a
 * browser download from an MCP read operation.
 */
async function headlessScreenshot(
  doc: PitoletDocument,
  frameId: NodeId,
  maxSize: number,
  assets: StorageAdapter['assets'],
  viewportWidth?: number,
  state?: StateName,
): Promise<string> {
  const frame = doc.nodes[frameId];
  if (!frame || frame.type !== 'frame') throw new Error(`no frame ${frameId}`);

  const width = viewportWidth ?? frame.canvas.width;
  const height = frame.canvas.height === 'auto' ? 800 : frame.canvas.height;
  if (width > 16_384 || height > 16_384) {
    throw new Error('frame is too large for a safe headless screenshot');
  }
  const scale = Math.min(1, maxSize / Math.max(width, height, 1));

  const { chromium } = await import('playwright-core');
  const browser = await launchChromium(chromium, undefined, async () => {
    throw new Error(
      'Playwright Chromium is not installed in the Pitolet runtime. Install it with `npx playwright-core install chromium`, or ask the server operator to include the compatible browser.',
    );
  });
  try {
    const page = await browser.newPage({
      viewport: { width: Math.round(width), height: Math.round(height) },
      deviceScaleFactor: scale,
    });
    await page.route('**/*', async (route) => {
      const requestUrl = new URL(route.request().url());
      if (
        requestUrl.origin !== 'http://pitolet.local' ||
        !requestUrl.pathname.startsWith('/assets/')
      ) {
        await route.abort('blockedbyclient');
        return;
      }
      let assetId: string;
      try {
        assetId = decodeURIComponent(requestUrl.pathname.slice('/assets/'.length));
      } catch {
        await route.fulfill({ status: 400, body: 'invalid asset id' });
        return;
      }
      const found = await assets.get(assetId);
      if (!found) {
        await route.fulfill({ status: 404, body: 'asset not found' });
        return;
      }
      try {
        const body = await readBoundedStream(found.stream, 20 * 1024 * 1024);
        await route.fulfill({ status: 200, contentType: found.mime, body });
      } catch {
        found.stream.destroy();
        await route.fulfill({ status: 500, body: 'asset read failed' });
      }
    });
    let html = buildPreviewHtml(doc, frameId).replace(
      '<head>',
      '<head>\n<base href="http://pitolet.local/">',
    );
    if (state) {
      const forceClass = `pitolet-force-${state}`;
      html = html.replace(new RegExp(`:${state}(?![a-z-])`, 'g'), `:is(:${state}, .${forceClass})`);
    }
    await page.setContent(html, { waitUntil: 'load' });
    if (state) {
      await page.locator('body *').evaluateAll((elements, forcedState) => {
        for (const element of elements) element.classList.add(`pitolet-force-${forcedState}`);
      }, state);
    }
    const buffer = await page.screenshot({
      type: 'jpeg',
      quality: 85,
      fullPage: frame.canvas.height === 'auto',
    });
    return `data:image/jpeg;base64,${buffer.toString('base64')}`;
  } finally {
    await browser.close();
  }
}

async function readBoundedStream(
  stream: NodeJS.ReadableStream & { destroy(error?: Error): void },
  maximum: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maximum) {
      stream.destroy();
      throw new Error(`asset exceeds ${maximum} bytes`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, bytes);
}

function mergeTokens(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete target[key];
    } else if (
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof target[key] === 'object' &&
      target[key] !== null &&
      !('$value' in (value as object))
    ) {
      mergeTokens(target[key] as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      target[key] = value;
    }
  }
}
