import { importedFontFaceCss } from '@pitolet/codegen';
import type { PitoletDocument } from '@pitolet/schema';
import { assetUrl } from '../sync/serverBase.js';

const STYLE_ID = 'pitolet-imported-fonts';

export function importedDocumentFontCss(doc: PitoletDocument | null): string {
  return doc ? importedFontFaceCss(doc.assets, assetUrl) : '';
}

/** Replace the document-scoped local @font-face sheet after document edits/switches. */
export function syncImportedDocumentFonts(doc: PitoletDocument | null): void {
  const css = importedDocumentFontCss(doc);
  const existing = document.getElementById(STYLE_ID);
  if (!css) {
    existing?.remove();
    return;
  }
  const style = existing instanceof HTMLStyleElement ? existing : document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = css;
  if (!style.isConnected) document.head.appendChild(style);
}
