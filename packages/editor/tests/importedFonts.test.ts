import { createDocument } from '@pitolet/schema';
import { afterEach, describe, expect, it } from 'vitest';
import { importedDocumentFontCss, syncImportedDocumentFonts } from '../src/fonts/importedFonts.js';
import { documentFonts } from '../src/fonts/googleFonts.js';

describe('imported document fonts', () => {
  afterEach(() => document.getElementById('pitolet-imported-fonts')?.remove());

  it('loads a content-addressed local font and does not also hotlink Google Fonts', () => {
    const doc = createDocument({ name: 'Imported font' });
    doc.tokens.typography.fontFamily.brand = { $value: 'Example Sans' };
    doc.assets[`${'a'.repeat(64)}.woff2`] = {
      fileName: 'example.woff2',
      width: 0,
      height: 0,
      mime: 'font/woff2',
      fontFace: { family: 'Example Sans', style: 'normal', weight: '100 900', display: 'swap' },
    };

    expect(documentFonts(doc)).not.toContain('Example Sans');
    expect(importedDocumentFontCss(doc)).toContain('@font-face');
    expect(importedDocumentFontCss(doc)).toContain(`/assets-store/${'a'.repeat(64)}.woff2`);

    syncImportedDocumentFonts(doc);
    expect(document.getElementById('pitolet-imported-fonts')?.textContent).toContain(
      "font-family: 'Example Sans'",
    );
    syncImportedDocumentFonts(null);
    expect(document.getElementById('pitolet-imported-fonts')).toBeNull();
  });
});
