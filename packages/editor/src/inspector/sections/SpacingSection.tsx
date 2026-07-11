import { px, sides, type Length, type Sides, type StyleValue } from '@pitolet/schema';
import { IconButton, Tooltip } from '@pitolet/ui';
import { Link2, Link2Off } from 'lucide-react';
import { useState } from 'react';
import { LengthField, Row, Section, useResolved } from '../fields.js';
import { setStyle, useStyleValue } from '../useStyle.js';

/** Padding & margin. Linked mode edits all sides at once. */
export function SpacingSection() {
  return (
    <Section title="Spacing">
      <SidesEditor
        label="Padding"
        styleKey="padding"
      />
      <SidesEditor label="Margin" styleKey="margin" />
    </Section>
  );
}

function SidesEditor({ label, styleKey }: { label: string; styleKey: 'padding' | 'margin' }) {
  const readout = useStyleValue(styleKey);
  const value = readout.value as Sides<StyleValue<Length>> | undefined;
  const top = useResolved(value?.top);
  const right = useResolved(value?.right);
  const bottom = useResolved(value?.bottom);
  const left = useResolved(value?.left);

  const allEqual =
    top.resolved?.value === right.resolved?.value &&
    right.resolved?.value === bottom.resolved?.value &&
    bottom.resolved?.value === left.resolved?.value;
  const [linked, setLinked] = useState(true);
  const effectiveLinked = linked && allEqual;
  const negativeOk = styleKey === 'margin' ? -9999 : 0;

  const writeSide = (side: keyof Sides<unknown> | 'all') => (len: StyleValue<Length>, key: string) =>
    setStyle(
      `Set ${styleKey}`,
      (d) => {
        const current = (d[styleKey] as Sides<StyleValue<Length>> | undefined) ?? sides(px(0));
        d[styleKey] =
          side === 'all'
            ? sides<StyleValue<Length>>(len)
            : { ...current, [side]: len };
      },
      key,
    );

  return (
    <>
      <Row label={label}>
        {effectiveLinked ? (
          <LengthField
            value={value?.top}
            mixed={readout.mixed}
            label="◻"
            title={`${label} (all sides)`}
            min={negativeOk}
            tokenCategory="spacing"
            onWrite={writeSide('all')}
          />
        ) : (
          <>
            <LengthField value={value?.top} mixed={readout.mixed} label="T" min={negativeOk} tokenCategory="spacing" onWrite={writeSide('top')} />
            <LengthField value={value?.right} mixed={readout.mixed} label="R" min={negativeOk} tokenCategory="spacing" onWrite={writeSide('right')} />
          </>
        )}
        <Tooltip content={effectiveLinked ? 'Edit sides separately' : 'Link all sides'}>
          <IconButton
            label="Link sides"
            size="sm"
            active={effectiveLinked}
            onClick={() => setLinked(!effectiveLinked)}
          >
            {effectiveLinked ? <Link2 size={12} /> : <Link2Off size={12} />}
          </IconButton>
        </Tooltip>
      </Row>
      {!effectiveLinked && (
        <Row label="">
          <LengthField value={value?.bottom} mixed={readout.mixed} label="B" min={negativeOk} tokenCategory="spacing" onWrite={writeSide('bottom')} />
          <LengthField value={value?.left} mixed={readout.mixed} label="L" min={negativeOk} tokenCategory="spacing" onWrite={writeSide('left')} />
          <span style={{ width: 24, flexShrink: 0 }} />
        </Row>
      )}
    </>
  );
}
