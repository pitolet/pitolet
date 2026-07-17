export type LeftPanelTab = 'layers' | 'tokens' | 'components';

export interface WorkspacePreferences {
  leftPanelOpen: boolean;
  rightPanelOpen: boolean;
  leftPanelWidth: number;
  rightPanelWidth: number;
  codePanelOpen: boolean;
  codePanelHeight: number;
  leftPanelTab: LeftPanelTab;
  collapsedInspectorSections: string[];
}

export const LEFT_PANEL_MIN = 190;
export const LEFT_PANEL_MAX = 420;
export const RIGHT_PANEL_MIN = 240;
export const RIGHT_PANEL_MAX = 480;
export const CODE_PANEL_MIN = 140;
export const CODE_PANEL_MAX = 640;

const STORAGE_KEY = 'pitolet.editor.workspace.v1';

export const DEFAULT_WORKSPACE_PREFERENCES: WorkspacePreferences = {
  leftPanelOpen: true,
  rightPanelOpen: true,
  leftPanelWidth: 248,
  rightPanelWidth: 264,
  codePanelOpen: false,
  codePanelHeight: 300,
  leftPanelTab: 'layers',
  collapsedInspectorSections: [],
};

type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function readWorkspacePreferences(
  storage: PreferenceStorage | null = browserStorage(),
): WorkspacePreferences {
  if (!storage) return { ...DEFAULT_WORKSPACE_PREFERENCES };
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_WORKSPACE_PREFERENCES };
    const parsed = JSON.parse(raw) as Partial<WorkspacePreferences>;
    return normalizePreferences(parsed);
  } catch {
    return { ...DEFAULT_WORKSPACE_PREFERENCES };
  }
}

export function updateWorkspacePreferences(
  patch: Partial<WorkspacePreferences>,
  storage: PreferenceStorage | null = browserStorage(),
): WorkspacePreferences {
  const next = normalizePreferences({ ...readWorkspacePreferences(storage), ...patch });
  if (storage) {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Preferences should never block editing when storage is unavailable.
    }
  }
  return next;
}

export function isInspectorSectionCollapsed(
  key: string,
  storage: PreferenceStorage | null = browserStorage(),
): boolean {
  return readWorkspacePreferences(storage).collapsedInspectorSections.includes(key);
}

export function setInspectorSectionCollapsed(
  key: string,
  collapsed: boolean,
  storage: PreferenceStorage | null = browserStorage(),
): void {
  const current = readWorkspacePreferences(storage).collapsedInspectorSections;
  const sections = new Set(current);
  if (collapsed) sections.add(key);
  else sections.delete(key);
  updateWorkspacePreferences({ collapsedInspectorSections: [...sections].sort() }, storage);
}

export function clampLeftPanelWidth(value: number): number {
  return clamp(value, LEFT_PANEL_MIN, LEFT_PANEL_MAX);
}

export function clampRightPanelWidth(value: number): number {
  return clamp(value, RIGHT_PANEL_MIN, RIGHT_PANEL_MAX);
}

export function clampCodePanelHeight(value: number): number {
  return clamp(value, CODE_PANEL_MIN, CODE_PANEL_MAX);
}

export function fitPanelWidths(
  viewportWidth: number,
  leftWidth: number,
  rightWidth: number,
  leftOpen: boolean,
  rightOpen: boolean,
): { left: number; right: number } {
  let left = clampLeftPanelWidth(leftWidth);
  let right = clampRightPanelWidth(rightWidth);
  const centerMinimum = 320;
  const closedRailWidth = 36;

  if (leftOpen && rightOpen) {
    const available = Math.max(LEFT_PANEL_MIN + RIGHT_PANEL_MIN, viewportWidth - centerMinimum);
    const minimum = LEFT_PANEL_MIN + RIGHT_PANEL_MIN;
    const surplus = left - LEFT_PANEL_MIN + (right - RIGHT_PANEL_MIN);
    if (left + right > available && surplus > 0) {
      const scale = Math.max(0, Math.min(1, (available - minimum) / surplus));
      left = Math.round(LEFT_PANEL_MIN + (left - LEFT_PANEL_MIN) * scale);
      right = Math.round(RIGHT_PANEL_MIN + (right - RIGHT_PANEL_MIN) * scale);
    }
  } else if (leftOpen) {
    left = Math.min(
      left,
      Math.max(LEFT_PANEL_MIN, viewportWidth - centerMinimum - closedRailWidth),
    );
  } else if (rightOpen) {
    right = Math.min(
      right,
      Math.max(RIGHT_PANEL_MIN, viewportWidth - centerMinimum - closedRailWidth),
    );
  }
  return { left, right };
}

export function fitCodePanelHeight(viewportHeight: number, height: number): number {
  return Math.min(clampCodePanelHeight(height), Math.max(CODE_PANEL_MIN, viewportHeight - 260));
}

function normalizePreferences(value: Partial<WorkspacePreferences>): WorkspacePreferences {
  const collapsed = Array.isArray(value.collapsedInspectorSections)
    ? value.collapsedInspectorSections.filter(
        (section): section is string => typeof section === 'string',
      )
    : [];
  return {
    leftPanelOpen:
      typeof value.leftPanelOpen === 'boolean'
        ? value.leftPanelOpen
        : DEFAULT_WORKSPACE_PREFERENCES.leftPanelOpen,
    rightPanelOpen:
      typeof value.rightPanelOpen === 'boolean'
        ? value.rightPanelOpen
        : DEFAULT_WORKSPACE_PREFERENCES.rightPanelOpen,
    leftPanelWidth: clampLeftPanelWidth(
      finiteOr(value.leftPanelWidth, DEFAULT_WORKSPACE_PREFERENCES.leftPanelWidth),
    ),
    rightPanelWidth: clampRightPanelWidth(
      finiteOr(value.rightPanelWidth, DEFAULT_WORKSPACE_PREFERENCES.rightPanelWidth),
    ),
    codePanelOpen:
      typeof value.codePanelOpen === 'boolean'
        ? value.codePanelOpen
        : DEFAULT_WORKSPACE_PREFERENCES.codePanelOpen,
    codePanelHeight: clampCodePanelHeight(
      finiteOr(value.codePanelHeight, DEFAULT_WORKSPACE_PREFERENCES.codePanelHeight),
    ),
    leftPanelTab: isLeftPanelTab(value.leftPanelTab)
      ? value.leftPanelTab
      : DEFAULT_WORKSPACE_PREFERENCES.leftPanelTab,
    collapsedInspectorSections: [...new Set(collapsed)].sort(),
  };
}

function isLeftPanelTab(value: unknown): value is LeftPanelTab {
  return value === 'layers' || value === 'tokens' || value === 'components';
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function browserStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
