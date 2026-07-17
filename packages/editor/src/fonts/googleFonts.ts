import { isTokenRef, type PitoletDocument, type StyleDecl, type StyleSheet } from '@pitolet/schema';

/**
 * Google Fonts loading. Families load on demand via the CSS2 API with the
 * full variable weight range, so every weight the inspector offers renders
 * without re-fetching.
 */

export const SYSTEM_FAMILIES = new Set([
  'system-ui',
  'Arial',
  'Helvetica',
  'Helvetica Neue',
  'Georgia',
  'Times New Roman',
  'Menlo',
  'Monaco',
  'Courier New',
  'sans-serif',
  'serif',
  'monospace',
]);

/** Curated popular list for the font picker (any Google family name works). */
export const GOOGLE_FONTS = [
  'Inter',
  'Roboto',
  'Open Sans',
  'Lato',
  'Montserrat',
  'Poppins',
  'Raleway',
  'Nunito',
  'Work Sans',
  'DM Sans',
  'Plus Jakarta Sans',
  'Manrope',
  'Sora',
  'Outfit',
  'Space Grotesk',
  'Figtree',
  'Lexend',
  'Rubik',
  'Karla',
  'Urbanist',
  'Playfair Display',
  'Merriweather',
  'Lora',
  'Libre Baskerville',
  'Cormorant',
  'Crimson Pro',
  'Source Serif 4',
  'Fraunces',
  'JetBrains Mono',
  'Fira Code',
  'IBM Plex Mono',
  'Space Mono',
  'Source Code Pro',
  'Caveat',
  'Pacifico',
  'Bebas Neue',
  'Archivo',
  'Barlow',
  'Mulish',
  'Albert Sans',
];

const loaded = new Set<string>();

export function ensureFontLoaded(family: string): void {
  if (!family || SYSTEM_FAMILIES.has(family) || family.includes(',') || loaded.has(family)) return;
  loaded.add(family);
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = fontCssUrl(family);
  document.head.appendChild(link);
}

export function fontCssUrl(family: string): string {
  const encoded = family.replace(/ /g, '+');
  // Variable range first; static-weight families fall back via the second query.
  return `https://fonts.googleapis.com/css2?family=${encoded}:wght@100..900&family=${encoded}:wght@400;500;600;700&display=swap`;
}

/** Every font family a document references (tokens + raw node styles). */
export function documentFonts(doc: PitoletDocument): string[] {
  const families = new Set<string>();
  const localFamilies = new Set(
    Object.values(doc.assets)
      .map((asset) => asset.fontFace?.family)
      .filter((family): family is string => Boolean(family)),
  );
  const addDecl = (decl: Partial<StyleDecl> | undefined) => {
    const raw = decl?.fontFamily;
    if (typeof raw === 'string') families.add(raw);
    else if (raw && !isTokenRef(raw)) families.add(String(raw));
  };
  const addSheet = (sheet: StyleSheet) => {
    addDecl(sheet.base);
    Object.values(sheet.breakpoints ?? {}).forEach(addDecl);
    Object.values(sheet.states ?? {}).forEach(addDecl);
  };
  for (const token of Object.values(doc.tokens.typography.fontFamily)) {
    families.add(token.$value);
  }
  for (const node of Object.values(doc.nodes)) {
    addSheet(node.styles);
    if (node.type === 'instance') {
      for (const override of Object.values(node.overrides)) addDecl(override.styles);
    }
  }
  for (const component of Object.values(doc.components)) {
    for (const patches of Object.values(component.variants)) {
      for (const patch of Object.values(patches)) addDecl(patch.styles);
    }
  }
  return [...families].filter(
    (f) => !SYSTEM_FAMILIES.has(f) && !f.includes(',') && !localFamilies.has(f),
  );
}

/** Keep all document-referenced fonts loaded (call on doc changes). */
export function syncDocumentFonts(doc: PitoletDocument | null): void {
  if (!doc) return;
  for (const family of documentFonts(doc)) ensureFontLoaded(family);
}
