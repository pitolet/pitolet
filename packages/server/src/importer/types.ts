import type { PitoletDocument } from '@pitolet/schema';

export interface CaptureRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Serializable subset of computed CSS used by the structured converter. */
export type CapturedStyles = Record<string, string>;

export interface CapturedNode {
  key: string;
  kind: 'element' | 'text';
  tag: string;
  parentKey: string | null;
  children: string[];
  text: string;
  name: string;
  attrs: Record<string, string>;
  rect: CaptureRect;
  styles: CapturedStyles;
  assetUrl?: string;
  unsupportedReason?: string;
}

export interface CaptureSnapshot {
  width: number;
  height: number;
  fullHeight: number;
  rootKey: string;
  nodes: Record<string, CapturedNode>;
  screenshot: Buffer;
}

export interface CapturedAsset {
  key: string;
  fileName: string;
  mime: string;
  width: number;
  height: number;
  data: Buffer;
}

export interface WebCapture {
  version: 1;
  captureId: string;
  sourceUrl: string;
  rootSelector: string;
  title: string;
  snapshots: CaptureSnapshot[];
  cssVariables: Record<string, string>;
  fonts: string[];
  assets: CapturedAsset[];
  warnings: string[];
}

export interface ImportConversion {
  document: PitoletDocument;
  nodeCount: number;
  assetCount: number;
  rasterizedRegions: number;
  unsupportedCss: string[];
  unmatchedResponsiveNodes: number;
  warnings: string[];
}

export interface SimilarityResult {
  width: number;
  score: number;
  sourcePath: string;
  importedPath: string;
  differencePath: string;
}

export interface ImportReport {
  sourceUrl: string;
  destination: string;
  documentId: string;
  documentName: string;
  documentUrl: string;
  nodeCount: number;
  assetCount: number;
  rasterizedRegions: number;
  unsupportedCss: string[];
  unmatchedResponsiveNodes: number;
  similarities: SimilarityResult[];
  warnings: string[];
  reportDir: string;
}

export interface CaptureOptions {
  url: string;
  selector?: string;
  storageState?: string;
  waitFor?: string;
  viewports: number[];
  onBrowserInstall?: () => void;
}
