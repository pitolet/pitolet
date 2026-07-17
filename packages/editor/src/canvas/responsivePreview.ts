/**
 * Return the temporary canvas width used while editing a breakpoint.
 * Only the active frame changes, so unrelated artboards stay put and the
 * document itself is never mutated. The active frame is session state rather
 * than a selection side effect, which makes a viewport click respond at once.
 */
export function responsivePreviewWidth(
  frameId: string,
  activeFrameId: string | null,
  breakpoints: Array<{ id: string; minWidth: number }>,
  breakpointId: string | null,
): number | null {
  if (!breakpointId || frameId !== activeFrameId) return null;
  const breakpoint = breakpoints.find((candidate) => candidate.id === breakpointId);
  if (!breakpoint) return null;
  return breakpoint.minWidth;
}

/** Keep built-in shorthand, but do not expose importer-internal IDs to people. */
export function breakpointDisplayLabel(breakpoint: {
  id: string;
  name: string;
  minWidth: number;
}): string {
  if (!breakpoint.id.startsWith('import-')) return breakpoint.id;
  const name = breakpoint.name.replace(/^imported\s+/i, '').trim();
  return (name || `${breakpoint.minWidth}px`).toLowerCase();
}
