import {
  oklch,
  px,
  type Color,
  type Fill,
  type Position,
  type Shadow,
  type StyleValue,
  type Track,
} from '@pitolet/schema';
import { IconButton, NumberScrubInput, Select, Tooltip } from '@pitolet/ui';
import { Plus, X } from 'lucide-react';
import { ColorField, LengthField, Row, Section } from '../fields.js';
import { setStyle, useCoalesceKey, useStyleValue } from '../useStyle.js';

/** Shadows, gradient fills, grid template, and absolute positioning. */

export function ShadowSection() {
  const shadows = useStyleValue('shadows');
  const list = shadows.value ?? [];
  const keys = useCoalesceKey();

  const writeShadow = (index: number, patch: Partial<Shadow>, coalesce = false) =>
    setStyle(
      'Edit shadow',
      (d) => {
        if (d.shadows?.[index]) Object.assign(d.shadows[index]!, patch);
      },
      coalesce ? keys.current() : undefined,
    );

  return (
    <Section
      title="Shadow"
      actions={
        <Tooltip content="Add shadow">
          <IconButton
            label="Add shadow"
            size="sm"
            onClick={() =>
              setStyle('Add shadow', (d) => {
                d.shadows = d.shadows ?? [];
                d.shadows.push({ x: 0, y: 2, blur: 8, spread: -1, color: oklch(0.2, 0.02, 250, 0.15) });
              })
            }
          >
            <Plus size={13} />
          </IconButton>
        </Tooltip>
      }
    >
      {list.length === 0 && <span className="ptl-insp-hint">No shadow</span>}
      {list.map((shadow, i) => (
        <div key={i}>
          <Row>
            <ColorField
              value={shadow.color}
              mixed={shadows.mixed}
              onWrite={(c, key) =>
                setStyle('Set shadow color', (d) => {
                  if (d.shadows?.[i]) d.shadows[i]!.color = c;
                }, key)
              }
            />
            <Tooltip content="Remove shadow">
              <IconButton
                label="Remove shadow"
                size="sm"
                onClick={() =>
                  setStyle('Remove shadow', (d) => {
                    d.shadows?.splice(i, 1);
                    if (d.shadows?.length === 0) delete d.shadows;
                  })
                }
              >
                <X size={12} />
              </IconButton>
            </Tooltip>
          </Row>
          <Row>
            {(
              [
                ['X', 'x'],
                ['Y', 'y'],
                ['B', 'blur'],
                ['S', 'spread'],
              ] as const
            ).map(([label, field]) => (
              <NumberScrubInput
                key={field}
                value={shadow[field]}
                label={label}
                min={field === 'blur' ? 0 : -200}
                onChange={(v, o) => {
                  if (!o.transient) keys.begin();
                  writeShadow(i, { [field]: v }, true);
                }}
                onCommit={() => keys.begin()}
                className="ptl-field-scrub"
              />
            ))}
          </Row>
        </div>
      ))}
    </Section>
  );
}

// ---------------------------------------------------------------------------

