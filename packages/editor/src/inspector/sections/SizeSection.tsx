import type { FrameNode, Length, Size, StyleValue } from '@pitolet/schema';
import { IconButton, NumberScrubInput, Tooltip } from '@pitolet/ui';
import { MoveVertical, SlidersHorizontal } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useEditor } from '../../store/index.js';
import { AUTO_HEIGHT_FALLBACK, renderedFrameHeight } from '../../canvas/frameMeasurements.js';
import { Row, Section, SizeField } from '../fields.js';
import { setStyle, styleContextFor, useCoalesceKey, useStyleValue } from '../useStyle.js';

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
  const minWidth = useStyleValue('minWidth');
  const maxWidth = useStyleValue('maxWidth');
  const minHeight = useStyleValue('minHeight');
  const maxHeight = useStyleValue('maxHeight');
  const hasConstraints = [minWidth, maxWidth, minHeight, maxHeight].some(
    (readout) => readout.value != null,
  );
  const selectionKey = useEditor((state) => state.selection.join(','));
  const [showConstraints, setShowConstraints] = useState(hasConstraints);
  useEffect(() => setShowConstraints(hasConstraints), [hasConstraints, selectionKey]);
  const warnings = sizeConstraintWarnings({
    width: width.value,
    height: height.value,
    minWidth: minWidth.value,
    maxWidth: maxWidth.value,
    minHeight: minHeight.value,
    maxHeight: maxHeight.value,
  });
  return (
    <Section
      title="Size"
      actions={
        <Tooltip content={showConstraints ? 'Hide size constraints' : 'Show size constraints'}>
          <IconButton
            label="Size constraints"
            size="sm"
            active={showConstraints}
            onClick={() => setShowConstraints((shown) => !shown)}
          >
            <SlidersHorizontal size={12} />
          </IconButton>
        </Tooltip>
      }
    >
      <Row label="Width" styleContext={styleContextFor(width, 'width', 'width')}>
        <SizeField
          value={width.value ?? undefined}
          mixed={width.mixed}
          label="W"
          onWrite={(size, key) => setStyle('Set width', (d) => (d.width = size), key)}
        />
      </Row>
      <Row label="Height" styleContext={styleContextFor(height, 'height', 'height')}>
        <SizeField
          value={height.value ?? undefined}
          mixed={height.mixed}
          label="H"
          onWrite={(size, key) => setStyle('Set height', (d) => (d.height = size), key)}
        />
      </Row>
      {showConstraints && (
        <>
          <Row
            label="Min width"
            styleContext={styleContextFor(minWidth, 'minWidth', 'minimum width')}
          >
            <SizeField
              value={minWidth.value ?? undefined}
              mixed={minWidth.mixed}
              label="W"
              mode="constraint"
              onWrite={(size, key) =>
                setStyle(
                  'Set minimum width',
                  (d) => {
                    if (size === 'auto' || size === undefined) delete d.minWidth;
                    else d.minWidth = size;
                  },
                  key,
                )
              }
            />
          </Row>
          <Row
            label="Max width"
            styleContext={styleContextFor(maxWidth, 'maxWidth', 'maximum width')}
          >
            <SizeField
              value={maxWidth.value ?? undefined}
              mixed={maxWidth.mixed}
              label="W"
              mode="constraint"
              onWrite={(size, key) =>
                setStyle(
                  'Set maximum width',
                  (d) => {
                    if (size === 'auto' || size === undefined) delete d.maxWidth;
                    else d.maxWidth = size;
                  },
                  key,
                )
              }
            />
          </Row>
          <Row
            label="Min height"
            styleContext={styleContextFor(minHeight, 'minHeight', 'minimum height')}
          >
            <SizeField
              value={minHeight.value ?? undefined}
              mixed={minHeight.mixed}
              label="H"
              mode="constraint"
              onWrite={(size, key) =>
                setStyle(
                  'Set minimum height',
                  (d) => {
                    if (size === 'auto' || size === undefined) delete d.minHeight;
                    else d.minHeight = size;
                  },
                  key,
                )
              }
            />
          </Row>
          <Row
            label="Max height"
            styleContext={styleContextFor(maxHeight, 'maxHeight', 'maximum height')}
          >
            <SizeField
              value={maxHeight.value ?? undefined}
              mixed={maxHeight.mixed}
              label="H"
              mode="constraint"
              onWrite={(size, key) =>
                setStyle(
                  'Set maximum height',
                  (d) => {
                    if (size === 'auto' || size === undefined) delete d.maxHeight;
                    else d.maxHeight = size;
                  },
                  key,
                )
              }
            />
          </Row>
        </>
      )}
      {warnings.map((warning) => (
        <div key={warning} className="ptl-insp-warning">
          {warning}
        </div>
      ))}
    </Section>
  );
}

