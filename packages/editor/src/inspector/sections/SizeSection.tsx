import type { FrameNode, PitoletDocument } from '@pitolet/schema';
import { NumberScrubInput } from '@pitolet/ui';
import type { Draft } from 'immer';
import { useShallow } from 'zustand/react/shallow';
import { duplicateNodes } from '../../store/mutations.js';
import { useEditor } from '../../store/index.js';
import { Row, Section, SizeField } from '../fields.js';
import { setStyle, useCoalesceKey, useStyleValue } from '../useStyle.js';

/** Duplicate a frame beside the original at a new width (responsive check). */
function duplicateAtWidth(
  draft: Draft<PitoletDocument>,
  frameId: string,
  width: number,
): string[] {
  const ids = duplicateNodes(draft, [frameId]);
  const source = draft.nodes[frameId];
  const clone = ids[0] ? draft.nodes[ids[0]] : undefined;
  if (clone?.type === 'frame' && source?.type === 'frame') {
    clone.canvas.x = source.canvas.x + source.canvas.width + 80;
    clone.canvas.y = source.canvas.y;
    clone.canvas.width = width;
    clone.name = `${source.name} @ ${width}`;
  }
  return ids;
}

/**
 * Size for in-flow nodes (CSS width/height with units/auto/fill); canvas
 * bounds (x/y/w/h) when the selection is a top-level frame.
 */
export function SizeSection() {
  const allTopLevelFrames = useEditor(
    useShallow((s) => s.selection.every((id) => s.doc?.nodes[id]?.parent === null)),
  );
  return allTopLevelFrames ? <FrameBoundsSection /> : <FlowSizeSection />;
}

function FlowSizeSection() {
  const width = useStyleValue('width');
  const height = useStyleValue('height');
  return (
    <Section title="Size">
      <Row label="Width">
        <SizeField
          value={width.value ?? undefined}
          mixed={width.mixed}
          label="W"
          onWrite={(size, key) => setStyle('Set width', (d) => (d.width = size), key)}
        />
      </Row>
      <Row label="Height">
        <SizeField
          value={height.value ?? undefined}
          mixed={height.mixed}
          label="H"
          onWrite={(size, key) => setStyle('Set height', (d) => (d.height = size), key)}
        />
      </Row>
    </Section>
  );
}

/** World-space height of a rendered frame (screen rect ÷ camera zoom). */
function measuredFrameHeight(id: string): number {
  const el = document.querySelector(`[data-node-id="${id}"]`);
  const viewport = document.querySelector('[data-canvas-viewport]');
  const zoom = viewport
    ? Number.parseFloat(getComputedStyle(viewport as HTMLElement).getPropertyValue('--cam-zoom')) || 1
    : 1;
  return Math.round((el?.getBoundingClientRect().height ?? 600) / zoom);
}

function FrameBoundsSection() {
  const frames = useEditor(
    useShallow((s) =>
      s.selection
        .map((id) => s.doc?.nodes[id])
        .filter((n): n is FrameNode => n?.type === 'frame'),
    ),
  );
  const keys = useCoalesceKey();
  if (frames.length === 0) return null;

  const first = frames[0]!;
  const same = (pick: (f: FrameNode) => number | 'auto') =>
    frames.every((f) => pick(f) === pick(first)) ? pick(first) : null;

  const x = same((f) => f.canvas.x);
  const y = same((f) => f.canvas.y);
  const w = same((f) => f.canvas.width);
  const h = same((f) => (f.canvas.height === 'auto' ? 'auto' : f.canvas.height));

  const writeBounds = (
    label: string,
    write: (canvas: FrameNode['canvas'], value: number) => void,
    value: number,
    key: string,
  ) => {
    const ids = frames.map((f) => f.id);
    useEditor.getState().dispatchEdit(
      label,
      (draft) => {
        for (const id of ids) {
          const node = draft.nodes[id];
          if (node?.type === 'frame') write(node.canvas, value);
        }
      },
      { coalesceKey: key },
    );
  };

  return (
    <Section title="Frame">
      <Row label="Position">
        <NumberScrubInput
          value={x === 'auto' ? null : x}
          label="X"
          min={-Infinity}
          onChange={(v, o) => {
            if (!o.transient) keys.begin();
            writeBounds('Move frame', (c, val) => (c.x = Math.round(val)), v, keys.current());
          }}
          onCommit={() => keys.begin()}
        />
        <NumberScrubInput
          value={y === 'auto' ? null : y}
          label="Y"
          min={-Infinity}
          onChange={(v, o) => {
            if (!o.transient) keys.begin();
            writeBounds('Move frame', (c, val) => (c.y = Math.round(val)), v, keys.current());
          }}
          onCommit={() => keys.begin()}
        />
      </Row>
      <Row label="Size">
        <NumberScrubInput
          value={w === 'auto' ? null : w}
          label="W"
          min={16}
          onChange={(v, o) => {
            if (!o.transient) keys.begin();
            writeBounds('Resize frame', (c, val) => (c.width = Math.round(val)), v, keys.current());
          }}
          onCommit={() => keys.begin()}
        />
        <NumberScrubInput
          value={h === 'auto' ? null : (h as number)}
          label="H"
          min={16}
          onChange={(v, o) => {
            if (!o.transient) keys.begin();
            writeBounds('Resize frame', (c, val) => (c.height = Math.round(val)), v, keys.current());
          }}
          onCommit={() => keys.begin()}
        />
      </Row>
      <Row label="Duplicate">
        {[375, 768, 1280].map((w) => (
          <button
            key={w}
            type="button"
            className="ptl-auto-height"
            title={`Duplicate this frame at ${w}px width (responsive preview side-by-side)`}
            onClick={() => {
              const store = useEditor.getState();
              const source = frames[0];
              if (!source) return;
              let newIds: string[] = [];
              store.dispatchEdit(`Duplicate @ ${w}`, (draft) => {
                newIds = duplicateAtWidth(draft, source.id, w);
              });
              if (newIds.length) store.select(newIds);
            }}
          >
            @ {w}
          </button>
        ))}
      </Row>
      <Row label="">
        <button
          type="button"
          className={`ptl-auto-height ${h === 'auto' ? 'ptl-auto-height--on' : ''}`}
          onClick={() => {
            const ids = frames.map((f) => f.id);
            useEditor.getState().dispatchEdit('Toggle auto height', (draft) => {
              for (const id of ids) {
                const node = draft.nodes[id];
                if (node?.type === 'frame') {
                  node.canvas.height =
                    node.canvas.height === 'auto' ? measuredFrameHeight(id) : 'auto';
                }
              }
            });
          }}
        >
          {h === 'auto' ? 'Auto height ✓' : 'Auto height'}
        </button>
      </Row>
    </Section>
  );
}