export function GradientControls() {
  const fills = useStyleValue('fills');
  const gradient = fills.value?.find((f): f is Extract<Fill, { type: 'linear' }> => f.type === 'linear');
  const keys = useCoalesceKey();

  if (!gradient) {
    return (
      <Row>
        <button
          type="button"
          className="ptl-auto-height"
          onClick={() =>
            setStyle('Add gradient', (d) => {
              d.fills = [
                {
                  type: 'linear',
                  angle: 135,
                  stops: [
                    { color: oklch(0.6, 0.15, 260), position: 0 },
                    { color: oklch(0.72, 0.12, 195), position: 1 },
                  ],
                },
              ];
            })
          }
        >
          Use linear gradient
        </button>
      </Row>
    );
  }

  const writeStopColor = (index: number) => (c: Color, key: string) =>
    setStyle(
      'Set gradient stop',
      (d) => {
        const g = d.fills?.find((f) => f.type === 'linear');
        if (g && g.type === 'linear' && g.stops[index]) g.stops[index]!.color = c;
      },
      key,
    );

  return (
    <>
      <Row label="Angle">
        <NumberScrubInput
          value={gradient.angle}
          label="°"
          min={0}
          max={360}
          onChange={(v, o) => {
            if (!o.transient) keys.begin();
            setStyle(
              'Set gradient angle',
              (d) => {
                const g = d.fills?.find((f) => f.type === 'linear');
                if (g && g.type === 'linear') g.angle = v;
              },
              keys.current(),
            );
          }}
          onCommit={() => keys.begin()}
          className="ptl-field-scrub"
        />
      </Row>
      {gradient.stops.map((stop, i) => (
        <Row key={i} label={i === 0 ? 'From' : 'To'}>
          <ColorField
            value={stop.color as StyleValue<Color>}
            mixed={fills.mixed}
            onWrite={writeStopColor(i)}
          />
        </Row>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------

export function GridControls() {
  const display = useStyleValue('display');
  const columns = useStyleValue('gridTemplateColumns');
  const keys = useCoalesceKey();
  if (display.value !== 'grid') return null;

  const count = columns.value?.length ?? 2;
  const allFr = columns.value?.every((t: Track) => t.kind === 'fr') ?? true;

  return (
    <Section title="Grid">
      <Row label="Columns">
      <NumberScrubInput
        value={count}
        min={1}
        max={12}
        onChange={(v, o) => {
          if (!o.transient) keys.begin();
          setStyle(
            'Set grid columns',
            (d) => {
              d.gridTemplateColumns = Array.from({ length: Math.round(v) }, (_, i) => {
                const existing = d.gridTemplateColumns?.[i];
                return existing ?? { kind: 'fr' as const, value: 1 };
              });
            },
            keys.current(),
          );
        }}
        onCommit={() => keys.begin()}
        className="ptl-field-scrub"
      />
        {!allFr && <span className="ptl-insp-hint">custom tracks</span>}
      </Row>
    </Section>
  );
}

// ---------------------------------------------------------------------------

const POSITIONS = [
  { value: 'static', label: 'In flow' },
  { value: 'relative', label: 'Relative' },
  { value: 'absolute', label: 'Absolute' },
  { value: 'sticky', label: 'Sticky' },
];

export function PositionSection() {
  const position = useStyleValue('position');
  const inset = useStyleValue('inset');
  const isPositioned = position.value === 'absolute' || position.value === 'sticky';

  return (
    <Section title="Position">
      <Row label="Type">
        <Select
          value={(position.value as string) ?? 'static'}
          options={POSITIONS}
          onValueChange={(v) =>
            setStyle('Set position', (d) => {
              if (v === 'static') {
                delete d.position;
                delete d.inset;
              } else {
                d.position = v as Position;
                if (v === 'absolute' && !d.inset) {
                  d.inset = { top: px(0), left: px(0) };
                }
              }
            })
          }
          className="ptl-insp-select"
        />
      </Row>
      {isPositioned && (
        <>
          <Row label="Inset">
            <LengthField
              value={inset.value?.top}
              mixed={inset.mixed}
              label="T"
              min={-9999}
              onWrite={(len, key) =>
                setStyle('Set inset', (d) => (d.inset = { ...d.inset, top: len }), key)
              }
            />
            <LengthField
              value={inset.value?.left}
              mixed={inset.mixed}
              label="L"
              min={-9999}
              onWrite={(len, key) =>
                setStyle('Set inset', (d) => (d.inset = { ...d.inset, left: len }), key)
              }
            />
          </Row>
          <Row label="">
            <LengthField
              value={inset.value?.bottom}
              mixed={inset.mixed}
              label="B"
              min={-9999}
              onWrite={(len, key) =>
                setStyle('Set inset', (d) => (d.inset = { ...d.inset, bottom: len }), key)
              }
            />
            <LengthField
              value={inset.value?.right}
              mixed={inset.mixed}
              label="R"
              min={-9999}
              onWrite={(len, key) =>
                setStyle('Set inset', (d) => (d.inset = { ...d.inset, right: len }), key)
              }
            />
          </Row>
        </>
      )}
    </Section>
  );
}
