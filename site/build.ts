/**
 * Builds pitolet.com's landing page — AS A PITOLET DOCUMENT.
 *
 * The whole point: this page is not hand-written HTML. It is a real Pitolet
 * document (a code-shaped JSON node map) constructed with the schema factories,
 * validated with validateDocument, and rendered to static HTML by Pitolet's own
 * deterministic codegen (buildPreviewHtml → nodeToHtml). The landing page being
 * a Pitolet export *is* the product demo.
 *
 * Run indirectly via `node site/build.mjs` (which boots the tsx TS loader).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  attach,
  createDocument,
  createElement,
  createFrame,
  createImage,
  createText,
  oklch,
  px,
  sides,
  validateDocument,
  structuralProblems,
  type PitoletDocument,
  type StyleDecl,
  type Color,
  type Length,
} from '../packages/schema/src/index.ts';
import { buildPreviewHtml } from '../packages/codegen/src/index.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Token helpers — reference the document's own token set (dark Pitolet theme)
// ---------------------------------------------------------------------------

const t = (token: string) => ({ $token: token });
const sp = (name: string) => ({ $token: `spacing.${name}` });
const fs = (name: string) => ({ $token: `typography.fontSize.${name}` });
const rad = (name: string) => ({ $token: `radius.${name}` });

/** All four sides equal from a token ref. */
const padAll = (tok: unknown) => sides(tok as StyleValueLength);
/** Independent vertical / horizontal padding. */
const padXY = (y: unknown, x: unknown) => ({
  top: y as StyleValueLength,
  bottom: y as StyleValueLength,
  left: x as StyleValueLength,
  right: x as StyleValueLength,
});
const padTRBL = (top: unknown, right: unknown, bottom: unknown, left: unknown) => ({
  top: top as StyleValueLength,
  right: right as StyleValueLength,
  bottom: bottom as StyleValueLength,
  left: left as StyleValueLength,
});
const gap = (row: unknown, col: unknown) => ({
  row: row as StyleValueLength,
  column: col as StyleValueLength,
});
const radAll = (tok: unknown) => ({
  tl: tok as StyleValueLength,
  tr: tok as StyleValueLength,
  br: tok as StyleValueLength,
  bl: tok as StyleValueLength,
});
const fill = (tok: unknown) => [{ type: 'solid' as const, color: tok as StyleValueColor }];

type StyleValueLength = Length | { $token: string };
type StyleValueColor = Color | { $token: string };

// ---------------------------------------------------------------------------
// The document + dark theme tokens (mirror packages/ui/src/tokens.css)
// ---------------------------------------------------------------------------

function applyPitoletTheme(doc: PitoletDocument) {
  // Overwrite the starter (light) palette with Pitolet's own dark system.
  doc.tokens.color = {
    background: { $value: oklch(0.13, 0.006, 250), $description: 'Page canvas' },
    surface: { $value: oklch(0.165, 0.008, 250), $description: 'Raised surface' },
    'surface-2': { $value: oklch(0.2, 0.009, 250), $description: 'Card surface' },
    foreground: { $value: oklch(0.95, 0.006, 250), $description: 'Primary text' },
    'muted-foreground': { $value: oklch(0.7, 0.012, 250), $description: 'Secondary text' },
    'subtle-foreground': { $value: oklch(0.55, 0.014, 250), $description: 'Tertiary text' },
    primary: { $value: oklch(0.71, 0.125, 215), $description: 'Glacial accent' },
    'primary-strong': { $value: oklch(0.6, 0.14, 222), $description: 'Accent (pressed)' },
    'primary-foreground': { $value: oklch(0.14, 0.02, 222), $description: 'Text on accent' },
    border: { $value: oklch(1, 0, 0, 0.09), $description: 'Hairline border' },
    'border-strong': { $value: oklch(1, 0, 0, 0.16), $description: 'Stronger border' },
  };
  doc.tokens.typography.fontFamily.sans = { $value: 'Inter' };
  doc.tokens.typography.fontFamily.mono = { $value: 'JetBrains Mono' };
  // Extend the type scale for the hero display size.
  doc.tokens.typography.fontSize['7xl'] = { $value: px(72) };
}

function buildDoc(): { doc: PitoletDocument; frameId: string } {
  const doc = createDocument({ name: 'Pitolet Landing', id: 'pitolet-landing' });
  applyPitoletTheme(doc);

  const frame = attach(
    doc,
    null,
    createFrame({
      name: 'Landing',
      x: 0,
      y: 0,
      width: 1440,
      height: 'auto',
      styles: {
        alignItems: 'center',
        fontFamily: t('typography.fontFamily.sans'),
        color: t('color.foreground'),
        fills: fill(t('color.background')),
      },
    }),
  );

  buildNav(doc, frame.id);
  buildHero(doc, frame.id);
  buildValueProps(doc, frame.id);
  buildDogfoodNote(doc, frame.id);
  buildPricing(doc, frame.id);
  buildFooter(doc, frame.id);

  return { doc, frameId: frame.id };
}

function buildComparisonDoc(): { doc: PitoletDocument; frameId: string } {
  const doc = createDocument({ name: 'Pitolet vs Figma', id: 'pitolet-vs-figma' });
  applyPitoletTheme(doc);

  const frame = attach(
    doc,
    null,
    createFrame({
      name: 'Pitolet vs Figma',
      x: 0,
      y: 0,
      width: 1440,
      height: 'auto',
      styles: {
        alignItems: 'center',
        fontFamily: t('typography.fontFamily.sans'),
        color: t('color.foreground'),
        fills: fill(t('color.background')),
      },
    }),
  );

  buildNav(doc, frame.id);
  buildComparisonHero(doc, frame.id);
  buildComparisonMatrix(doc, frame.id);
  buildFigmaWins(doc, frame.id);
  buildTeamUseCases(doc, frame.id);
  buildComparisonCta(doc, frame.id);
  buildFooter(doc, frame.id);

  return { doc, frameId: frame.id };
}

// ---------------------------------------------------------------------------
// Shared building blocks
// ---------------------------------------------------------------------------

/** A centered content column: sections attach a full-bleed band, then this. */
function contentColumn(
  doc: PitoletDocument,
  parentId: string,
  name: string,
  styles: StyleDecl = {},
) {
  return attach(
    doc,
    parentId,
    createElement({
      name,
      styles: {
        display: 'flex',
        flexDirection: 'column',
        width: 'fill',
        maxWidth: px(1120),
        ...styles,
      },
    }),
  );
}

