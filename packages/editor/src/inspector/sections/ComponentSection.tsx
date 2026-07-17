import {
  rootFrameOf,
  resolveVariantPatch,
  subtreeIds,
  variantCombinations,
  variantKey,
  type InstanceNode,
  type NodeId,
  type PitoletDocument,
  type PitoletNode,
  type VariantProp,
} from '@pitolet/schema';
import { Button, IconButton, Input, Select, Tooltip } from '@pitolet/ui';
import { Eye, EyeOff, Plus, RotateCcw, Settings2, Trash2, X } from 'lucide-react';
import type { Draft } from 'immer';
import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  addVariantProperty,
  addVariantValue,
  deleteVariantProperty,
  detachInstance,
  removeVariantValue,
  renameVariantProperty,
  renameVariantValue,
  setVariantDefault,
} from '../../store/componentMutations.js';
import { useEditor } from '../../store/index.js';
import { Row, Section } from '../fields.js';
import './ComponentSection.css';

export function ComponentSection() {
  const selection = useEditor((state) => state.selection);
  const firstNode = useEditor((state) =>
    selection[0] ? state.doc?.nodes[selection[0]] : undefined,
  );
  const masterComponentId = useEditor((state) => {
    const id = state.selection[0];
    if (!id || !state.doc) return undefined;
    const root = state.doc.nodes[rootFrameOf(state.doc.nodes, id)];
    return root?.type === 'frame' ? root.isComponentMaster : undefined;
  });

  if (firstNode?.type === 'instance') return <InstanceControls instance={firstNode} />;
  if (masterComponentId) return <MasterControls componentId={masterComponentId} />;
  return null;
}

