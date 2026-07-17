import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKSPACE_PREFERENCES,
  LEFT_PANEL_MAX,
  RIGHT_PANEL_MIN,
  fitCodePanelHeight,
  fitPanelWidths,
  isInspectorSectionCollapsed,
  readWorkspacePreferences,
  setInspectorSectionCollapsed,
  updateWorkspacePreferences,
} from '../src/workspacePreferences.js';

class MemoryStorage {
  private values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe('workspace preferences', () => {
  it('uses safe defaults when no stored preferences exist', () => {
    expect(readWorkspacePreferences(new MemoryStorage())).toEqual(DEFAULT_WORKSPACE_PREFERENCES);
  });

  it('persists panel state and clamps invalid dimensions', () => {
    const storage = new MemoryStorage();
    updateWorkspacePreferences(
      {
        leftPanelOpen: false,
        leftPanelWidth: 9_999,
        rightPanelWidth: 10,
        leftPanelTab: 'components',
        codePanelOpen: true,
      },
      storage,
    );

    const preferences = readWorkspacePreferences(storage);
    expect(preferences.leftPanelOpen).toBe(false);
    expect(preferences.leftPanelWidth).toBe(LEFT_PANEL_MAX);
    expect(preferences.rightPanelWidth).toBe(RIGHT_PANEL_MIN);
    expect(preferences.leftPanelTab).toBe('components');
    expect(preferences.codePanelOpen).toBe(true);
  });

  it('persists collapsed inspector sections without duplicates', () => {
    const storage = new MemoryStorage();
    setInspectorSectionCollapsed('Spacing', true, storage);
    setInspectorSectionCollapsed('Spacing', true, storage);
    expect(isInspectorSectionCollapsed('Spacing', storage)).toBe(true);
    expect(readWorkspacePreferences(storage).collapsedInspectorSections).toEqual(['Spacing']);

    setInspectorSectionCollapsed('Spacing', false, storage);
    expect(isInspectorSectionCollapsed('Spacing', storage)).toBe(false);
  });

  it('reconciles open panels with ordinary viewport resizing', () => {
    expect(fitPanelWidths(1_000, 420, 480, true, true)).toEqual({
      left: 312,
      right: 368,
    });
    expect(fitPanelWidths(800, 420, 480, true, false).left).toBe(420);
    expect(fitPanelWidths(720, 420, 480, true, false).left).toBe(364);
    expect(fitCodePanelHeight(500, 640)).toBe(240);
  });
});
