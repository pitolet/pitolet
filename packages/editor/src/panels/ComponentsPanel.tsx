import { Component } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { insertInstance } from '../store/componentMutations.js';
import { useEditor } from '../store/index.js';
import './ComponentsPanel.css';

/**
 * Component library. Click a component to insert an instance into the
 * current selection's container (or the first frame).
 */
export function ComponentsPanel() {
  const components = useEditor(
    useShallow((s) => Object.values(s.doc?.components ?? {}).map((c) => c)),
  );

  if (components.length === 0) {
    return (
      <div className="ptl-panel-empty">
        No components yet.
        <br />
        <span className="ptl-insp-hint">Select something and press ⌘⌥K to componentize it.</span>
      </div>
    );
  }

  const insert = (componentId: string) => {
    const store = useEditor.getState();
    const doc = store.doc;
    if (!doc) return;
    // Insert into the selected container, the selection's parent, or the first frame.
    let target = store.selection[0] ? doc.nodes[store.selection[0]] : undefined;
    if (target && target.type !== 'frame' && target.type !== 'element') {
      target = target.parent ? doc.nodes[target.parent] : undefined;
    }
    const parentId = target?.id ?? doc.rootOrder[0];
    if (!parentId) return;
    let newId: string | null = null;
    store.dispatchEdit('Insert instance', (draft) => {
      newId = insertInstance(draft, componentId, parentId);
    });
    if (newId) store.select([newId]);
  };

  return (
    <div className="ptl-components">
      {components.map((component) => (
        <button
          key={component.id}
          type="button"
          className="ptl-component-card"
          onClick={() => insert(component.id)}
          title="Insert instance"
        >
          <Component size={14} />
          <span className="ptl-component-name">{component.name}</span>
          {component.variantProps.length > 0 && (
            <span className="ptl-component-variants">
              {component.variantProps.map((p) => p.name).join(', ')}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
