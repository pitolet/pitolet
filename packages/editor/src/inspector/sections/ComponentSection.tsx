import { rootFrameOf, type InstanceNode } from '@pitolet/schema';
import { Button, Select } from '@pitolet/ui';
import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { detachInstance } from '../../store/componentMutations.js';
import { useEditor } from '../../store/index.js';
import { Row, Section } from '../fields.js';

/**
 * Component controls:
 *  - on an INSTANCE: switch variant values, detach
 *  - inside a MASTER: manage variant props/values, pick which variant style
 *    edits record into (with live preview on the master)
 */
export function ComponentSection() {
  const selection = useEditor((s) => s.selection);
  const firstNode = useEditor((s) => (selection[0] ? s.doc?.nodes[selection[0]] : undefined));
  const masterComponentId = useEditor((s) => {
    const id = s.selection[0];
    if (!id || !s.doc) return undefined;
    const root = s.doc.nodes[rootFrameOf(s.doc.nodes, id)];
    return root?.type === 'frame' ? root.isComponentMaster : undefined;
  });

  if (firstNode?.type === 'instance') return <InstanceControls instance={firstNode} />;
  if (masterComponentId) return <MasterControls componentId={masterComponentId} />;
  return null;
}

function InstanceControls({ instance }: { instance: InstanceNode }) {
  const component = useEditor((s) => s.doc?.components[instance.componentId]);
  if (!component) return null;

  return (
    <Section title={`◈ ${component.name}`}>
      {component.variantProps.map((prop) => (
        <Row key={prop.name} label={prop.name}>
          <Select
            value={instance.variant[prop.name] ?? prop.default}
            options={prop.values.map((v) => ({ value: v, label: v }))}
            onValueChange={(value) => {
              useEditor.getState().dispatchEdit(`Set ${prop.name}`, (draft) => {
                const node = draft.nodes[instance.id];
                if (node?.type === 'instance') node.variant[prop.name] = value;
              });
            }}
            className="ptl-insp-select"
          />
        </Row>
      ))}
      <Row>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            let newId: string | null = null;
            useEditor.getState().dispatchEdit('Detach instance', (draft) => {
              newId = detachInstance(draft, instance.id);
            });
            if (newId) useEditor.getState().select([newId]);
          }}
        >
          Detach from component
        </Button>
      </Row>
    </Section>
  );
}

function MasterControls({ componentId }: { componentId: string }) {
  const component = useEditor((s) => s.doc?.components[componentId]);
  const editingVariant = useEditor((s) => s.editingVariant);
  const setEditingVariant = useEditor((s) => s.setEditingVariant);
  const [addingProp, setAddingProp] = useState(false);
  const instanceCount = useEditor(
    useShallow(
      (s) =>
        Object.values(s.doc?.nodes ?? {}).filter(
          (n) => n.type === 'instance' && n.componentId === componentId,
        ).length,
    ),
  );

  if (!component) return null;

  const variantOptions = [
    { value: '__base__', label: 'Base styles' },
    ...component.variantProps.flatMap((prop) =>
      prop.values.map((v) => ({ value: `${prop.name}=${v}`, label: `${prop.name}: ${v}` })),
    ),
  ];

  return (
    <Section title={`◈ Component · ${instanceCount} instance${instanceCount === 1 ? '' : 's'}`}>
      {component.variantProps.length > 0 && (
        <Row label="Editing">
          <Select
            value={editingVariant ?? '__base__'}
            options={variantOptions}
            onValueChange={(v) => setEditingVariant(v === '__base__' ? null : v)}
            className="ptl-insp-select"
          />
        </Row>
      )}
      {editingVariant && (
        <span className="ptl-insp-hint">
          Style edits now record into “{editingVariant}” and preview on this master.
        </span>
      )}
      {component.variantProps.map((prop) => (
        <Row key={prop.name} label={prop.name}>
          <span className="ptl-insp-hint">{prop.values.join(' · ')}</span>
        </Row>
      ))}
      {addingProp ? (
        <Row>
          <input
            className="ptl-token-new"
            placeholder="prop: value1, value2"
            autoFocus
            onBlur={(e) => {
              setAddingProp(false);
              const match = e.target.value.match(/^\s*([\w-]+)\s*:\s*(.+)$/);
              if (!match) return;
              const name = match[1]!;
              const values = match[2]!.split(',').map((v) => v.trim()).filter(Boolean);
              if (values.length === 0) return;
              useEditor.getState().dispatchEdit('Add variant prop', (draft) => {
                const def = draft.components[componentId];
                if (def && !def.variantProps.some((p) => p.name === name)) {
                  def.variantProps.push({ name, values, default: values[0]! });
                }
              });
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') setAddingProp(false);
            }}
          />
        </Row>
      ) : (
        <Row>
          <Button size="sm" variant="ghost" onClick={() => setAddingProp(true)}>
            + Add variant prop
          </Button>
        </Row>
      )}
    </Section>
  );
}
