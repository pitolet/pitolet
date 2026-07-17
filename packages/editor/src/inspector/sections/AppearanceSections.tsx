import {
  oklch,
  px,
  type Color,
  type Length,
  type Overflow,
  type StyleValue,
} from '@pitolet/schema';
import { IconButton, NumberScrubInput, Select, Tooltip } from '@pitolet/ui';
import { Link2, Link2Off, Plus, Scan, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useEditor } from '../../store/index.js';
import {
  allStyleValuesEqual,
  BORDER_SIDES,
  readBorderSides,
  removeStyleBorder,
  removeStyleFill,
  toggleAllBorderSides,
  toggleBorderSide,
} from '../compoundControls.js';
import { ColorField, LengthField, Row, Section } from '../fields.js';
import { setStyle, styleContextFor, useCoalesceKey, useStyleValue } from '../useStyle.js';

/** Fill (solid, M2), Border, Radius, and Effects sections. */

export function FillSection({ children }: { children?: ReactNode }) {
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
        <Row label="Color" styleContext={styleContextFor(fills, 'fills', 'fill')}>
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
              onClick={() => setStyle('Remove fill', (d) => removeStyleFill(d, fills.contextual))}
            >
              <X size={12} />
            </IconButton>
          </Tooltip>
        </Row>
      ) : (
        <span className="ptl-insp-hint">No fill</span>
      )}
      {children}
    </Section>
  );
}