/**
 * Full-width band (edge to edge) that centers a content column inside.
 *
 * Padding is responsive by construction: mobile uses tighter values (`padY` /
 * `padX`), and the desktop values (`padYLg` / `padXLg`) kick in at the md
 * breakpoint via a real media query in the generated CSS.
 */
function band(
  doc: PitoletDocument,
  parentId: string,
  name: string,
  opts: {
    padTop: unknown;
    padBottom: unknown;
    padTopLg: unknown;
    padBottomLg: unknown;
    padX?: unknown;
    padXLg?: unknown;
    extra?: StyleDecl;
    extraLg?: Partial<StyleDecl>;
  },
) {
  const px5 = sp('5');
  const px10 = sp('10');
  const el = attach(
    doc,
    parentId,
    createElement({
      name,
      tag: 'section',
      styles: {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        width: 'fill',
        padding: padTRBL(opts.padTop, opts.padX ?? px5, opts.padBottom, opts.padX ?? px5),
        ...opts.extra,
      },
    }),
  );
  el.styles.breakpoints = {
    md: {
      padding: padTRBL(
        opts.padTopLg,
        opts.padXLg ?? px10,
        opts.padBottomLg,
        opts.padXLg ?? px10,
      ),
      ...opts.extraLg,
    },
  };
  return el;
}

const RIDGELINE_PATH = 'M3 18 L9.5 6 L13.5 13 L16.5 8.5 L21 18';