function InstanceControls({ instance }: { instance: InstanceNode }) {
  const component = useEditor((state) => state.doc?.components[instance.componentId]);
  const disabled = useEditor((state) => state.readOnly || !state.connected);
  const editingOverride = useEditor((state) => state.editingInstanceOverride);
  const document = useEditor((state) => state.doc);
  const [visibilityNodeId, setVisibilityNodeId] = useState<NodeId>('');
  if (!component || !document) return null;

  const componentNodes = subtreeIds(document.nodes, component.contentRootId)
    .map((id) => document.nodes[id])
    .filter((node): node is PitoletNode => Boolean(node) && node?.type !== 'instance');
  const innerStyleNodes = componentNodes.filter((node) => node.id !== component.contentRootId);
  const textNodes = componentNodes.filter((node) => node.type === 'text');
  const imageNodes = componentNodes.filter((node) => node.type === 'image');
  const visibilityNodes = componentNodes.filter((node) => node.id !== component.contentRootId);
  const activeVisibilityId = visibilityNodes.some((node) => node.id === visibilityNodeId)
    ? visibilityNodeId
    : (visibilityNodes[0]?.id ?? '');
  const activeVisibilityNode = document.nodes[activeVisibilityId];
  const activeBaselineVisibility = activeVisibilityNode
    ? (resolveVariantPatch(component, instance.variant, activeVisibilityId)?.visible ??
      activeVisibilityNode.visible)
    : true;
  const activeVisibility = activeVisibilityNode
    ? (instance.overrides[activeVisibilityId]?.visible ?? activeBaselineVisibility)
    : true;
  const editingTarget =
    editingOverride?.instanceId === instance.id ? editingOverride.nodeId : '__root__';
  const overrideCount = Object.keys(instance.overrides).length;
  const hasOverrides = overrideCount > 0;

  return (
    <>
      <Section title={component.name}>
        <div className="ptl-component-master-summary">
          <span>Component instance</span>
          {hasOverrides && (
            <span>
              {overrideCount} {overrideCount === 1 ? 'override' : 'overrides'}
            </span>
          )}
        </div>
        {component.variantProps.map((prop) => (
          <Row key={prop.name} label={prop.name}>
            <Select
              value={instance.variant[prop.name] ?? prop.default}
              options={prop.values.map((value) => ({ value, label: value }))}
              disabled={disabled}
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
        <Row label="Editing">
          <Select
            value={editingTarget}
            options={[
              { value: '__root__', label: 'Instance root' },
              ...innerStyleNodes.map((node) => ({
                value: node.id,
                label: `${node.name} (${nodeTypeLabel(node)})`,
              })),
            ]}
            onValueChange={(value) =>
              useEditor
                .getState()
                .setEditingInstanceOverride(instance.id, value === '__root__' ? null : value)
            }
            className="ptl-insp-select"
          />
        </Row>
        {editingTarget !== '__root__' && (
          <span className="ptl-instance-edit-target">
            <span>Local edit</span>
            <strong>{document.nodes[editingTarget]?.name}</strong>
          </span>
        )}
      </Section>

      {(textNodes.length > 0 || imageNodes.length > 0 || visibilityNodes.length > 0) && (
        <Section
          title="Overrides"
          actions={
            hasOverrides ? (
              <Tooltip content="Reset all overrides">
                <IconButton
                  label="Reset all overrides"
                  size="sm"
                  disabled={disabled}
                  onClick={() => {
                    useEditor.getState().dispatchEdit('Reset instance overrides', (draft) => {
                      const node = draft.nodes[instance.id];
                      if (node?.type === 'instance') node.overrides = {};
                    });
                    useEditor.getState().setEditingInstanceOverride(instance.id, null);
                  }}
                >
                  <RotateCcw size={12} />
                </IconButton>
              </Tooltip>
            ) : undefined
          }
        >
          {textNodes.map((node) => {
            if (node.type !== 'text') return null;
            const base = node.content.map((span) => span.text).join('');
            const value =
              instance.overrides[node.id]?.content?.map((span) => span.text).join('') ?? base;
            return (
              <Row key={node.id} label={node.name}>
                <Input
                  key={`${instance.id}:${node.id}:${value}`}
                  defaultValue={value}
                  disabled={disabled}
                  aria-label={`${node.name} text override`}
                  onBlur={(event) => {
                    const next = event.target.value;
                    updateInstanceOverride(instance.id, node.id, 'Override text', (override) => {
                      if (next === base) delete override.content;
                      else override.content = [{ text: next }];
                    });
                  }}
                  onKeyDown={(event) =>
                    event.key === 'Enter' && (event.target as HTMLInputElement).blur()
                  }
                />
              </Row>
            );
          })}
          {imageNodes.map((node) => {
            if (node.type !== 'image') return null;
            const base = 'url' in node.src ? node.src.url : '';
            const source = instance.overrides[node.id]?.src;
            const value = source && 'url' in source ? source.url : base;
            return (
              <Row key={node.id} label={node.name}>
                <Input
                  key={`${instance.id}:${node.id}:${value}`}
                  defaultValue={value}
                  disabled={disabled}
                  placeholder={'asset' in node.src ? 'Uses component asset' : 'Image URL'}
                  aria-label={`${node.name} image override`}
                  onBlur={(event) => {
                    const next = event.target.value.trim();
                    updateInstanceOverride(instance.id, node.id, 'Override image', (override) => {
                      if (!next || next === base) delete override.src;
                      else override.src = { url: next };
                    });
                  }}
                  onKeyDown={(event) =>
                    event.key === 'Enter' && (event.target as HTMLInputElement).blur()
                  }
                />
              </Row>
            );
          })}
          {visibilityNodes.length > 0 && (
            <Row label="Visibility">
              <Select
                value={activeVisibilityId}
                options={visibilityNodes.map((node) => ({ value: node.id, label: node.name }))}
                onValueChange={setVisibilityNodeId}
                className="ptl-insp-select"
              />
              <Tooltip
                content={activeVisibility ? 'Hide in this instance' : 'Show in this instance'}
              >
                <IconButton
                  label={activeVisibility ? 'Hide layer override' : 'Show layer override'}
                  size="sm"
                  disabled={disabled || !activeVisibilityNode}
                  active={!activeVisibility}
                  onClick={() => {
                    if (!activeVisibilityNode) return;
                    updateInstanceOverride(
                      instance.id,
                      activeVisibilityNode.id,
                      activeVisibility ? 'Hide instance layer' : 'Show instance layer',
                      (override) => {
                        const next = !activeVisibility;
                        if (next === activeBaselineVisibility) delete override.visible;
                        else override.visible = next;
                      },
                    );
                  }}
                >
                  {activeVisibility ? <Eye size={12} /> : <EyeOff size={12} />}
                </IconButton>
              </Tooltip>
            </Row>
          )}
        </Section>
      )}

      <Section title="Instance">
        <div className="ptl-component-actions-row">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              const store = useEditor.getState();
              store.setEditingInstanceOverride(instance.id, null);
              store.setEditingVariant(component.id, null);
              store.setLeftPanelTab('layers');
              store.select([component.rootId]);
              store.requestFocusNode(component.rootId);
            }}
          >
            Go to main component
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => {
              let newId: string | null = null;
              useEditor.getState().dispatchEdit('Detach instance', (draft) => {
                newId = detachInstance(draft, instance.id);
              });
              if (newId) useEditor.getState().select([newId]);
            }}
          >
            Detach
          </Button>
        </div>
      </Section>
    </>
  );
}

