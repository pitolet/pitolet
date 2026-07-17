import { px, sides, type Length, type Sides, type StyleValue } from '@pitolet/schema';
import { IconButton, Tooltip } from '@pitolet/ui';
import { Link2, Link2Off } from 'lucide-react';
import { useState } from 'react';
import { allStyleValuesEqual } from '../compoundControls.js';
import { LengthField, Row, Section } from '../fields.js';
import { setStyle, styleContextFor, useStyleValue } from '../useStyle.js';

/** Padding & margin. Linked mode edits all sides at once. */
export function SpacingSection() {
  return (
    <Section title="Spacing">
      <SidesEditor label="Padding" styleKey="padding" />
      <SidesEditor label="Margin" styleKey="margin" />
    </Section>
  );
}

function SidesEditor({ label, styleKey }: { label: string; styleKey: 'padding' | 'margin' }) {
  const readout = useStyleValue(styleKey);
  const value = readout.value as Sides<StyleValue<Length>> | undefined;
  const allEqual = allStyleValuesEqual([value?.top, value?.right, value?.bottom, value?.left]);
  const [linked, setLinked] = useState(true);
  const effectiveLinked = linked && allEqual;
  const negativeOk = styleKey === 'margin' ? -9999 : 0;

  const writeSide =
    (side: keyof Sides<unknown> | 'all') => (len: StyleValue<Length>, key: string) =>
      setStyle(
        `Set ${styleKey}`,
        (d) => {
          const current = (d[styleKey] as Sides<StyleValue<Length>> | undefined) ?? sides(px(0));
          d[styleKey] =
            side === 'all' ? sides<StyleValue<Length>>(len) : { ...current, [side]: len };
        },
        key,
      );

  const toggleLinked = () => {
    if (effectiveLinked) {
      setLinked(false);
      return;
    }
    const base = value?.top ?? px(0);
    setStyle(`Link ${styleKey} sides`, (d) => {
      d[styleKey] = sides<StyleValue<Length>>(base);
    });
    setLinked(true);
  };

  return (
    <>
      <Row label={label} styleContext={styleContextFor(readout, styleKey, styleKey)}>
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
            <LengthField
              value={value?.top}
              mixed={readout.mixed}
              label="T"
              min={negativeOk}
              tokenCategory="spacing"
              onWrite={writeSide('top')}
            />
            <LengthField
              value={value?.right}
              mixed={readout.mixed}
              label="R"
              min={negativeOk}
              tokenCategory="spacing"
              onWrite={writeSide('right')}
            />
          </>
        )}
        <Tooltip content={effectiveLinked ? 'Edit sides separately' : 'Link all sides'}>
          <IconButton label="Link sides" size="sm" active={effectiveLinked} onClick={toggleLinked}>
            {effectiveLinked ? <Link2 size={12} /> : <Link2Off size={12} />}
          </IconButton>
        </Tooltip>
      </Row>
      {!effectiveLinked && (
        <Row label="">
          <LengthField
            value={value?.bottom}
            mixed={readout.mixed}
            label="B"
            min={negativeOk}
            tokenCategory="spacing"
            onWrite={writeSide('bottom')}
          />
          <LengthField
            value={value?.left}
            mixed={readout.mixed}
            label="L"
            min={negativeOk}
            tokenCategory="spacing"
            onWrite={writeSide('left')}
          />
          <span className="ptl-insp-control-spacer" />
        </Row>
      )}
    </>
  );
}
