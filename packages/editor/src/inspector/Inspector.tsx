import { CONTAINER_TAGS, TEXT_TAGS } from '@pitolet/schema';
import { Input, Select } from '@pitolet/ui';
import { useShallow } from 'zustand/react/shallow';
import { useEditor } from '../store/index.js';
import {
  BorderSection,
  EffectsSection,
  FillSection,
  ImageSection,
  RadiusSection,
} from './sections/AppearanceSections.js';
import {
  GradientControls,
  GridControls,
  PositionSection,
  ShadowSection,
} from './sections/AdvancedSections.js';
import { CommentsSection } from './sections/CommentsSection.js';
import { ComponentSection } from './sections/ComponentSection.js';
import { LayoutSection } from './sections/LayoutSection.js';
import { SizeSection } from './sections/SizeSection.js';
import { SpacingSection } from './sections/SpacingSection.js';
import { TypographySection } from './sections/TypographySection.js';
import { Row, Section } from './fields.js';
import './Inspector.css';

/**
 * The style inspector. Section visibility follows the kinds of nodes
 * selected; every control writes through the same patch pipeline.
 */
export function Inspector() {
  const kinds = useEditor(
    useShallow((s) => [...new Set(s.selection.map((id) => s.doc?.nodes[id]?.type))].sort()),
  );
  const count = useEditor((s) => s.selection.length);
  // Top-level frames use canvas coordinates, not CSS position — hide Position.
  // (Must be called before any early return to keep hook order stable.)
  const allTopLevelFrames = useEditor(
    useShallow((s) => s.selection.every((id) => s.doc?.nodes[id]?.parent === null)),
  );

  if (count === 0) {
    return (
      <div className="ptl-inspector">
        <div className="ptl-panel-header">Design</div>
        <div className="ptl-panel-empty">
          Select something on the canvas.
          <br />
          <span className="ptl-insp-hint">V select · F frame · R box · T text</span>
        </div>
      </div>
    );
  }

  const hasText = kinds.includes('text');
  const hasContainer = kinds.includes('frame') || kinds.includes('element');
  const onlyText = hasText && kinds.length === 1;
  const onlyInstance = kinds.length === 1 && kinds[0] === 'instance';

  if (onlyInstance) {
    return (
      <div className="ptl-inspector">
        <NodeSection />
        <ComponentSection />
        <SpacingSection />
        <EffectsSection />
        <CommentsSection />
      </div>
    );
  }

  return (
    <div className="ptl-inspector">
      <NodeSection />
      <ComponentSection />
      <SizeSection />
      {hasContainer && <LayoutSection />}
      {hasContainer && <GridControls />}
      <SpacingSection />
      {!allTopLevelFrames && <PositionSection />}
      {hasText && <TypographySection />}
      {kinds.includes('image') && <ImageSection />}
      {!onlyText && <FillSection />}
      {!onlyText && <GradientControls />}
      <BorderSection />
      <RadiusSection />
      <ShadowSection />
      <EffectsSection />
      <CommentsSection />
    </div>
  );
}

function NodeSection() {
  // Select stable node references (immer structural sharing) — deriving
  // fresh objects inside the selector would defeat useShallow and loop.
  const nodes = useEditor(useShallow((s) => s.selection.map((id) => s.doc?.nodes[id])));
  const valid = nodes.filter((n): n is NonNullable<typeof n> => n != null);
  if (valid.length === 0) return null;
  const first = valid[0]!;
  const sameName = valid.every((n) => n.name === first.name);
  const sameTag = valid.every((n) => n.tag === first.tag);
  const tagOptions = (first.type === 'text' ? TEXT_TAGS : CONTAINER_TAGS).map((t) => ({
    value: t,
    label: `<${t}>`,
  }));

  return (
    <Section title={valid.length > 1 ? `${valid.length} selected` : typeLabel(first.type)}>
      <Row label="Name">
        <Input
          key={first.id}
          defaultValue={sameName ? first.name : ''}
          placeholder={sameName ? undefined : 'Mixed'}
          onBlur={(e) => {
            const name = e.target.value.trim();
            if (!name || (sameName && name === first.name)) return;
            const ids = valid.map((n) => n.id);
            useEditor.getState().dispatchEdit('Rename', (draft) => {
              for (const id of ids) {
                const node = draft.nodes[id];
                if (node) node.name = name;
              }
            });
          }}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          className="ptl-name-input"
        />
      </Row>
      {first.type !== 'image' && first.type !== 'instance' && (
        <Row label="Tag">
          <Select
            value={sameTag ? first.tag : ''}
            options={tagOptions}
            onValueChange={(tag) => {
              const ids = valid.map((n) => n.id);
              useEditor.getState().dispatchEdit('Set tag', (draft) => {
                for (const id of ids) {
                  const node = draft.nodes[id];
                  if (node) node.tag = tag;
                }
              });
            }}
            className="ptl-insp-select"
          />
        </Row>
      )}
    </Section>
  );
}

function typeLabel(type: string): string {
  switch (type) {
    case 'frame':
      return 'Frame';
    case 'element':
      return 'Box';
    case 'text':
      return 'Text';
    case 'image':
      return 'Image';
    case 'instance':
      return 'Instance';
    default:
      return type;
  }
}
