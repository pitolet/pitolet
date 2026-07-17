import { MAX_ZOOM, MIN_ZOOM } from '../canvas/CameraController.js';

export interface DocumentSummary {
  id: string;
  name: string;
  frameCount: number;
}

export function filterDocuments(
  documents: DocumentSummary[],
  query: string,
  activeId?: string,
): DocumentSummary[] {
  const needle = query.trim().toLocaleLowerCase();
  return documents
    .filter((document) => !needle || document.name.toLocaleLowerCase().includes(needle))
    .sort((a, b) => {
      if (a.id === activeId) return -1;
      if (b.id === activeId) return 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
}

export function parseZoomPercent(value: string): number | null {
  const normalized = value.trim().replace(/%$/, '').trim();
  const percent = Number(normalized);
  if (!Number.isFinite(percent) || percent <= 0) return null;
  return Math.round(Math.min(MAX_ZOOM * 100, Math.max(MIN_ZOOM * 100, percent)) * 100) / 100;
}
