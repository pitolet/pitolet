import { attach, createDocument, createElement, createFrame, createText, px } from './factory.js';
import type { PitoletDocument } from './document.js';

const t = (token: string) => ({ $token: token });
const sp = (name: string) => ({ $token: `spacing.${name}` });
const fs = (name: string) => ({ $token: `typography.fontSize.${name}` });

/**
 * The onboarding document new installs open with: a small landing page built
 * entirely from tokens, demonstrating frames, flex layout, text, and buttons.
 */
export function createSampleDocument(): PitoletDocument {
  const doc = createDocument({ name: 'Welcome' });

  const frame = attach(
    doc,
    null,
    createFrame({
      name: 'Landing',
      x: 120,
      y: 120,
      width: 1280,
      height: 800,
      styles: {
        alignItems: 'stretch',
        fontFamily: t('typography.fontFamily.sans'),
        color: t('color.foreground'),
      },
    }),
  );

  // --- Nav ---
  const nav = attach(
    doc,
    frame.id,
    createElement({
      name: 'Nav',
      tag: 'nav',
      styles: {
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'between',
        padding: { top: sp('4'), right: sp('12'), bottom: sp('4'), left: sp('12') },
      },
    }),
  );
  attach(
    doc,
    nav.id,
    createText({
      name: 'Logo',
      tag: 'span',
      text: 'northwind',
      styles: { fontSize: fs('lg'), fontWeight: 650, letterSpacing: px(-0.3) },
    }),
  );
  const navLinks = attach(
    doc,
    nav.id,
    createElement({
      name: 'Links',
      styles: {
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: { row: sp('2'), column: sp('6') },
      },
    }),
  );
  for (const label of ['Product', 'Pricing', 'Changelog']) {
    attach(
      doc,
      navLinks.id,
      createText({
        name: label,
        tag: 'a',
        text: label,
        styles: { fontSize: fs('sm'), color: t('color.muted-foreground') },
      }),
    );
  }

  // --- Hero ---
  const hero = attach(
    doc,
    frame.id,
    createElement({
      name: 'Hero',
      tag: 'section',
      styles: {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: { row: sp('6'), column: sp('6') },
        padding: { top: sp('24'), right: sp('12'), bottom: sp('24'), left: sp('12') },
      },
    }),
  );
  attach(
    doc,
    hero.id,
    createText({
      name: 'Headline',
      tag: 'h1',
      text: 'Design and code, one artifact.',
      styles: {
        fontSize: fs('6xl'),
        fontWeight: 700,
        letterSpacing: px(-1.5),
        textAlign: 'center',
        maxWidth: px(720),
      },
    }),
  );
  attach(
    doc,
    hero.id,
    createText({
      name: 'Subtitle',
      tag: 'p',
      text: 'Northwind turns your design system into production interfaces, so the mockup and the shipped build stay in sync.',
      styles: {
        fontSize: fs('xl'),
        color: t('color.muted-foreground'),
        textAlign: 'center',
        maxWidth: px(560),
        lineHeight: 1.5,
      },
    }),
  );
  const ctas = attach(
    doc,
    hero.id,
    createElement({
      name: 'Actions',
      styles: {
        display: 'flex',
        flexDirection: 'row',
        gap: { row: sp('3'), column: sp('3') },
        padding: { top: sp('2'), right: px(0), bottom: px(0), left: px(0) },
      },
    }),
  );
  attach(
    doc,
    ctas.id,
    createText({
      name: 'Primary CTA',
      tag: 'button',
      text: 'Get started',
      styles: {
        fontSize: fs('base'),
        fontWeight: 550,
        color: t('color.primary-foreground'),
        fills: [{ type: 'solid', color: t('color.primary') }],
        padding: { top: sp('3'), right: sp('6'), bottom: sp('3'), left: sp('6') },
        radius: { tl: t('radius.md'), tr: t('radius.md'), br: t('radius.md'), bl: t('radius.md') },
        cursor: 'pointer',
      },
    }),
  );
  attach(
    doc,
    ctas.id,
    createText({
      name: 'Secondary CTA',
      tag: 'button',
      text: 'View docs',
      styles: {
        fontSize: fs('base'),
        fontWeight: 550,
        color: t('color.foreground'),
        border: { width: px(1), style: 'solid', color: t('color.border') },
        padding: { top: sp('3'), right: sp('6'), bottom: sp('3'), left: sp('6') },
        radius: { tl: t('radius.md'), tr: t('radius.md'), br: t('radius.md'), bl: t('radius.md') },
        cursor: 'pointer',
      },
    }),
  );

  // --- Feature cards ---
  const features = attach(
    doc,
    frame.id,
    createElement({
      name: 'Features',
      tag: 'section',
      styles: {
        display: 'flex',
        flexDirection: 'row',
        gap: { row: sp('6'), column: sp('6') },
        padding: { top: px(0), right: sp('12'), bottom: sp('16'), left: sp('12') },
      },
    }),
  );
  const cards: Array<[string, string]> = [
    ['Design in the browser', 'Every element is real CSS, so what you see is what ships.'],
    ['Tokens first', 'Colors, spacing and type scale live in one place and flow everywhere.'],
    ['Agent native', 'Your coding agent reads and edits designs right on the canvas.'],
  ];
  for (const [title, body] of cards) {
    const card = attach(
      doc,
      features.id,
      createElement({
        name: title,
        tag: 'article',
        styles: {
          display: 'flex',
          flexDirection: 'column',
          gap: { row: sp('2'), column: sp('2') },
          padding: { top: sp('6'), right: sp('6'), bottom: sp('6'), left: sp('6') },
          fills: [{ type: 'solid', color: t('color.muted') }],
          radius: {
            tl: t('radius.lg'),
            tr: t('radius.lg'),
            br: t('radius.lg'),
            bl: t('radius.lg'),
          },
          width: 'fill',
        },
      }),
    );
    attach(
      doc,
      card.id,
      createText({
        name: 'Title',
        tag: 'h3',
        text: title,
        styles: { fontSize: fs('lg'), fontWeight: 600 },
      }),
    );
    attach(
      doc,
      card.id,
      createText({
        name: 'Body',
        tag: 'p',
        text: body,
        styles: { fontSize: fs('sm'), color: t('color.muted-foreground'), lineHeight: 1.6 },
      }),
    );
  }

  return doc;
}
