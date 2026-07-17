import { createSampleDocument } from '@pitolet/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { COMMANDS } from '../src/commands/registry.js';
import { history, setPatchSender, useEditor } from '../src/store/index.js';

function enabled(id: string): boolean {
  const command = COMMANDS.find((candidate) => candidate.id === id);
  if (!command) throw new Error(`missing command ${id}`);
  return command.when?.() ?? true;
}

describe('command availability', () => {
  beforeEach(() => {
    history.clear();
    setPatchSender(() => {});
    const doc = createSampleDocument();
    useEditor.getState().setDocument(doc, 0);
    useEditor.getState().setConnected(true);
    useEditor.getState().setReadOnly(false);
    useEditor.getState().select([doc.rootOrder[0]!]);
  });

  it.each(['tool-frame', 'tool-box', 'tool-text', 'paste', 'duplicate', 'delete'])(
    'disables %s whenever editing is paused',
    (id) => {
      expect(enabled(id)).toBe(true);

      useEditor.getState().setSwitchingDocument(true);
      expect(enabled(id)).toBe(false);

      useEditor.getState().setSwitchingDocument(false);
      useEditor.getState().setConnected(false);
      expect(enabled(id)).toBe(false);

      useEditor.getState().setConnected(true);
      useEditor.getState().setReadOnly(true);
      expect(enabled(id)).toBe(false);
    },
  );

  it('keeps non-mutating selection and view commands available offline', () => {
    useEditor.getState().setConnected(false);
    expect(enabled('copy')).toBe(true);
    expect(enabled('zoom-fit')).toBe(true);
    expect(enabled('preview')).toBe(true);
    expect(enabled('tool-select')).toBe(true);
  });
});