export function BorderSection() {
  const border = useStyleValue('border');
  const b = border.value;
  const sideState = readBorderSides(b?.sides);
  const allSides = BORDER_SIDES.every((side) => sideState[side]);

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
          <Row label="Color" styleContext={styleContextFor(border, 'border', 'border')}>
            <ColorField
              value={b.color}
              mixed={border.mixed}
              onWrite={(c, key) =>
                setStyle('Set border color', (d) => d.border && (d.border.color = c), key)
              }
              onBind={(path) =>
                setStyle(
                  'Bind border color',
                  (d) => d.border && (d.border.color = { $token: path }),
                )
              }
            />
            <Tooltip content="Remove border">
              <IconButton
                label="Remove border"
                size="sm"
                onClick={() =>
                  setStyle('Remove border', (d) => removeStyleBorder(d, border.contextual))
                }
              >
                <X size={12} />
              </IconButton>
            </Tooltip>
          </Row>
          <Row label="Width" styleContext={styleContextFor(border, 'border', 'border')}>
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
          <Row label="Sides" styleContext={styleContextFor(border, 'border', 'border')}>
            <Tooltip content={allSides ? 'Remove border from all sides' : 'Use all sides'}>
              <IconButton
                label="All border sides"
                size="sm"
                active={allSides}
                onClick={() =>
                  setStyle('Set border sides', (d) => {
                    if (!d.border) return;
                    const next = toggleAllBorderSides(d.border.sides);
                    if (next === undefined) delete d.border.sides;
                    else d.border.sides = next;
                  })
                }
              >
                <Scan size={12} />
              </IconButton>
            </Tooltip>
            {BORDER_SIDES.map((side) => (
              <Tooltip key={side} content={`${capitalize(side)} border`}>
                <IconButton
                  label={`${capitalize(side)} border`}
                  size="sm"
                  active={sideState[side]}
                  onClick={() =>
                    setStyle('Set border sides', (d) => {
                      if (!d.border) return;
                      const next = toggleBorderSide(d.border.sides, side);
                      if (next === undefined) delete d.border.sides;
                      else d.border.sides = next;
                    })
                  }
                >
                  <span className="ptl-border-side-label">{side[0]!.toUpperCase()}</span>
                </IconButton>
              </Tooltip>
            ))}
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
  const value = radius.value;
  const uniform = allStyleValuesEqual([value?.tl, value?.tr, value?.br, value?.bl]);
  const [linked, setLinked] = useState(true);
  const effectiveLinked = linked && uniform;

  const writeCorner =
    (corner: 'tl' | 'tr' | 'br' | 'bl' | 'all') => (len: StyleValue<Length>, key: string) =>
      setStyle(
        'Set radius',
        (d) => {
          const current = d.radius ?? { tl: px(0), tr: px(0), br: px(0), bl: px(0) };
          d.radius =
            corner === 'all'
              ? { tl: len, tr: len, br: len, bl: len }
              : { ...current, [corner]: len };
        },
        key,
      );

  const toggleLinked = () => {
    if (effectiveLinked) {
      setLinked(false);
      return;
    }
    const base = value?.tl ?? px(0);
    setStyle('Link radius corners', (d) => {
      d.radius = { tl: base, tr: base, br: base, bl: base };
    });
    setLinked(true);
  };

  return (
    <Section title="Radius">
      <Row label="Corners" styleContext={styleContextFor(radius, 'radius', 'radius')}>
        {effectiveLinked ? (
          <LengthField
            value={value?.tl}
            mixed={radius.mixed}
            label={<Scan size={12} />}
            title="All corners"
            tokenCategory="radius"
            onWrite={writeCorner('all')}
          />
        ) : (
          <>
            <LengthField
              value={value?.tl}
              mixed={radius.mixed}
              label="TL"
              title="Top-left radius"
              tokenCategory="radius"
              onWrite={writeCorner('tl')}
            />
            <LengthField
              value={value?.tr}
              mixed={radius.mixed}
              label="TR"
              title="Top-right radius"
              tokenCategory="radius"
              onWrite={writeCorner('tr')}
            />
          </>
        )}
        <Tooltip content={effectiveLinked ? 'Edit corners separately' : 'Link all corners'}>
          <IconButton
            label="Link corners"
            size="sm"
            active={effectiveLinked}
            onClick={toggleLinked}
          >
            {effectiveLinked ? <Link2 size={12} /> : <Link2Off size={12} />}
          </IconButton>
        </Tooltip>
      </Row>
      {!effectiveLinked && (
        <Row label="">
          <LengthField
            value={value?.bl}
            mixed={radius.mixed}
            label="BL"
            title="Bottom-left radius"
            tokenCategory="radius"
            onWrite={writeCorner('bl')}
          />
          <LengthField
            value={value?.br}
            mixed={radius.mixed}
            label="BR"
            title="Bottom-right radius"
            tokenCategory="radius"
            onWrite={writeCorner('br')}
          />
          <span className="ptl-insp-control-spacer" />
        </Row>
      )}
    </Section>
  );
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
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
      <Row label="Fit" styleContext={styleContextFor(objectFit, 'objectFit', 'image fit')}>
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
  const cursor = useStyleValue('cursor');
  const blendMode = useStyleValue('blendMode');
  const keys = useCoalesceKey();

  return (
    <Section title="Effects">
      <Row label="Opacity" styleContext={styleContextFor(opacity, 'opacity', 'opacity')}>
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
      <Row label="Overflow" styleContext={styleContextFor(overflow, 'overflow', 'overflow')}>
        <Select
          value={(overflow.value as string) ?? 'visible'}
          options={[
            { value: 'visible', label: 'Visible' },
            { value: 'hidden', label: 'Hidden' },
            { value: 'auto', label: 'Scroll (auto)' },
            { value: 'scroll', label: 'Always scroll' },
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
      <Row label="Cursor" styleContext={styleContextFor(cursor, 'cursor', 'cursor')}>
        <Select
          value={(cursor.value as string) ?? 'auto'}
          options={[
            { value: 'auto', label: 'Auto' },
            { value: 'default', label: 'Default' },
            { value: 'pointer', label: 'Pointer' },
            { value: 'text', label: 'Text' },
            { value: 'move', label: 'Move' },
            { value: 'grab', label: 'Grab' },
            { value: 'not-allowed', label: 'Not allowed' },
          ]}
          onValueChange={(v) =>
            setStyle('Set cursor', (d) => {
              if (v === 'auto') delete d.cursor;
              else d.cursor = v;
            })
          }
          className="ptl-insp-select"
        />
      </Row>
      <Row label="Blend" styleContext={styleContextFor(blendMode, 'blendMode', 'blend mode')}>
        <Select
          value={(blendMode.value as string) ?? 'normal'}
          options={[
            { value: 'normal', label: 'Normal' },
            { value: 'multiply', label: 'Multiply' },
            { value: 'screen', label: 'Screen' },
            { value: 'overlay', label: 'Overlay' },
            { value: 'darken', label: 'Darken' },
            { value: 'lighten', label: 'Lighten' },
          ]}
          onValueChange={(v) =>
            setStyle('Set blend mode', (d) => {
              if (v === 'normal') delete d.blendMode;
              else d.blendMode = v;
            })
          }
          className="ptl-insp-select"
        />
      </Row>
    </Section>
  );
}

export type { Color };
