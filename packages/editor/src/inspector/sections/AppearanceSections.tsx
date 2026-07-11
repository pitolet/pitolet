import {
  oklch,
  px,
  type Color,
  type Length,
  type Overflow,
  type StyleValue,
} from '@pitolet/schema';
import { IconButton, NumberScrubInput, Select, Tooltip } from '@pitolet/ui';
import { Plus, Scan, X } from 'lucide-react';
import { useEditor } from '../../store/index.js';
import { ColorField, LengthField, Row, Section, useResolved } from '../fields.js';
import { setStyle, useCoalesceKey, useStyleValue } from '../useStyle.js';

/** Fill (solid, M2), Border, Radius, and Effects sections. */

export function FillSection() {
  const fills = useStyleValue('fills');
  const solid = fills.value?.find((f) => f.type === 'solid');

  return (
    <Section
      title="Fill"
      actions={
        !solid ? (
          <Tooltip content="Add fill">
            <IconButton
              label="Add fill"
              size="sm"
              onClick={() =>
                setStyle('Add fill', (d) => {
                  d.fills = [{ type: 'solid', color: oklch(1, 0, 0) }];
                })
              }
            >
              <Plus size={13} />
            </IconButton>
          </Tooltip>
        ) : undefined
      }
    >
      {solid ? (
        <Row>
          <ColorField
            value={solid.color}
            mixed={fills.mixed}
            onWrite={(c, key) =>
              setStyle(
                'Set fill',
                (d) => {
                  const target = d.fills?.find((f) => f.type === 'solid');
                  if (target && target.type === 'solid') target.color = c;
                  else d.fills = [{ type: 'solid', color: c }];
                },
                key,
              )
            }
            onBind={(path) =>
              setStyle('Bind fill', (d) => {
                const target = d.fills?.find((f) => f.type === 'solid');
                if (target && target.type === 'solid') target.color = { $token: path };
                else d.fills = [{ type: 'solid', color: { $token: path } }];
              })
            }
          />
          <Tooltip content="Remove fill">
            <IconButton
              label="Remove fill"
              size="sm"
              onClick={() => setStyle('Remove fill', (d) => delete d.fills)}
            >
              <X size={12} />
            </IconButton>
          </Tooltip>
        </Row>
      ) : (
        <span className="ptl-insp-hint">No fill</span>
      )}
    </Section>
  );
}

export function BorderSection() {
  const border = useStyleValue('border');
  const b = border.value;

  return (
    <Section
      title="Border"
      actions={
        !b ? (
          <Tooltip content="Add border">
            <IconButton
              label="Add border"
              size="sm"
              onClick={() =>
                setStyle('Add border', (d) => {
                  d.border = {
                    width: px(1),
                    style: 'solid',
                    color: { $token: 'color.border' },
                  };
                })
              }
            >
              <Plus size={13} />
            </IconButton>
          </Tooltip>
        ) : undefined
      }
    >
      {b ? (
        <>
          <Row label="Color">
            <ColorField
              value={b.color}
              mixed={border.mixed}
              onWrite={(c, key) =>
                setStyle('Set border color', (d) => d.border && (d.border.color = c), key)
              }
              onBind={(path) =>
                setStyle('Bind border color', (d) => d.border && (d.border.color = { $token: path }))
              }
            />
            <Tooltip content="Remove border">
              <IconButton
                label="Remove border"
                size="sm"
                onClick={() => setStyle('Remove border', (d) => delete d.border)}
              >
                <X size={12} />
              </IconButton>
            </Tooltip>
          </Row>
          <Row label="Width">
            <LengthField
              value={b.width}
              mixed={border.mixed}
              label="W"
              onWrite={(len, key) =>
                setStyle('Set border width', (d) => d.border && (d.border.width = len), key)
              }
            />
            <Select
              value={b.style}
              options={[
                { value: 'solid', label: 'Solid' },
                { value: 'dashed', label: 'Dashed' },
                { value: 'dotted', label: 'Dotted' },
              ]}
              onValueChange={(v) =>
                setStyle('Set border style', (d) => d.border && (d.border.style = v as never))
              }
            />
          </Row>
        </>
      ) : (
        <span className="ptl-insp-hint">No border</span>
      )}
    </Section>
  );
}