/** BrandMark ridgeline as an SVG data URI, rendered via an image node. */
function brandMarkDataUri(strokeCss: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" ` +
    `fill="none" stroke="${strokeCss}" stroke-width="2" stroke-linecap="round" ` +
    `stroke-linejoin="round"><path d="${RIDGELINE_PATH}"/></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const ACCENT_CSS = 'oklch(0.71 0.125 215)';

// ---------------------------------------------------------------------------
// Nav
// ---------------------------------------------------------------------------

function buildNav(doc: PitoletDocument, frameId: string) {
  const bandEl = band(doc, frameId, 'Nav Band', {
    padTop: sp('4'),
    padBottom: sp('4'),
    padTopLg: sp('6'),
    padBottomLg: sp('6'),
    extra: {
      border: { width: px(1), style: 'solid', color: t('color.border'), sides: { bottom: true } },
    },
  });
  const nav = attach(
    doc,
    bandEl.id,
    createElement({
      name: 'Nav',
      tag: 'nav',
      styles: {
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'between',
        width: 'fill',
        maxWidth: px(1120),
      },
    }),
  );

  // Brand (mark + wordmark)
  const brand = attach(
    doc,
    nav.id,
    createElement({
      name: 'Brand',
      tag: 'a',
      styles: {
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: gap(px(0), sp('2')),
        cursor: 'pointer',
      },
    }),
  );
  brand.attrs = { href: '/' };
  attach(
    doc,
    brand.id,
    createImage({
      name: 'BrandMark',
      src: { url: brandMarkDataUri(ACCENT_CSS) },
      alt: 'Pitolet',
      styles: { width: px(24), height: px(24) },
    }),
  );
  attach(
    doc,
    brand.id,
    createText({
      name: 'Wordmark',
      tag: 'span',
      text: 'Pitolet',
      styles: { fontSize: fs('lg'), fontWeight: 650, letterSpacing: px(-0.3) },
    }),
  );

  // Links + Open app
  const links = attach(
    doc,
    nav.id,
    createElement({
      name: 'Nav Links',
      styles: {
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: gap(px(0), sp('6')),
      },
    }),
  );
  const linkDefs: Array<[string, string]> = [
    ['Compare to Figma', '/vs-figma/'],
    ['GitHub', 'https://github.com/pitolet/pitolet'],
    ['Docs', 'https://github.com/pitolet/pitolet#readme'],
  ];
  for (const [label, href] of linkDefs) {
    const a = attach(
      doc,
      links.id,
      createText({
        name: label,
        tag: 'a',
        text: label,
        styles: {
          // Text links crowd the small screen; reveal them from the sm bp up.
          display: 'none',
          fontSize: fs('sm'),
          fontWeight: 500,
          color: t('color.muted-foreground'),
        },
      }),
    );
    a.attrs = { href };
    a.styles.breakpoints = { sm: { display: 'block' } };
    a.styles.states = { hover: { color: t('color.foreground') } };
  }
  const openApp = attach(
    doc,
    links.id,
    createText({
      name: 'Open App',
      tag: 'a',
      text: 'Open app',
      styles: {
        fontSize: fs('sm'),
        fontWeight: 600,
        color: t('color.primary-foreground'),
        fills: fill(t('color.primary')),
        padding: padXY(sp('2'), sp('4')),
        radius: radAll(rad('md')),
        cursor: 'pointer',
      },
    }),
  );
  openApp.attrs = { href: 'https://app.pitolet.com' };
  openApp.styles.states = { hover: { fills: fill(t('color.primary-strong')) } };
}

// ---------------------------------------------------------------------------
// Hero
// ---------------------------------------------------------------------------

function buildHero(doc: PitoletDocument, frameId: string) {
  const bandEl = band(doc, frameId, 'Hero Band', {
    padTop: sp('16'),
    padBottom: sp('16'),
    padTopLg: sp('24'),
    padBottomLg: sp('20'),
  });
  const hero = contentColumn(doc, bandEl.id, 'Hero', {
    alignItems: 'center',
    gap: gap(sp('6'), px(0)),
    maxWidth: px(880),
  });

  // Eyebrow pill
  const eyebrow = attach(
    doc,
    hero.id,
    createElement({
      name: 'Eyebrow',
      styles: {
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: gap(px(0), sp('2')),
        padding: padXY(sp('1'), sp('3')),
        fills: fill(t('color.surface')),
        border: { width: px(1), style: 'solid', color: t('color.border') },
        radius: radAll(rad('full')),
      },
    }),
  );
  attach(
    doc,
    eyebrow.id,
    createText({
      name: 'Eyebrow Text',
      tag: 'span',
      content: [
        { text: 'Design tool ', marks: undefined },
        { text: '·', marks: undefined },
        { text: ' human + agent, live', marks: undefined },
      ],
      styles: {
        fontSize: fs('sm'),
        fontWeight: 500,
        color: t('color.muted-foreground'),
        letterSpacing: px(0.2),
      },
    }),
  );

  const headline = attach(
    doc,
    hero.id,
    createText({
      name: 'Headline',
      tag: 'h1',
      text: 'Design tools for you and your coding agent.',
      styles: {
        fontSize: fs('5xl'),
        fontWeight: 700,
        letterSpacing: px(-1.5),
        lineHeight: 1.05,
        textAlign: 'center',
        maxWidth: px(760),
      },
    }),
  );
  // Scale the display headline up on larger screens.
  headline.styles.breakpoints = {
    md: { fontSize: fs('6xl'), letterSpacing: px(-2) },
    lg: { fontSize: fs('7xl') },
  };
  attach(
    doc,
    hero.id,
    createText({
      name: 'Subhead',
      tag: 'p',
      text:
        'Pitolet is a real-time design tool where you and your agent work side by side. Everything you draw is live DOM and CSS, ready to ship as code.',
      styles: {
        fontSize: fs('xl'),
        color: t('color.muted-foreground'),
        textAlign: 'center',
        maxWidth: px(620),
        lineHeight: 1.55,
      },
    }),
  );

  // CTAs
  const ctas = attach(
    doc,
    hero.id,
    createElement({
      name: 'CTAs',
      styles: {
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: gap(sp('3'), sp('3')),
        padding: padTRBL(sp('4'), px(0), px(0), px(0)),
      },
    }),
  );
  const startFree = attach(
    doc,
    ctas.id,
    createText({
      name: 'Start Free',
      tag: 'a',
      text: 'Start free',
      styles: {
        fontSize: fs('base'),
        fontWeight: 600,
        color: t('color.primary-foreground'),
        fills: fill(t('color.primary')),
        padding: padXY(sp('3'), sp('6')),
        radius: radAll(rad('md')),
        cursor: 'pointer',
      },
    }),
  );
  startFree.attrs = { href: 'https://app.pitolet.com' };
  startFree.styles.states = { hover: { fills: fill(t('color.primary-strong')) } };

  // npx pitolet code chip
  const chip = attach(
    doc,
    ctas.id,
    createElement({
      name: 'Npx Chip',
      styles: {
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: gap(px(0), sp('2')),
        padding: padXY(sp('3'), sp('4')),
        fills: fill(t('color.surface')),
        border: { width: px(1), style: 'solid', color: t('color.border-strong') },
        radius: radAll(rad('md')),
      },
    }),
  );
  attach(
    doc,
    chip.id,
    createText({
      name: 'Chip Prompt',
      tag: 'span',
      text: '$',
      styles: {
        fontFamily: t('typography.fontFamily.mono'),
        fontSize: fs('sm'),
        color: t('color.primary'),
      },
    }),
  );
  attach(
    doc,
    chip.id,
    createText({
      name: 'Chip Command',
      tag: 'code',
      text: 'npx pitolet',
      styles: {
        fontFamily: t('typography.fontFamily.mono'),
        fontSize: fs('sm'),
        color: t('color.foreground'),
      },
    }),
  );
}

// ---------------------------------------------------------------------------
// Value props (3 columns → single column under md)
// ---------------------------------------------------------------------------

function buildValueProps(doc: PitoletDocument, frameId: string) {
  const bandEl = band(doc, frameId, 'Props Band', {
    padTop: sp('12'),
    padBottom: sp('12'),
    padTopLg: sp('16'),
    padBottomLg: sp('16'),
  });
  const col = contentColumn(doc, bandEl.id, 'Props', { gap: gap(sp('10'), px(0)) });

  attach(
    doc,
    col.id,
    createText({
      name: 'Props Heading',
      tag: 'h2',
      text: 'One canvas. No fidelity gap.',
      styles: {
        fontSize: fs('4xl'),
        fontWeight: 650,
        letterSpacing: px(-1),
        textAlign: 'center',
        maxWidth: px(720),
        alignSelf: 'center',
      },
    }),
  );

  const grid = attach(
    doc,
    col.id,
    createElement({
      name: 'Props Row',
      styles: {
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'stretch',
        gap: gap(sp('6'), sp('6')),
        width: 'fill',
      },
    }),
  );
  // Stack to a single column below the md breakpoint (mobile-first: base is
  // column, ≥md becomes row). Because codegen is mobile-first, we set the base
  // to column and add a row override at the md breakpoint.
  grid.styles.base.flexDirection = 'column';
  grid.styles.breakpoints = { md: { display: 'flex', flexDirection: 'row' } };

  const props: Array<[string, string]> = [
    [
      "You're editing a real web page",
      'Every element is real DOM and real CSS. Your design renders the same way in production, because there is no translation step in between.',
    ],
    [
      'Your agent edits the same canvas',
      'Claude Code and Codex connect over MCP and work on the document you have open. They read the comments, show up as a cursor, and change tokens while you watch.',
    ],
    [
      'Ships as code',
      'Export the same document to React and Tailwind or to plain HTML and CSS. It comes out as your tokens and your components, ready to drop into the repo.',
    ],
  ];
  for (const [title, body] of props) {
    const card = attach(
      doc,
      grid.id,
      createElement({
        name: title,
        tag: 'article',
        styles: {
          display: 'flex',
          flexDirection: 'column',
          gap: gap(sp('3'), px(0)),
          padding: padAll(sp('6')),
          fills: fill(t('color.surface')),
          border: { width: px(1), style: 'solid', color: t('color.border') },
          radius: radAll(rad('lg')),
          width: 'fill',
        },
      }),
    );
    // Accent tick
    const tick = attach(
      doc,
      card.id,
      createElement({
        name: 'Tick',
        styles: {
          width: px(36),
          height: px(4),
          fills: fill(t('color.primary')),
          radius: radAll(rad('full')),
        },
      }),
    );
    void tick;
    attach(
      doc,
      card.id,
      createText({
        name: 'Card Title',
        tag: 'h3',
        text: title,
        styles: { fontSize: fs('xl'), fontWeight: 600, letterSpacing: px(-0.3) },
      }),
    );
    attach(
      doc,
      card.id,
      createText({
        name: 'Card Body',
        tag: 'p',
        text: body,
        styles: { fontSize: fs('base'), color: t('color.muted-foreground'), lineHeight: 1.6 },
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// "Built with its own tool" note
// ---------------------------------------------------------------------------

function buildDogfoodNote(doc: PitoletDocument, frameId: string) {
  const bandEl = band(doc, frameId, 'Dogfood Band', {
    padTop: px(0),
    padBottom: sp('12'),
    padTopLg: px(0),
    padBottomLg: sp('16'),
  });
  const wrap = attach(
    doc,
    bandEl.id,
    createElement({
      name: 'Dogfood',
      styles: {
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: gap(px(0), sp('2')),
        width: 'fill',
        maxWidth: px(1120),
        padding: padXY(sp('4'), sp('6')),
        fills: fill(t('color.surface')),
        border: { width: px(1), style: 'solid', color: t('color.border') },
        radius: radAll(rad('full')),
      },
    }),
  );
  attach(
    doc,
    wrap.id,
    createText({
      name: 'Dogfood Text',
      tag: 'p',
      text: 'This page is a Pitolet document, exported by Pitolet’s own codegen.',
      styles: {
        fontSize: fs('sm'),
        color: t('color.muted-foreground'),
        textAlign: 'center',
      },
    }),
  );
  const src = attach(
    doc,
    wrap.id,
    createText({
      name: 'Dogfood Link',
      tag: 'a',
      text: 'See site/ on GitHub →',
      styles: { fontSize: fs('sm'), fontWeight: 600, color: t('color.primary') },
    }),
  );
  src.attrs = { href: 'https://github.com/pitolet/pitolet/tree/main/site' };
}

// ---------------------------------------------------------------------------
// Pricing teaser
// ---------------------------------------------------------------------------

function buildPricing(doc: PitoletDocument, frameId: string) {
  const bandEl = band(doc, frameId, 'Pricing Band', {
    padTop: sp('12'),
    padBottom: sp('12'),
    padTopLg: sp('16'),
    padBottomLg: sp('16'),
    extra: {
      border: { width: px(1), style: 'solid', color: t('color.border'), sides: { top: true } },
    },
  });
  const col = contentColumn(doc, bandEl.id, 'Pricing', { gap: gap(sp('10'), px(0)) });

  attach(
    doc,
    col.id,
    createText({
      name: 'Pricing Heading',
      tag: 'h2',
      text: 'Free to start, $12 a seat when you need a team.',
      styles: {
        fontSize: fs('4xl'),
        fontWeight: 650,
        letterSpacing: px(-1),
        textAlign: 'center',
        alignSelf: 'center',
        maxWidth: px(720),
      },
    }),
  );

  const grid = attach(
    doc,
    col.id,
    createElement({
      name: 'Plans',
      styles: {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'stretch',
        gap: gap(sp('6'), sp('6')),
        width: 'fill',
      },
    }),
  );
  grid.styles.breakpoints = { md: { display: 'flex', flexDirection: 'row' } };

  type Plan = {
    name: string;
    price: string;
    unit: string;
    blurb: string;
    features: string[];
    featured?: boolean;
  };
  const plans: Plan[] = [
    {
      name: 'Free',
      price: '$0',
      unit: 'forever',
      blurb: 'For solo work and trying Pitolet with your agent.',
      features: ['1 workspace', '3 documents', 'Hosted MCP for your agent'],
    },
    {
      name: 'Pro',
      price: '$12',
      unit: 'per user / mo',
      blurb: 'For teams building day to day with their agents.',
      features: [
        'Unlimited documents + tokens',
        'Version history',
        'Share links',
        'Everything in Free',
      ],
      featured: true,
    },
    {
      name: 'Self-host',
      price: 'Free',
      unit: 'forever · AGPL',
      blurb: 'Run it yourself. The core is open source.',
      features: ['npx pitolet', 'Runs on your own servers', 'AGPL-3.0 licensed'],
    },
  ];

  for (const plan of plans) {
    const card = attach(
      doc,
      grid.id,
      createElement({
        name: `Plan ${plan.name}`,
        tag: 'article',
        styles: {
          display: 'flex',
          flexDirection: 'column',
          gap: gap(sp('5'), px(0)),
          padding: padAll(sp('8')),
          fills: fill(plan.featured ? t('color.surface-2') : t('color.surface')),
          border: {
            width: px(1),
            style: 'solid',
            color: plan.featured ? t('color.primary') : t('color.border'),
          },
          radius: radAll(rad('lg')),
          width: 'fill',
        },
      }),
    );

    const head = attach(
      doc,
      card.id,
      createElement({
        name: 'Plan Head',
        styles: {
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'between',
        },
      }),
    );
    attach(
      doc,
      head.id,
      createText({
        name: 'Plan Name',
        tag: 'h3',
        text: plan.name,
        styles: { fontSize: fs('lg'), fontWeight: 650 },
      }),
    );
    if (plan.featured) {
      const badge = attach(
        doc,
        head.id,
        createElement({
          name: 'Badge',
          styles: {
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            padding: padXY(px(2), sp('2')),
            fills: fill(t('color.primary')),
            radius: radAll(rad('full')),
          },
        }),
      );
      attach(
        doc,
        badge.id,
        createText({
          name: 'Badge Text',
          tag: 'span',
          text: 'Popular',
          styles: {
            fontSize: fs('xs'),
            fontWeight: 700,
            letterSpacing: px(0.4),
            color: t('color.primary-foreground'),
          },
        }),
      );
    }

    // Price row
    const priceRow = attach(
      doc,
      card.id,
      createElement({
        name: 'Price Row',
        styles: {
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'baseline',
          gap: gap(px(0), sp('2')),
        },
      }),
    );
    attach(
      doc,
      priceRow.id,
      createText({
        name: 'Price',
        tag: 'span',
        text: plan.price,
        styles: { fontSize: fs('4xl'), fontWeight: 700, letterSpacing: px(-1) },
      }),
    );
    attach(
      doc,
      priceRow.id,
      createText({
        name: 'Price Unit',
        tag: 'span',
        text: plan.unit,
        styles: { fontSize: fs('sm'), color: t('color.subtle-foreground') },
      }),
    );

    attach(
      doc,
      card.id,
      createText({
        name: 'Plan Blurb',
        tag: 'p',
        text: plan.blurb,
        styles: { fontSize: fs('sm'), color: t('color.muted-foreground'), lineHeight: 1.55 },
      }),
    );

    const featureList = attach(
      doc,
      card.id,
      createElement({
        name: 'Features',
        tag: 'ul',
        styles: {
          display: 'flex',
          flexDirection: 'column',
          gap: gap(sp('2'), px(0)),
        },
      }),
    );
    for (const feature of plan.features) {
      const li = attach(
        doc,
        featureList.id,
        createElement({
          name: 'Feature',
          tag: 'li',
          styles: {
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'baseline',
            gap: gap(px(0), sp('2')),
          },
        }),
      );
      attach(
        doc,
        li.id,
        createText({
          name: 'Check',
          tag: 'span',
          text: '—',
          styles: { fontSize: fs('sm'), color: t('color.primary'), fontWeight: 700 },
        }),
      );
      attach(
        doc,
        li.id,
        createText({
          name: 'Feature Text',
          tag: 'span',
          text: feature,
          styles: { fontSize: fs('sm'), color: t('color.muted-foreground') },
        }),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Pitolet vs Figma page
// ---------------------------------------------------------------------------

function buildComparisonHero(doc: PitoletDocument, frameId: string) {
  const bandEl = band(doc, frameId, 'Comparison Hero Band', {
    padTop: sp('16'),
    padBottom: sp('16'),
    padTopLg: sp('24'),
    padBottomLg: sp('20'),
  });
  const hero = contentColumn(doc, bandEl.id, 'Comparison Hero', {
    alignItems: 'center',
    gap: gap(sp('6'), px(0)),
    maxWidth: px(920),
  });

  const eyebrow = attach(
    doc,
    hero.id,
    createText({
      name: 'Comparison Eyebrow',
      tag: 'p',
      text: 'Pitolet vs Figma · for web interface work',
      styles: {
        fontSize: fs('sm'),
        fontWeight: 600,
        color: t('color.primary'),
        fills: fill(t('color.surface')),
        border: { width: px(1), style: 'solid', color: t('color.border') },
        radius: radAll(rad('full')),
        padding: padXY(sp('2'), sp('4')),
      },
    }),
  );
  void eyebrow;

  const heading = attach(
    doc,
    hero.id,
    createText({
      name: 'Comparison Headline',
      tag: 'h1',
      text: 'A Figma alternative built for shipping web UI',
      styles: {
        fontSize: fs('5xl'),
        fontWeight: 700,
        letterSpacing: px(-1.7),
        lineHeight: 1.05,
        textAlign: 'center',
        maxWidth: px(880),
      },
    }),
  );
  heading.styles.breakpoints = {
    md: { fontSize: fs('6xl'), letterSpacing: px(-2) },
    lg: { fontSize: fs('7xl') },
  };

  attach(
    doc,
    hero.id,
    createText({
      name: 'Comparison Intro',
      tag: 'p',
      text:
        "Figma is a great general-purpose design tool. But web interfaces still have to cross from Figma's layout model into CSS. Pitolet starts in the browser instead: the canvas is real DOM and CSS, and the same document exports as production code.",
      styles: {
        fontSize: fs('xl'),
        color: t('color.muted-foreground'),
        textAlign: 'center',
        maxWidth: px(760),
        lineHeight: 1.55,
      },
    }),
  );

  const actions = attach(
    doc,
    hero.id,
    createElement({
      name: 'Comparison Actions',
      styles: {
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        flexWrap: 'wrap',
        gap: gap(sp('3'), sp('3')),
      },
    }),
  );
  const tryIt = attach(
    doc,
    actions.id,
    createText({
      name: 'Try Pitolet',
      tag: 'a',
      text: 'Try Pitolet free',
      styles: {
        fontSize: fs('base'),
        fontWeight: 650,
        color: t('color.primary-foreground'),
        fills: fill(t('color.primary')),
        padding: padXY(sp('3'), sp('6')),
        radius: radAll(rad('md')),
        cursor: 'pointer',
      },
    }),
  );
  tryIt.attrs = { href: 'https://app.pitolet.com' };
  tryIt.styles.states = { hover: { fills: fill(t('color.primary-strong')) } };

  const selfHost = attach(
    doc,
    actions.id,
    createText({
      name: 'Self-host',
      tag: 'a',
      text: 'Self-host with npx pitolet',
      styles: {
        fontSize: fs('base'),
        fontWeight: 600,
        color: t('color.foreground'),
        fills: fill(t('color.surface')),
        border: { width: px(1), style: 'solid', color: t('color.border-strong') },
        padding: padXY(sp('3'), sp('6')),
        radius: radAll(rad('md')),
        cursor: 'pointer',
      },
    }),
  );
  selfHost.attrs = { href: 'https://github.com/pitolet/pitolet#quickstart' };
  selfHost.styles.states = { hover: { fills: fill(t('color.surface-2')) } };
}

function comparisonCell(
  doc: PitoletDocument,
  parentId: string,
  product: 'Figma' | 'Pitolet',
  text: string,
) {
  const cell = attach(
    doc,
    parentId,
    createElement({
      name: `${product} Cell`,
      styles: {
        display: 'flex',
        flexDirection: 'column',
        gap: gap(sp('2'), px(0)),
        minWidth: px(0),
      },
    }),
  );
  const label = attach(
    doc,
    cell.id,
    createText({
      name: `${product} Mobile Label`,
      tag: 'span',
      text: product,
      styles: {
        fontSize: fs('xs'),
        fontWeight: 700,
        color: product === 'Pitolet' ? t('color.primary') : t('color.subtle-foreground'),
      },
    }),
  );
  label.styles.breakpoints = { md: { display: 'none' } };
  attach(
    doc,
    cell.id,
    createText({
      name: `${product} Value`,
      tag: 'p',
      text,
      styles: {
        fontSize: fs('base'),
        color: product === 'Pitolet' ? t('color.foreground') : t('color.muted-foreground'),
        lineHeight: 1.55,
      },
    }),
  );
}

function buildComparisonMatrix(doc: PitoletDocument, frameId: string) {
  const bandEl = band(doc, frameId, 'Comparison Matrix Band', {
    padTop: sp('12'),
    padBottom: sp('12'),
    padTopLg: sp('16'),
    padBottomLg: sp('16'),
    extra: { fills: fill(t('color.surface')) },
  });
  const col = contentColumn(doc, bandEl.id, 'Comparison Matrix', { gap: gap(sp('8'), px(0)) });

  attach(
    doc,
    col.id,
    createText({
      name: 'Matrix Heading',
      tag: 'h2',
      text: 'Different foundations, different output',
      styles: {
        fontSize: fs('4xl'),
        fontWeight: 650,
        letterSpacing: px(-1),
        textAlign: 'center',
        alignSelf: 'center',
      },
    }),
  );

  const table = attach(
    doc,
    col.id,
    createElement({
      name: 'Comparison Table',
      styles: { display: 'flex', flexDirection: 'column', gap: gap(sp('3'), px(0)), width: 'fill' },
    }),
  );

  const header = attach(
    doc,
    table.id,
    createElement({
      name: 'Comparison Header',
      styles: {
        display: 'none',
        gridTemplateColumns: [
          { kind: 'px', value: 190 },
          { kind: 'fr', value: 1 },
          { kind: 'fr', value: 1 },
        ],
        gap: gap(px(0), sp('6')),
        padding: padXY(sp('2'), sp('6')),
      },
    }),
  );
  header.styles.breakpoints = { md: { display: 'grid' } };
  for (const label of ['', 'Figma', 'Pitolet']) {
    attach(
      doc,
      header.id,
      createText({
        name: label || 'Capability Header',
        tag: 'span',
        text: label || 'Capability',
        styles: {
          fontSize: fs('sm'),
          fontWeight: 700,
          color: label === 'Pitolet' ? t('color.primary') : t('color.subtle-foreground'),
        },
      }),
    );
  }

  const rows: Array<[string, string, string]> = [
    [
      'Layout',
      "Auto layout, grid, and constraints in Figma's own rendering model.",
      "Real flexbox and grid rendered by the browser's layout engine.",
    ],
    [
      'Responsive design',
      'Frames, variants, and responsive prototypes that remain design-layer constructs.',
      'One frame with cascading breakpoint overrides that emit real media queries.',
    ],
    [
      'Interaction states',
      'Prototype interactions and component variants.',
      'Real :hover, :focus, and :active layers that export as CSS.',
    ],
    [
      'Code path',
      'Dev Mode context, Code Connect, plugins, and agents translate the design model into code.',
      'Deterministic React + Tailwind or HTML + CSS from the same style-resolution pipeline as the canvas.',
    ],
    [
      'File format',
      'Cloud-hosted proprietary design files.',
      'Readable JSON in your git repository, with normal diffs and history.',
    ],
    [
      'Coding agents',
      'Remote MCP can read and write Figma content; write access is beta and depends on client and seat.',
      'Read/write MCP is built into the editor. Changes appear live, pass validation, and are undoable.',
    ],
    [
      'Design tokens',
      'Variables and styles, with code workflows through Dev Mode, APIs, and integrations.',
      'Tokens emit as Tailwind @theme variables and agents can update them on the open canvas.',
    ],
    [
      'Hosting and price',
      'Free starter; paid full design seats currently range from $16 to $90 per month.',
      'Free hosted tier, Pro at $12 per seat, or self-host the AGPL core for free.',
    ],
  ];

  for (const [capability, figma, pitolet] of rows) {
    const row = attach(
      doc,
      table.id,
      createElement({
        name: `${capability} Row`,
        tag: 'article',
        styles: {
          display: 'grid',
          gridTemplateColumns: [{ kind: 'fr', value: 1 }],
          gap: gap(sp('5'), sp('6')),
          width: 'fill',
          padding: padAll(sp('6')),
          fills: fill(t('color.background')),
          border: { width: px(1), style: 'solid', color: t('color.border') },
          radius: radAll(rad('lg')),
        },
      }),
    );
    row.styles.breakpoints = {
      md: {
        gridTemplateColumns: [
          { kind: 'px', value: 190 },
          { kind: 'fr', value: 1 },
          { kind: 'fr', value: 1 },
        ],
      },
    };
    attach(
      doc,
      row.id,
      createText({
        name: 'Capability',
        tag: 'h3',
        text: capability,
        styles: { fontSize: fs('base'), fontWeight: 650, color: t('color.foreground') },
      }),
    );
    comparisonCell(doc, row.id, 'Figma', figma);
    comparisonCell(doc, row.id, 'Pitolet', pitolet);
  }

  const sourceNote = attach(
    doc,
    col.id,
    createText({
      name: 'Comparison Sources',
      tag: 'p',
      content: [
        { text: 'Figma capabilities and USD pricing checked July 2026. Sources: ' },
        { text: 'Figma pricing', marks: { link: 'https://www.figma.com/pricing/' } },
        { text: ' and ' },
        {
          text: 'Figma MCP documentation',
          marks: { link: 'https://developers.figma.com/docs/figma-mcp-server/' },
        },
        { text: '.' },
      ],
      styles: {
        fontSize: fs('xs'),
        color: t('color.subtle-foreground'),
        textAlign: 'center',
        alignSelf: 'center',
      },
    }),
  );
  void sourceNote;
}

function buildFigmaWins(doc: PitoletDocument, frameId: string) {
  const bandEl = band(doc, frameId, 'Figma Wins Band', {
    padTop: sp('12'),
    padBottom: sp('12'),
    padTopLg: sp('16'),
    padBottomLg: sp('16'),
  });
  const card = contentColumn(doc, bandEl.id, 'Figma Wins', {
    gap: gap(sp('4'), px(0)),
    maxWidth: px(900),
    padding: padAll(sp('8')),
    fills: fill(t('color.surface')),
    border: { width: px(1), style: 'solid', color: t('color.border') },
    radius: radAll(rad('lg')),
  });
  attach(
    doc,
    card.id,
    createText({
      name: 'Figma Wins Heading',
      tag: 'h2',
      text: 'When Figma is still the better tool',
      styles: { fontSize: fs('3xl'), fontWeight: 650, letterSpacing: px(-0.7) },
    }),
  );
  attach(
    doc,
    card.id,
    createText({
      name: 'Figma Wins Body',
      tag: 'p',
      text:
        'Choose Figma for brand and illustration work, advanced vector editing, rich prototyping, mature multiplayer across large organizations, or its enormous plugin ecosystem. Pitolet is narrower by design: it is for the part of the job where the deliverable is a working web interface.',
      styles: { fontSize: fs('lg'), color: t('color.muted-foreground'), lineHeight: 1.65 },
    }),
  );
}

function buildTeamUseCases(doc: PitoletDocument, frameId: string) {
  const bandEl = band(doc, frameId, 'Use Cases Band', {
    padTop: sp('12'),
    padBottom: sp('12'),
    padTopLg: sp('16'),
    padBottomLg: sp('16'),
  });
  const col = contentColumn(doc, bandEl.id, 'Use Cases', { gap: gap(sp('8'), px(0)) });
  attach(
    doc,
    col.id,
    createText({
      name: 'Use Cases Heading',
      tag: 'h2',
      text: 'How teams use Pitolet',
      styles: {
        fontSize: fs('4xl'),
        fontWeight: 650,
        letterSpacing: px(-1),
        textAlign: 'center',
      },
    }),
  );
  const cards = attach(
    doc,
    col.id,
    createElement({
      name: 'Use Case Cards',
      styles: {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'stretch',
        gap: gap(sp('5'), sp('5')),
        width: 'fill',
      },
    }),
  );
  cards.styles.breakpoints = { md: { flexDirection: 'row' } };
  const cases: Array<[string, string]> = [
    [
      'Design engineers',
      'Design with the same stacks, tokens, and breakpoints you ship. Export is a component, not a visual reference to rebuild.',
    ],
    [
      'AI-assisted teams',
      'Let Claude Code or Codex make the first pass, then review every live, undoable change on the canvas.',
    ],
    [
      'Design in code review',
      'Keep the readable design document beside the code, and use drift checks to flag when either side changes.',
    ],
  ];
  for (const [title, body] of cases) {
    const card = attach(
      doc,
      cards.id,
      createElement({
        name: title,
        tag: 'article',
        styles: {
          display: 'flex',
          flexDirection: 'column',
          gap: gap(sp('3'), px(0)),
          width: 'fill',
          padding: padAll(sp('6')),
          fills: fill(t('color.surface')),
          border: { width: px(1), style: 'solid', color: t('color.border') },
          radius: radAll(rad('lg')),
        },
      }),
    );
    attach(
      doc,
      card.id,
      createText({
        name: 'Use Case Title',
        tag: 'h3',
        text: title,
        styles: { fontSize: fs('xl'), fontWeight: 650 },
      }),
    );
    attach(
      doc,
      card.id,
      createText({
        name: 'Use Case Body',
        tag: 'p',
        text: body,
        styles: { fontSize: fs('base'), color: t('color.muted-foreground'), lineHeight: 1.6 },
      }),
    );
  }
}

function buildComparisonCta(doc: PitoletDocument, frameId: string) {
  const bandEl = band(doc, frameId, 'Comparison CTA Band', {
    padTop: sp('12'),
    padBottom: sp('16'),
    padTopLg: sp('16'),
    padBottomLg: sp('20'),
  });
  const card = contentColumn(doc, bandEl.id, 'Comparison CTA', {
    alignItems: 'center',
    gap: gap(sp('5'), px(0)),
    maxWidth: px(900),
    padding: padAll(sp('10')),
    fills: [
      {
        type: 'radial',
        stops: [
          { color: oklch(0.27, 0.055, 215), position: 0 },
          { color: oklch(0.165, 0.008, 250), position: 1 },
        ],
      },
    ],
    border: { width: px(1), style: 'solid', color: t('color.border-strong') },
    radius: radAll(rad('lg')),
  });
  attach(
    doc,
    card.id,
    createText({
      name: 'CTA Heading',
      tag: 'h2',
      text: 'Try the browser-native path',
      styles: {
        fontSize: fs('4xl'),
        fontWeight: 700,
        letterSpacing: px(-1),
        textAlign: 'center',
      },
    }),
  );
  attach(
    doc,
    card.id,
    createText({
      name: 'CTA Body',
      tag: 'p',
      text:
        'Start free in the hosted app, or run npx pitolet locally. This comparison page is itself a Pitolet document exported by Pitolet’s code generator.',
      styles: {
        fontSize: fs('lg'),
        color: t('color.muted-foreground'),
        textAlign: 'center',
        lineHeight: 1.6,
        maxWidth: px(680),
      },
    }),
  );
  const action = attach(
    doc,
    card.id,
    createText({
      name: 'CTA Action',
      tag: 'a',
      text: 'Start free →',
      styles: {
        fontSize: fs('base'),
        fontWeight: 650,
        color: t('color.primary-foreground'),
        fills: fill(t('color.primary')),
        padding: padXY(sp('3'), sp('6')),
        radius: radAll(rad('md')),
        cursor: 'pointer',
      },
    }),
  );
  action.attrs = { href: 'https://app.pitolet.com' };
  action.styles.states = { hover: { fills: fill(t('color.primary-strong')) } };
}

// ---------------------------------------------------------------------------
// Footer
// ---------------------------------------------------------------------------

function buildFooter(doc: PitoletDocument, frameId: string) {
  const bandEl = band(doc, frameId, 'Footer Band', {
    padTop: sp('8'),
    padBottom: sp('8'),
    padTopLg: sp('8'),
    padBottomLg: sp('8'),
    extra: {
      border: { width: px(1), style: 'solid', color: t('color.border'), sides: { top: true } },
    },
  });
  const footer = attach(
    doc,
    bandEl.id,
    createElement({
      name: 'Footer',
      tag: 'footer',
      styles: {
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'between',
        flexWrap: 'wrap',
        gap: gap(sp('3'), sp('4')),
        width: 'fill',
        maxWidth: px(1120),
      },
    }),
  );

  attach(
    doc,
    footer.id,
    createText({
      name: 'Copyright',
      tag: 'p',
      text: '© 2026 Pitolet · AGPL-3.0 core',
      styles: { fontSize: fs('sm'), color: t('color.subtle-foreground') },
    }),
  );

  const links = attach(
    doc,
    footer.id,
    createElement({
      name: 'Footer Links',
      styles: {
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: gap(px(0), sp('5')),
      },
    }),
  );
  const footerLinks: Array<[string, string]> = [
    ['Terms', '/terms.html'],
    ['Privacy', '/privacy.html'],
    ['GitHub', 'https://github.com/pitolet/pitolet'],
  ];
  for (const [label, href] of footerLinks) {
    const a = attach(
      doc,
      links.id,
      createText({
        name: label,
        tag: 'a',
        text: label,
        styles: { fontSize: fs('sm'), color: t('color.muted-foreground') },
      }),
    );
    a.attrs = { href };
    a.styles.states = { hover: { color: t('color.foreground') } };
  }
}

// ---------------------------------------------------------------------------
// Head wrapping — inject <head> into the codegen's standalone HTML
// ---------------------------------------------------------------------------

type PageMeta = { title: string; description: string; url: string };

const LANDING_META: PageMeta = {
  title: 'Pitolet — design tools for you and your coding agent',
  description:
    'Pitolet is a web-native design tool for you and your coding agent. Everything you draw is live DOM and CSS, ready to ship as code.',
  url: 'https://pitolet.com',
};

const COMPARISON_META: PageMeta = {
  title: 'Pitolet vs Figma — a Figma alternative for developers',
  description:
    'Compare Pitolet and Figma for web interface work: real browser layout, code export, git-native files, agent workflows, self-hosting, and pricing.',
  url: 'https://pitolet.com/vs-figma/',
};

function faviconDataUri(): string {
  // Ridgeline on the accent, rounded dark tile — matches the BrandMark.
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">` +
    `<rect width="32" height="32" rx="7" fill="oklch(0.165 0.008 250)"/>` +
    `<path d="M5 22 L11 8 L15 15 L18 10 L27 22" fill="none" stroke="${ACCENT_CSS}" ` +
    `stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/**
 * buildPreviewHtml gives a full standalone <!doctype html> document with the
 * generated CSS inlined. We swap its minimal <head> for a production one
 * (title, meta, OG, favicon, dark color-scheme, font smoothing) while keeping
 * the codegen's reset + generated stylesheet + generated <body> untouched.
 */
function wrapForProduction(previewHtml: string, meta: PageMeta): string {
  const headStart = previewHtml.indexOf('<head>');
  const headEnd = previewHtml.indexOf('</head>');
  const bodyStart = previewHtml.indexOf('<body>');
  const bodyEnd = previewHtml.lastIndexOf('</body>');
  if (headStart < 0 || headEnd < 0 || bodyStart < 0 || bodyEnd < 0) {
    throw new Error('Unexpected buildPreviewHtml shape');
  }
  // Extract the generated <style>…</style> block that codegen put in <head>.
  const headInner = previewHtml.slice(headStart + '<head>'.length, headEnd);
  const styleBlock = headInner.slice(headInner.indexOf('<style>'));
  const body = previewHtml.slice(bodyStart + '<body>'.length, bodyEnd).trim();

  const favicon = faviconDataUri();

  const head = `
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="dark" />
  <title>${meta.title}</title>
  <meta name="description" content="${escapeAttr(meta.description)}" />
  <link rel="icon" href="${favicon}" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="Pitolet" />
  <meta property="og:title" content="${escapeAttr(meta.title)}" />
  <meta property="og:description" content="${escapeAttr(meta.description)}" />
  <meta property="og:url" content="${meta.url}" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${escapeAttr(meta.title)}" />
  <meta name="twitter:description" content="${escapeAttr(meta.description)}" />
  ${styleBlock}
  <style>
    /* Production polish on top of the deterministic codegen output. */
    html { -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; scroll-behavior: smooth; }
    body { background: oklch(0.13 0.006 250); }
    ::selection { background: oklch(0.71 0.125 215 / 0.3); }
  </style>`;

  return `<!doctype html>
<html lang="en">
<head>${head}
</head>
<body>
${body}
</body>
</html>
`;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Rewrite every node id to a stable, content-independent label derived from a
 * depth-first walk of the tree. The factories mint random nanoids, which would
 * make each build produce a different file; this makes the build DETERMINISTIC
 * (re-running produces byte-identical output) without touching the schema.
 */
function relabelDeterministic(doc: PitoletDocument, frameId: string): string {
  const idMap = new Map<string, string>();
  let counter = 0;
  const walk = (id: string) => {
    idMap.set(id, `n${counter++}`);
    const node = doc.nodes[id];
    if (node) for (const child of node.children) walk(child);
  };
  for (const rootId of doc.rootOrder) walk(rootId);

  const remap = (id: string) => idMap.get(id) ?? id;
  const newNodes: PitoletDocument['nodes'] = {};
  for (const [oldId, node] of Object.entries(doc.nodes)) {
    node.id = remap(oldId);
    node.parent = node.parent === null ? null : remap(node.parent);
    node.children = node.children.map(remap);
    newNodes[node.id] = node;
  }
  doc.nodes = newNodes;
  doc.rootOrder = doc.rootOrder.map(remap);
  return remap(frameId);
}

function emitPage(opts: {
  built: { doc: PitoletDocument; frameId: string };
  docPath: string;
  outPath: string;
  meta: PageMeta;
  checks: Array<[string, (page: string) => boolean]>;
}) {
  const built = opts.built;
  const doc = built.doc;
  const frameId = relabelDeterministic(doc, built.frameId);

  // Round-trip: the document must be a valid Pitolet document.
  const roundTripped = validateDocument(JSON.parse(JSON.stringify(doc)));
  const problems = structuralProblems(roundTripped);
  if (problems.length > 0) {
    throw new Error('Document has structural problems:\n' + problems.join('\n'));
  }

  // (a) write the source document
  const docPath = resolve(repoRoot, opts.docPath);
  mkdirSync(dirname(docPath), { recursive: true });
  writeFileSync(docPath, JSON.stringify(doc, null, 2) + '\n');

  // (b) generate the static page via Pitolet's own codegen
  const previewHtml = buildPreviewHtml(doc, frameId);
  const page = wrapForProduction(previewHtml, opts.meta);
  const outPath = resolve(repoRoot, opts.outPath);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, page);

  // Sanity assertions on the emitted output.
  const commonChecks: Array<[string, boolean]> = [
    ['contains @media rules', page.includes('@media (min-width: 768px)')],
    ['no /assets-store refs', !page.includes('/assets-store')],
    ['no app-relative asset urls', !page.includes('src="assets/')],
    ['favicon inlined', page.includes('rel="icon"')],
  ];
  const checks = [
    ...commonChecks,
    ...opts.checks.map(([name, check]) => [name, check(page)] as [string, boolean]),
  ];
  const failed = checks.filter(([, ok]) => !ok);

  console.log(`✓ wrote ${docPath}`);
  console.log(`✓ wrote ${outPath}`);
  console.log(`  nodes: ${Object.keys(doc.nodes).length}, frame: ${frameId}`);
  for (const [name, ok] of checks) console.log(`  ${ok ? '✓' : '✗'} ${name}`);
  if (failed.length > 0) {
    throw new Error('Output checks failed: ' + failed.map(([n]) => n).join(', '));
  }
}

function main() {
  emitPage({
    built: buildDoc(),
    docPath: 'site/landing.pitolet.json',
    outPath: 'deploy/static/index.html',
    meta: LANDING_META,
    checks: [
      ['contains headline', (page) => page.includes('and your coding agent.')],
      ['contains npx chip', (page) => page.includes('npx pitolet')],
      ['links comparison page', (page) => page.includes('href="/vs-figma/"')],
    ],
  });

  emitPage({
    built: buildComparisonDoc(),
    docPath: 'site/vs-figma.pitolet.json',
    outPath: 'deploy/static/vs-figma/index.html',
    meta: COMPARISON_META,
    checks: [
      ['contains comparison headline', (page) => page.includes('alternative built for shipping web UI')],
      ['contains honest Figma section', (page) => page.includes('When Figma is still the better tool')],
      ['contains source links', (page) => page.includes('developers.figma.com/docs/figma-mcp-server')],
    ],
  });
}

main();
