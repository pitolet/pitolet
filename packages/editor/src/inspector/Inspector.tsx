import { Input, Kbd, SearchableSelect } from '@pitolet/ui';
import { LockKeyhole, Unlock } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useEditor } from '../store/index.js';
import { lockingNodeIds } from '../store/locks.js';
import { isVoidElementTag } from '../store/nodeSafety.js';
import { renameComponent } from '../store/componentMutations.js';
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
import { CommentsSummary } from './sections/CommentsSection.js';
import { ComponentSection } from './sections/ComponentSection.js';
import { LayoutItemSection, LayoutSection } from './sections/LayoutSection.js';
import { SizeSection } from './sections/SizeSection.js';
import { SpacingSection } from './sections/SpacingSection.js';
import { TypographySection } from './sections/TypographySection.js';
import { ResponsiveContextSection } from './sections/ResponsiveContextSection.js';
import { tagOptionGroups } from './tagOptions.js';
import { effectiveInspectorNode } from './useStyle.js';
import { Row, Section } from './fields.js';
import './Inspector.css';

/**
 * The style inspector. Section visibility follows the kinds of nodes
 * selected; every control writes through the same patch pipeline.
 */
export function Inspector() {
  const kinds = useEditor(
    useShallow((s) =>
      [
        ...new Set(
          s.selection.map((id) =>
            s.doc ? effectiveInspectorNode(s.doc, id, s.editingInstanceOverride)?.type : undefined,
          ),
        ),
      ].sort(),
    ),
  );
  const hasActualInstance = useEditor((s) =>
    s.selection.some((id) => s.doc?.nodes[id]?.type === 'instance'),
  );
  const count = useEditor((s) => s.selection.length);
  const readOnly = useEditor((s) => s.readOnly);
  const connected = useEditor((s) => s.connected);
  const switchingDocument = useEditor((s) => s.switchingDocument);
  const editingDisabled = readOnly || !connected || switchingDocument;
  // Top-level frames use canvas coordinates, not CSS position — hide Position.
  // (Must be called before any early return to keep hook order stable.)
  const allTopLevelFrames = useEditor(
    useShallow((s) => s.selection.every((id) => s.doc?.nodes[id]?.parent === null)),
  );
  const lockingIds = useEditor(
    useShallow((s) => {
      if (!s.doc) return [];
      return [...new Set(s.selection.flatMap((id) => lockingNodeIds(s.doc!, id)))].sort();
    }),
  );

  if (count === 0) {
    return (
      <div className="ptl-inspector">
        <div className="ptl-panel-header">Design</div>
        <div className="ptl-panel-empty ptl-inspector-empty">
          <strong>Select a layer</strong>
          <span>Click the canvas or use a tool.</span>
          <div className="ptl-inspector-shortcuts" role="group" aria-label="Tool shortcuts">
            <span>
              <Kbd keys="v" />
              Select
            </span>
            <span>
              <Kbd keys="f" />
              Frame
            </span>
            <span>
              <Kbd keys="r" />
              Box
            </span>
            <span>
              <Kbd keys="t" />
              Text
            </span>
          </div>
        </div>
      </div>
    );
  }

  if (lockingIds.length > 0) {
    return <LockedInspector lockingIds={lockingIds} count={count} disabled={editingDisabled} />;
  }

  const hasText = kinds.includes('text');
  const hasContainer = kinds.includes('frame') || kinds.includes('element');
  const onlyText = hasText && kinds.length === 1;

  return (
    <div className="ptl-inspector">
      {editingDisabled && (
        <div className="ptl-inspector-disabled-note" role="status">
          {readOnly
            ? 'Read-only document'
            : switchingDocument
              ? 'Opening document'
              : 'Editing resumes when Pitolet reconnects'}
        </div>
      )}
      <fieldset className="ptl-inspector-controls" disabled={editingDisabled}>
        <NodeSection />
        <ComponentSection />
        <ResponsiveContextSection />
        <SizeSection />
        {hasContainer && <LayoutSection />}
        {hasContainer && <GridControls />}
        {!allTopLevelFrames && <LayoutItemSection />}
        <SpacingSection />
        {!allTopLevelFrames && <PositionSection />}
        {hasText && <TypographySection />}
        {kinds.includes('image') && !hasActualInstance && <ImageSection />}
        {!onlyText && (
          <FillSection>
            <GradientControls />
          </FillSection>
        )}
        <BorderSection />
        <RadiusSection />
        <ShadowSection />
        <EffectsSection />
        <CommentsSummary />
      </fieldset>
    </div>
  );
}

function LockedInspector({
  lockingIds,
  count,
  disabled,
}: {
  lockingIds: string[];
  count: number;
  disabled: boolean;
}) {
  const names = useEditor(
    useShallow((s) => lockingIds.map((id) => s.doc?.nodes[id]?.name).filter(Boolean)),
  );
  const label = names.length === 1 ? names[0]! : `${lockingIds.length} layers`;

  return (
    <div className="ptl-inspector">
      <div className="ptl-locked-inspector">
        <span className="ptl-locked-inspector-icon">
          <LockKeyhole size={16} />
        </span>
        <div className="ptl-locked-inspector-copy">
          <strong>{count === 1 ? 'Layer is locked' : 'Selection contains locked layers'}</strong>
          <span>Unlock {label} to edit it.</span>
        </div>
        <button
          type="button"
          className="ptl-locked-inspector-button"
          disabled={disabled}
          onClick={() =>
            useEditor
              .getState()
              .dispatchEdit(lockingIds.length === 1 ? 'Unlock' : 'Unlock layers', (draft) => {
                for (const id of lockingIds) {
                  const node = draft.nodes[id];
                  if (node) node.locked = false;
                }
              })
          }
        >
          <Unlock size={13} />
          Unlock
        </button>
      </div>
      <CommentsSummary />
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
  const tagGroups = tagOptionGroups(first.type === 'text' ? 'text' : 'container');

  return (
    <Section
      title={valid.length > 1 ? `${valid.length} selected` : typeLabel(first.type)}
      collapseKey="Node"
    >
      <Row label="Name">
        <Input
          key={first.id}
          aria-label="Layer name"
          defaultValue={sameName ? first.name : ''}
          placeholder={sameName ? undefined : 'Mixed'}
          onBlur={(e) => {
            const name = e.target.value.trim();
            if (!name || (sameName && name === first.name)) return;
            const ids = valid.map((n) => n.id);
            useEditor.getState().dispatchEdit('Rename', (draft) => {
              for (const id of ids) {
                const node = draft.nodes[id];
                if (!node) continue;
                if (node.type === 'frame' && node.isComponentMaster) {
                  renameComponent(draft, node.isComponentMaster, name);
                } else {
                  node.name = name;
                }
              }
            });
          }}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          className="ptl-name-input"
        />
      </Row>
      {first.type !== 'image' && first.type !== 'instance' && (
        <Row label="Tag">
          <SearchableSelect
            value={sameTag ? first.tag : ''}
            groups={tagGroups}
            ariaLabel="HTML tag"
            placeholder={sameTag ? 'Search tags…' : 'Mixed'}
            emptyMessage="No matching tags"
            onValueChange={(tag) => {
              if (isVoidElementTag(tag) && valid.some((node) => node.children.length > 0)) {
                useEditor
                  .getState()
                  .setSyncIssue('Remove this layer’s children before using a void HTML tag.');
                return;
              }
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
