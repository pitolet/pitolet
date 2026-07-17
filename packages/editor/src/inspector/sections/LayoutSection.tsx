import type { AlignSelfValue, AlignValue, JustifyValue, Length, StyleValue } from '@pitolet/schema';
import { IconButton, Input, NumberScrubInput, Select, Tooltip } from '@pitolet/ui';
import {
  ArrowDown,
  ArrowRight,
  EyeOff,
  Grid3x3,
  Square,
  StretchHorizontal,
  WrapText,
} from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useEditor } from '../../store/index.js';
import { updateGapAxis } from '../compoundControls.js';
import { LengthField, Row, Section } from '../fields.js';
import {
  readStyleAtContext,
  setStyle,
  styleContextFor,
  useCoalesceKey,
  useStyleValue,
} from '../useStyle.js';

const ALIGN_OPTIONS = [
  { value: 'start', label: 'Start' },
  { value: 'center', label: 'Center' },
  { value: 'end', label: 'End' },
  { value: 'stretch', label: 'Stretch' },
  { value: 'baseline', label: 'Baseline' },
] as const;

const JUSTIFY_OPTIONS = [
  { value: 'start', label: 'Start' },
  { value: 'center', label: 'Center' },
  { value: 'end', label: 'End' },
  { value: 'between', label: 'Between' },
  { value: 'around', label: 'Around' },
  { value: 'evenly', label: 'Evenly' },
] as const;

/**
 * Layout controls with Framer-style "Stack" vocabulary over real flexbox:
 * Stack (flex) / Grid / Block, direction, alignment, gap, wrap.
 */
export function LayoutSection() {
  const display = useStyleValue('display');
  const direction = useStyleValue('flexDirection');
  const wrap = useStyleValue('flexWrap');
  const alignItems = useStyleValue('alignItems');
  const justifyContent = useStyleValue('justifyContent');
  const gap = useStyleValue('gap');

  const isFlex = display.value === 'flex';
  const isRow = (direction.value ?? 'row') === 'row';

  return (
    <Section title="Layout">
      <Row label="Type" styleContext={styleContextFor(display, 'display', 'layout type')}>
        <Tooltip content="Stack (flex)">
          <IconButton
            label="Stack"
            size="sm"
            active={isFlex}
            onClick={() => setStyle('Set layout', (d) => (d.display = 'flex'))}
          >
            <StretchHorizontal size={13} />
          </IconButton>
        </Tooltip>
        <Tooltip content="Grid">
          <IconButton
            label="Grid"
            size="sm"
            active={display.value === 'grid'}
            onClick={() =>
              setStyle('Set layout', (d) => {
                d.display = 'grid';
                d.gridTemplateColumns = d.gridTemplateColumns ?? [
                  { kind: 'fr', value: 1 },
                  { kind: 'fr', value: 1 },
                ];
              })
            }
          >
            <Grid3x3 size={13} />
          </IconButton>
        </Tooltip>
        <Tooltip content="Block (document flow)">
          <IconButton
            label="Block"
            size="sm"
            active={display.value === 'block'}
            onClick={() => setStyle('Set layout', (d) => (d.display = 'block'))}
          >
            <Square size={13} />
          </IconButton>
        </Tooltip>
        <Tooltip content="Hide at this breakpoint (display: none)">
          <IconButton
            label="Hide"
            size="sm"
            active={display.value === 'none'}
            onClick={() => setStyle('Hide layer', (d) => (d.display = 'none'))}
          >
            <EyeOff size={13} />
          </IconButton>
        </Tooltip>
      </Row>

      {isFlex && (
        <>
          <Row
            label="Direction"
            styleContext={styleContextFor(direction, 'flexDirection', 'direction')}
          >
            <Tooltip content="Horizontal">
              <IconButton
                label="Row"
                size="sm"
                active={isRow}
                onClick={() => setStyle('Set direction', (d) => (d.flexDirection = 'row'))}
              >
                <ArrowRight size={13} />
              </IconButton>
            </Tooltip>
            <Tooltip content="Vertical">
              <IconButton
                label="Column"
                size="sm"
                active={!isRow}
                onClick={() => setStyle('Set direction', (d) => (d.flexDirection = 'column'))}
              >
                <ArrowDown size={13} />
              </IconButton>
            </Tooltip>
          </Row>
          <Row label="Wrap" styleContext={styleContextFor(wrap, 'flexWrap', 'wrap')}>
            <Tooltip content="Allow items to wrap onto another line">
              <IconButton
                label="Wrap"
                size="sm"
                active={wrap.value === 'wrap'}
                onClick={() =>
                  setStyle('Toggle wrap', (d) => {
                    if (d.flexWrap === 'wrap') delete d.flexWrap;
                    else d.flexWrap = 'wrap';
                  })
                }
              >
                <WrapText size={13} />
              </IconButton>
            </Tooltip>
          </Row>
          <Row label="Align" styleContext={styleContextFor(alignItems, 'alignItems', 'align')}>
            <Select
              value={(alignItems.value as string) ?? 'start'}
              options={ALIGN_OPTIONS as unknown as { value: string; label: string }[]}
              onValueChange={(v) => setStyle('Set align', (d) => (d.alignItems = v as AlignValue))}
              className="ptl-insp-select"
            />
          </Row>
          <Row
            label="Justify"
            styleContext={styleContextFor(justifyContent, 'justifyContent', 'justify')}
          >
            <Select
              value={(justifyContent.value as string) ?? 'start'}
              options={JUSTIFY_OPTIONS as unknown as { value: string; label: string }[]}
              onValueChange={(v) =>
                setStyle('Set justify', (d) => (d.justifyContent = v as JustifyValue))
              }
              className="ptl-insp-select"
            />
          </Row>
        </>
      )}

      {(isFlex || display.value === 'grid') && (
        <Row label="Gap" styleContext={styleContextFor(gap, 'gap', 'gap')}>
          <LengthField
            value={gap.value?.row as StyleValue<Length> | undefined}
            mixed={gap.mixed}
            label="↕"
            title="Row gap"
            onWrite={(len, key) =>
              setStyle(
                'Set gap',
                (d) => {
                  d.gap = updateGapAxis(d.gap, gap.value ?? undefined, 'row', len);
                },
                key,
              )
            }
          />
          <LengthField
            value={gap.value?.column as StyleValue<Length> | undefined}
            mixed={gap.mixed}
            label="↔"
            title="Column gap"
            onWrite={(len, key) =>
              setStyle(
                'Set gap',
                (d) => {
                  d.gap = updateGapAxis(d.gap, gap.value ?? undefined, 'column', len);
                },
                key,
              )
            }
          />
        </Row>
      )}
    </Section>
  );
}