function MasterControls({ componentId }: { componentId: string }) {
  const component = useEditor((state) => state.doc?.components[componentId]);
  const editingVariant = useEditor((state) => state.editingVariant);
  const setEditingVariant = useEditor((state) => state.setEditingVariant);
  const disabled = useEditor((state) => state.readOnly || !state.connected);
  const [addingProp, setAddingProp] = useState(false);
  const [propName, setPropName] = useState('');
  const [firstValue, setFirstValue] = useState('');
  const [formError, setFormError] = useState('');
  const instanceCount = useEditor(
    useShallow(
      (state) =>
        Object.values(state.doc?.nodes ?? {}).filter(
          (node) => node.type === 'instance' && node.componentId === componentId,
        ).length,
    ),
  );

  if (!component) return null;
  const activeEditingVariant =
    editingVariant?.componentId === componentId ? editingVariant.key : null;
  const combinations = variantCombinations(component.variantProps);
  const variantOptions = [
    { value: '__base__', label: 'Base styles' },
    ...combinations.map((values) => ({
      value: variantKey(values, component.variantProps),
      label: component.variantProps.map((prop) => `${prop.name}: ${values[prop.name]}`).join(', '),
    })),
  ];

  return (
    <Section title={component.name}>
      <div className="ptl-component-master-summary">
        <span>Main component</span>
        <span>
          {instanceCount} {instanceCount === 1 ? 'instance' : 'instances'}
        </span>
      </div>
      {component.variantProps.length > 0 && (
        <Row label="Editing">
          <Select
            value={activeEditingVariant ?? '__base__'}
            options={variantOptions}
            disabled={disabled}
            onValueChange={(value) =>
              setEditingVariant(componentId, value === '__base__' ? null : value)
            }
            className="ptl-insp-select"
          />
        </Row>
      )}

      <div className="ptl-variant-props">
        {component.variantProps.map((prop) => (
          <VariantPropertyEditor
            key={prop.name}
            componentId={componentId}
            prop={prop}
            disabled={disabled}
          />
        ))}
      </div>

      {addingProp ? (
        <div className="ptl-variant-add-form">
          <Input
            value={propName}
            onChange={(event) => setPropName(event.target.value)}
            placeholder="Property name"
            aria-label="Variant property name"
            autoFocus
          />
          <Input
            value={firstValue}
            onChange={(event) => setFirstValue(event.target.value)}
            placeholder="First value"
            aria-label="First variant value"
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                submitVariantProperty();
              }
            }}
          />
          {formError && <span className="ptl-component-form-error">{formError}</span>}
          <div className="ptl-component-actions-row">
            <Button size="sm" variant="primary" onClick={submitVariantProperty}>
              Add property
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setAddingProp(false);
                setFormError('');
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button size="sm" variant="ghost" disabled={disabled} onClick={() => setAddingProp(true)}>
          <Plus size={12} />
          Add variant property
        </Button>
      )}
    </Section>
  );

  function submitVariantProperty() {
    let changed = false;
    useEditor.getState().dispatchEdit('Add variant property', (draft) => {
      changed = addVariantProperty(draft, componentId, propName, firstValue);
    });
    if (!changed) {
      setFormError('Use a unique code-style name and a value without commas or equals signs.');
      return;
    }
    setEditingVariant(componentId, null);
    setPropName('');
    setFirstValue('');
    setFormError('');
    setAddingProp(false);
  }
}