export function RadiusSection() {
  const radius = useStyleValue('radius');
  const tl = useResolved(radius.value?.tl as StyleValue<Length> | undefined);
  const keys = useCoalesceKey();

  const uniform =
    radius.value === undefined ||
    (['tl', 'tr', 'br', 'bl'] as const).every((corner) => {
      const v = radius.value?.[corner];
      return JSON.stringify(v) === JSON.stringify(radius.value?.tl);
    });

  return (
    <Section title="Radius">
      <Row label="Corners">
        <NumberScrubInput
          value={radius.mixed || !uniform ? null : (tl.resolved?.value ?? 0)}
          label={<Scan size={12} />}
          min={0}
          onChange={(v, o) => {
            if (!o.transient) keys.begin();
            setStyle(
              'Set radius',
              (d) => {
                const len = px(v);
                d.radius = { tl: len, tr: len, br: len, bl: len };
              },
              keys.current(),
            );
          }}
          onCommit={() => keys.begin()}
          className="ptl-field-scrub"
        />
      </Row>
    </Section>
  );
}

export function ImageSection() {
  const objectFit = useStyleValue('objectFit');
  const alt = useEditor((s) => {
    const node = s.selection[0] ? s.doc?.nodes[s.selection[0]] : undefined;
    return node?.type === 'image' ? node.alt : undefined;
  });
  const selection = useEditor((s) => s.selection);

  return (
    <Section title="Image">
      <Row label="Fit">
        <Select
          value={(objectFit.value as string) ?? 'cover'}
          options={[
            { value: 'cover', label: 'Cover' },
            { value: 'contain', label: 'Contain' },
            { value: 'fill', label: 'Stretch' },
            { value: 'none', label: 'None' },
          ]}
          onValueChange={(v) => setStyle('Set object fit', (d) => (d.objectFit = v as never))}
          className="ptl-insp-select"
        />
      </Row>
      <Row label="Alt text">
        <input
          key={selection[0]}
          className="ptl-token-new"
          defaultValue={alt ?? ''}
          placeholder="Describe the image"
          onBlur={(e) => {
            const value = e.target.value;
            const ids = [...useEditor.getState().selection];
            useEditor.getState().dispatchEdit('Set alt text', (draft) => {
              for (const id of ids) {
                const node = draft.nodes[id];
                if (node?.type === 'image') node.alt = value;
              }
            });
          }}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
      </Row>
    </Section>
  );
}

export function EffectsSection() {
  const opacity = useStyleValue('opacity');
  const overflow = useStyleValue('overflow');
  const keys = useCoalesceKey();

  return (
    <Section title="Effects">
      <Row label="Opacity">
        <NumberScrubInput
          value={opacity.mixed ? null : Math.round((opacity.value ?? 1) * 100)}
          label="%"
          min={0}
          max={100}
          onChange={(v, o) => {
            if (!o.transient) keys.begin();
            setStyle(
              'Set opacity',
              (d) => {
                if (v >= 100) delete d.opacity;
                else d.opacity = v / 100;
              },
              keys.current(),
            );
          }}
          onCommit={() => keys.begin()}
          className="ptl-field-scrub"
        />
      </Row>
      <Row label="Overflow">
        <Select
          value={(overflow.value as string) ?? 'visible'}
          options={[
            { value: 'visible', label: 'Visible' },
            { value: 'hidden', label: 'Hidden' },
            { value: 'auto', label: 'Scroll (auto)' },
          ]}
          onValueChange={(v) =>
            setStyle('Set overflow', (d) => {
              if (v === 'visible') delete d.overflow;
              else d.overflow = v as Overflow;
            })
          }
          className="ptl-insp-select"
        />
      </Row>
    </Section>
  );
}

export type { Color };