const ALIGN_SELF_OPTIONS = [{ value: 'auto', label: 'Auto' }, ...ALIGN_OPTIONS] as unknown as {
  value: string;
  label: string;
}[];

/** Controls that belong to an item because of its parent's flex/grid layout. */
export function LayoutItemSection() {
  const parentDisplays = useEditor(
    useShallow((state) => {
      if (!state.doc) return [];
      return state.selection.map((id) => {
        const node = state.doc!.nodes[id];
        const parent = node?.parent ? state.doc!.nodes[node.parent] : undefined;
        return parent
          ? readStyleAtContext(
              parent.styles,
              'display',
              state.editingContext,
              state.doc!.breakpoints,
            ).value
          : undefined;
      });
    }),
  );
  const parentDisplay = parentDisplays[0];
  const sameParentLayout = parentDisplays.every((display) => display === parentDisplay);
  const alignSelf = useStyleValue('alignSelf');
  const flexGrow = useStyleValue('flexGrow');
  const gridColumn = useStyleValue('gridColumn');
  const gridRow = useStyleValue('gridRow');
  const keys = useCoalesceKey();

  if (!sameParentLayout || (parentDisplay !== 'flex' && parentDisplay !== 'grid')) return null;

  return (
    <Section title={parentDisplay === 'flex' ? 'Flex item' : 'Grid item'}>
      {parentDisplay === 'flex' ? (
        <>
          <Row
            label="Align self"
            styleContext={styleContextFor(alignSelf, 'alignSelf', 'align self')}
          >
            <Select
              value={(alignSelf.value as string) ?? 'auto'}
              options={ALIGN_SELF_OPTIONS}
              onValueChange={(value) =>
                setStyle('Set item alignment', (decl) => {
                  decl.alignSelf = value as AlignSelfValue;
                })
              }
              className="ptl-insp-select"
            />
          </Row>
          <Row label="Grow" styleContext={styleContextFor(flexGrow, 'flexGrow', 'grow')}>
            <NumberScrubInput
              value={flexGrow.value ?? 0}
              min={0}
              precision={1}
              onChange={(value, options) => {
                if (!options.transient) keys.begin();
                setStyle(
                  'Set flex grow',
                  (decl) => {
                    if (value === 0) delete decl.flexGrow;
                    else decl.flexGrow = value;
                  },
                  keys.current(),
                );
              }}
              onCommit={() => keys.begin()}
              className="ptl-field-scrub"
            />
          </Row>
        </>
      ) : (
        <>
          <GridPlacementField label="Column" value={gridColumn.value} property="gridColumn" />
          <GridPlacementField label="Row" value={gridRow.value} property="gridRow" />
        </>
      )}
    </Section>
  );
}

function GridPlacementField({
  label,
  value,
  property,
}: {
  label: string;
  value: string | null | undefined;
  property: 'gridColumn' | 'gridRow';
}) {
  const readout = useStyleValue(property);
  return (
    <Row label={label} styleContext={styleContextFor(readout, property, label.toLowerCase())}>
      <Input
        key={`${property}:${value ?? ''}`}
        defaultValue={value ?? ''}
        placeholder="Auto or 1 / 3"
        onBlur={(event) => {
          const next = event.target.value.trim();
          setStyle(`Set grid ${label.toLowerCase()}`, (decl) => {
            if (next) decl[property] = next;
            else delete decl[property];
          });
        }}
        onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
        className="ptl-name-input"
      />
    </Row>
  );
}
