import type { AlignValue, JustifyValue, Length, StyleValue } from '@pitolet/schema';
import { IconButton, Select, Tooltip } from '@pitolet/ui';
import {
  ArrowDown,
  ArrowRight,
  Grid3x3,
  Square,
  StretchHorizontal,
  WrapText,
} from 'lucide-react';
import { LengthField, Row, Section } from '../fields.js';
import { setStyle, useStyleValue } from '../useStyle.js';

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
      <Row label="Type">
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
      </Row>

      {isFlex && (
        <>
          <Row label="Direction">
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
            <Tooltip content="Wrap">
              <IconButton
                label="Wrap"
                size="sm"
                active={wrap.value === 'wrap'}
                onClick={() =>
                  setStyle('Toggle wrap', (d) => (d.flexWrap = d.flexWrap === 'wrap' ? 'nowrap' : 'wrap'))
                }
              >
                <WrapText size={13} />
              </IconButton>
            </Tooltip>
          </Row>
          <Row label="Align">
            <Select
              value={(alignItems.value as string) ?? 'start'}
              options={ALIGN_OPTIONS as unknown as { value: string; label: string }[]}
              onValueChange={(v) => setStyle('Set align', (d) => (d.alignItems = v as AlignValue))}
              className="ptl-insp-select"
            />
          </Row>
          <Row label="Justify">
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
        <Row label="Gap">
          <LengthField
            value={gap.value?.row as StyleValue<Length> | undefined}
            mixed={gap.mixed}
            label="↕"
            title="Row gap"
            onWrite={(len, key) =>
              setStyle(
                'Set gap',
                (d) => {
                  d.gap = { row: len, column: d.gap?.column ?? len };
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
                  d.gap = { row: d.gap?.row ?? len, column: len };
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