type ConstraintValues = Record<
  'width' | 'height' | 'minWidth' | 'maxWidth' | 'minHeight' | 'maxHeight',
  StyleValue<Size> | null | undefined
>;

function literalLength(value: StyleValue<Size> | null | undefined): Length | null {
  if (!value || value === 'auto' || value === 'fill' || typeof value !== 'object') return null;
  if (!('value' in value) || !('unit' in value)) return null;
  return value as Length;
}

/** Human-readable conflicts for constraints the browser would otherwise silently clamp. */
export function sizeConstraintWarnings(values: ConstraintValues): string[] {
  const warnings: string[] = [];
  for (const axis of ['width', 'height'] as const) {
    const value = literalLength(values[axis]);
    const min = literalLength(values[axis === 'width' ? 'minWidth' : 'minHeight']);
    const max = literalLength(values[axis === 'width' ? 'maxWidth' : 'maxHeight']);
    const label = axis === 'width' ? 'Width' : 'Height';
    if (min && max && min.unit === max.unit && min.value > max.value) {
      warnings.push(`${label}: minimum is larger than maximum.`);
      continue;
    }
    if (value && min && value.unit === min.unit && value.value < min.value) {
      warnings.push(`${label} will be clamped to its minimum.`);
    }
    if (value && max && value.unit === max.unit && value.value > max.value) {
      warnings.push(`${label} will be clamped to its maximum.`);
    }
  }
  return warnings;
}

/** World-space height of a rendered frame (screen rect ÷ camera zoom). */
function measuredFrameHeight(id: string): number {
  return Math.round(renderedFrameHeight(id) ?? AUTO_HEIGHT_FALLBACK);
}

function FrameBoundsSection() {
  const frames = useEditor(
    useShallow((s) =>
      s.selection.map((id) => s.doc?.nodes[id]).filter((n): n is FrameNode => n?.type === 'frame'),
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

  const toggleAutoHeight = () => {
    const ids = frames.map((frame) => frame.id);
    const useAutoHeight = !frames.every((frame) => frame.canvas.height === 'auto');
    useEditor.getState().dispatchEdit('Toggle auto height', (draft) => {
      for (const id of ids) {
        const node = draft.nodes[id];
        if (node?.type !== 'frame') continue;
        node.canvas.height = useAutoHeight ? 'auto' : measuredFrameHeight(id);
      }
    });
  };

  return (
    <Section title="Canvas">
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
          placeholder={h === 'auto' ? 'Auto' : 'Mixed'}
          min={16}
          onChange={(v, o) => {
            if (!o.transient) keys.begin();
            writeBounds(
              'Resize frame',
              (c, val) => (c.height = Math.round(val)),
              v,
              keys.current(),
            );
          }}
          onCommit={() => keys.begin()}
        />
        <Tooltip content={h === 'auto' ? 'Use fixed height' : 'Use automatic height'}>
          <IconButton
            label={h === 'auto' ? 'Use fixed height' : 'Use automatic height'}
            size="sm"
            active={h === 'auto'}
            onClick={toggleAutoHeight}
          >
            <MoveVertical size={13} />
          </IconButton>
        </Tooltip>
      </Row>
    </Section>
  );
}
