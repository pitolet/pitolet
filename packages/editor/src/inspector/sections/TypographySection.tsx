import type { Color, Length, StyleValue, TextAlign } from '@pitolet/schema';
import { IconButton, Select, Tooltip } from '@pitolet/ui';
import { AlignCenter, AlignJustify, AlignLeft, AlignRight } from 'lucide-react';
import { ensureFontLoaded, GOOGLE_FONTS } from '../../fonts/googleFonts.js';
import { ColorField, LengthField, Row, Section, useResolved } from '../fields.js';
import { setStyle, styleContextFor, useStyleValue } from '../useStyle.js';
import { NumberScrubInput } from '@pitolet/ui';
import { useCoalesceKey } from '../useStyle.js';

const FAMILIES = [
  { value: 'system-ui', label: 'System UI' },
  { value: 'Georgia', label: 'Georgia' },
  { value: 'Helvetica Neue', label: 'Helvetica' },
  { value: 'Menlo', label: 'Menlo' },
  ...GOOGLE_FONTS.map((f) => ({ value: f, label: f })),
];

const WEIGHTS = [300, 400, 500, 550, 600, 650, 700, 800].map((w) => ({
  value: String(w),
  label: String(w),
}));

export function TypographySection() {
  const family = useStyleValue('fontFamily');
  const size = useStyleValue('fontSize');
  const weight = useStyleValue('fontWeight');
  const lineHeight = useStyleValue('lineHeight');
  const letterSpacing = useStyleValue('letterSpacing');
  const align = useStyleValue('textAlign');
  const color = useStyleValue('color');
  const familyResolved = useResolved(family.value as StyleValue<string> | undefined);
  const weightResolved = useResolved(weight.value as StyleValue<number> | undefined);
  const lhKeys = useCoalesceKey();

  const lh = useResolved(lineHeight.value as StyleValue<number | Length> | undefined);
  const lhNumber =
    typeof lh.resolved === 'number' ? lh.resolved : lh.resolved ? lh.resolved.value : null;

  return (
    <Section title="Text" collapseKey="Typography">
      <Row label="Font" styleContext={styleContextFor(family, 'fontFamily', 'font')}>
        <Select
          value={familyResolved.resolved ?? 'system-ui'}
          options={FAMILIES}
          onValueChange={(v) => {
            ensureFontLoaded(v);
            setStyle('Set font', (d) => (d.fontFamily = v));
          }}
          className="ptl-insp-select"
        />
      </Row>
      <Row label="Style">
        <LengthField
          value={size.value as StyleValue<Length> | undefined}
          mixed={size.mixed}
          label="Aa"
          title="Font size"
          min={1}
          tokenCategory="fontSize"
          onWrite={(len, key) => setStyle('Set font size', (d) => (d.fontSize = len), key)}
        />
        <Select
          value={String(weightResolved.resolved ?? 400)}
          options={WEIGHTS}
          onValueChange={(v) => setStyle('Set weight', (d) => (d.fontWeight = Number(v)))}
          className="ptl-weight-select"
        />
      </Row>
      <Row label="Spacing">
        <NumberScrubInput
          value={lineHeight.mixed ? null : (lhNumber ?? 1.5)}
          label="↕"
          title="Line height (unitless)"
          step={0.05}
          precision={2}
          min={0.5}
          max={4}
          onChange={(v, o) => {
            if (!o.transient) lhKeys.begin();
            setStyle('Set line height', (d) => (d.lineHeight = v), lhKeys.current());
          }}
          onCommit={() => lhKeys.begin()}
        />
        <LengthField
          value={letterSpacing.value as StyleValue<Length> | undefined}
          mixed={letterSpacing.mixed}
          label="↔"
          title="Letter spacing"
          min={-20}
          onWrite={(len, key) =>
            setStyle('Set letter spacing', (d) => (d.letterSpacing = len), key)
          }
        />
      </Row>
      <Row label="Align" styleContext={styleContextFor(align, 'textAlign', 'text align')}>
        {(
          [
            ['left', AlignLeft],
            ['center', AlignCenter],
            ['right', AlignRight],
            ['justify', AlignJustify],
          ] as const
        ).map(([v, Icon]) => (
          <Tooltip key={v} content={`Align ${v}`}>
            <IconButton
              label={`Align ${v}`}
              size="sm"
              active={(align.value ?? 'left') === v}
              onClick={() => setStyle('Set text align', (d) => (d.textAlign = v as TextAlign))}
            >
              <Icon size={13} />
            </IconButton>
          </Tooltip>
        ))}
      </Row>
      <Row label="Color" styleContext={styleContextFor(color, 'color', 'text color')}>
        <ColorField
          value={color.value as StyleValue<Color> | undefined}
          mixed={color.mixed}
          onWrite={(c, key) => setStyle('Set text color', (d) => (d.color = c), key)}
          onBind={(path) => setStyle('Bind text color', (d) => (d.color = { $token: path }))}
        />
      </Row>
    </Section>
  );
}