function VariantPropertyEditor({
  componentId,
  prop,
  disabled,
}: {
  componentId: string;
  prop: VariantProp;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [newValue, setNewValue] = useState('');
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmRemoveValue, setConfirmRemoveValue] = useState<string | null>(null);

  return (
    <div className="ptl-variant-prop">
      <div className="ptl-variant-prop-summary">
        <span>
          <strong>{prop.name}</strong>
          <small>{prop.values.length} values</small>
        </span>
        <Tooltip content={`Edit ${prop.name}`}>
          <IconButton
            label={`Edit ${prop.name}`}
            size="sm"
            active={open}
            onClick={() => setOpen((value) => !value)}
          >
            <Settings2 size={12} />
          </IconButton>
        </Tooltip>
      </div>
      {open && (
        <div className="ptl-variant-prop-editor">
          <Row label="Name">
            <Input
              key={prop.name}
              defaultValue={prop.name}
              disabled={disabled}
              onBlur={(event) => {
                const next = event.target.value.trim();
                if (!next || next === prop.name) return;
                mutateVariant(
                  'Rename variant property',
                  (draft) => renameVariantProperty(draft, componentId, prop.name, next),
                  'Use a unique code-style property name.',
                );
              }}
              onKeyDown={(event) =>
                event.key === 'Enter' && (event.target as HTMLInputElement).blur()
              }
            />
          </Row>
          <Row label="Default">
            <Select
              value={prop.default}
              options={prop.values.map((value) => ({ value, label: value }))}
              disabled={disabled}
              onValueChange={(value) =>
                mutateVariant('Set variant default', (draft) =>
                  setVariantDefault(draft, componentId, prop.name, value),
                )
              }
              className="ptl-insp-select"
            />
          </Row>
          <div className="ptl-variant-values">
            {prop.values.map((value) => (
              <div key={value} className="ptl-variant-value">
                <Input
                  key={`${prop.name}:${value}`}
                  defaultValue={value}
                  disabled={disabled}
                  aria-label={`${prop.name} value ${value}`}
                  onBlur={(event) => {
                    const next = event.target.value.trim();
                    if (!next || next === value) return;
                    mutateVariant(
                      'Rename variant value',
                      (draft) => renameVariantValue(draft, componentId, prop.name, value, next),
                      'Variant values must be unique and cannot contain commas or equals signs.',
                    );
                  }}
                  onKeyDown={(event) =>
                    event.key === 'Enter' && (event.target as HTMLInputElement).blur()
                  }
                />
                <Tooltip
                  content={
                    prop.values.length <= 1
                      ? 'A property needs at least one value'
                      : `Remove ${value}`
                  }
                >
                  <IconButton
                    label={`Remove ${value}`}
                    size="sm"
                    disabled={disabled || prop.values.length <= 1}
                    onClick={() => setConfirmRemoveValue(value)}
                  >
                    <X size={11} />
                  </IconButton>
                </Tooltip>
              </div>
            ))}
          </div>
          {confirmRemoveValue && (
            <div className="ptl-component-danger-confirm">
              <span>
                Remove “{confirmRemoveValue}” and any styles saved for combinations that use it?
              </span>
              <Button
                size="sm"
                variant="danger"
                onClick={() => {
                  mutateVariant('Remove variant value', (draft) =>
                    removeVariantValue(draft, componentId, prop.name, confirmRemoveValue),
                  );
                  setConfirmRemoveValue(null);
                }}
              >
                Remove value
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmRemoveValue(null)}>
                Cancel
              </Button>
            </div>
          )}
          <div className="ptl-variant-value-add">
            <Input
              value={newValue}
              onChange={(event) => setNewValue(event.target.value)}
              placeholder="Add value"
              disabled={disabled}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  addValue();
                }
              }}
            />
            <IconButton label="Add variant value" size="sm" disabled={disabled} onClick={addValue}>
              <Plus size={12} />
            </IconButton>
          </div>
          {error && <span className="ptl-component-form-error">{error}</span>}
          {confirmDelete ? (
            <div className="ptl-component-danger-confirm">
              <span>Remove this property and its saved variant styles?</span>
              <Button
                size="sm"
                variant="danger"
                onClick={() =>
                  mutateVariant('Delete variant property', (draft) =>
                    deleteVariantProperty(draft, componentId, prop.name),
                  )
                }
              >
                Delete property
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 size={12} />
              Delete property
            </Button>
          )}
        </div>
      )}
    </div>
  );

  function mutateVariant(
    label: string,
    mutate: (draft: Draft<PitoletDocument>) => boolean,
    message = 'That change could not be applied.',
  ): boolean {
    let changed = false;
    useEditor.getState().dispatchEdit(label, (draft) => {
      changed = mutate(draft);
    });
    if (!changed) setError(message);
    else {
      setError('');
      useEditor.getState().setEditingVariant(componentId, null);
    }
    return changed;
  }

  function addValue() {
    const value = newValue.trim();
    if (!value) return;
    const changed = mutateVariant(
      'Add variant value',
      (draft) => addVariantValue(draft, componentId, prop.name, value),
      'Variant values must be unique and cannot contain commas or equals signs.',
    );
    if (changed) setNewValue('');
  }
}

function updateInstanceOverride(
  instanceId: NodeId,
  nodeId: NodeId,
  label: string,
  update: (override: NonNullable<InstanceNode['overrides'][string]>) => void,
) {
  useEditor.getState().dispatchEdit(label, (draft) => {
    const instance = draft.nodes[instanceId];
    if (instance?.type !== 'instance') return;
    const override = (instance.overrides[nodeId] = instance.overrides[nodeId] ?? {});
    update(override);
    if (
      override.content === undefined &&
      override.src === undefined &&
      override.styles === undefined &&
      override.visible === undefined
    ) {
      delete instance.overrides[nodeId];
    }
  });
}

function nodeTypeLabel(node: PitoletNode): string {
  if (node.type === 'element') return 'Box';
  return node.type.charAt(0).toUpperCase() + node.type.slice(1);
}
