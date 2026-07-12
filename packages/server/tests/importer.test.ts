import { structuralProblems } from '@pitolet/schema';
import { describe, expect, it, vi } from 'vitest';
import { launchChromium } from '../src/importer/capture.js';
import { runImportCommand } from '../src/importer/command.js';
import { assetIdFor, capturedStylesToDecl, convertCapture } from '../src/importer/convert.js';
import type { CapturedNode, CaptureSnapshot, WebCapture } from '../src/importer/types.js';

const png = Buffer.from('fake-png-for-content-addressing');

function styles(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    display: 'block',
    flexDirection: 'column',
    flexWrap: 'nowrap',
    alignItems: 'normal',
    justifyContent: 'normal',
    rowGap: '0px',
    columnGap: '0px',
    gridTemplateColumns: 'none',
    gridTemplateRows: 'none',
    gridColumn: 'auto',
    gridRow: 'auto',
    alignSelf: 'auto',
    flexGrow: '0',
    paddingTop: '0px',
    paddingRight: '0px',
    paddingBottom: '0px',
    paddingLeft: '0px',
    marginTop: '0px',
    marginRight: '0px',
    marginBottom: '0px',
    marginLeft: '0px',
    position: 'static',
    zIndex: 'auto',
    fontFamily: 'Inter, sans-serif',
    fontSize: '16px',
    fontWeight: '400',
    lineHeight: '24px',
    letterSpacing: '0px',
    textAlign: 'start',
    color: 'rgb(20, 20, 20)',
    backgroundColor: 'rgba(0, 0, 0, 0)',
    borderTopWidth: '0px',
    borderTopStyle: 'none',
    borderTopColor: 'rgba(0, 0, 0, 0)',
    borderTopLeftRadius: '0px',
    borderTopRightRadius: '0px',
    borderBottomRightRadius: '0px',
    borderBottomLeftRadius: '0px',
    opacity: '1',
    overflow: 'visible',
    cursor: 'auto',
    objectFit: 'fill',
    ...overrides,
  };
}

function node(
  key: string,
  tag: string,
  parentKey: string | null,
  children: string[],
  overrides: Partial<CapturedNode> = {},
): CapturedNode {
  return {
    key,
    kind: 'element',
    tag,
    parentKey,
    children,
    text: '',
    name: tag,
    attrs: {},
    rect: { x: 0, y: 0, width: 320, height: 100 },
    styles: styles(),
    ...overrides,
  };
}

function snapshot(width: number, nodes: Record<string, CapturedNode>): CaptureSnapshot {
  return {
    width,
    height: 720,
    fullHeight: 900,
    rootKey: 'root',
    nodes,
    screenshot: Buffer.from('screenshot'),
  };
}

function fixture(): WebCapture {
  const mobile: Record<string, CapturedNode> = {
    root: node('root', 'body', null, ['card', 'canvas']),
    card: node('card', 'section', 'root', ['heading'], {
      name: 'Pricing card',
      styles: styles({ display: 'flex', flexDirection: 'column', rowGap: '12px' }),
    }),
    heading: node('heading', 'h2', 'card', ['heading::text:0'], {
      name: 'Title',
      text: 'Starter plan',
    }),
    'heading::text:0': {
      ...node('heading::text:0', '#text', 'heading', []),
      kind: 'text' as const,
      text: 'Starter plan',
    },
    canvas: node('canvas', 'canvas', 'root', [], {
      name: 'Chart',
      unsupportedReason: 'canvas',
      rect: { x: 0, y: 120, width: 320, height: 180 },
    }),
  };
  const tablet = structuredClone(mobile);
  tablet.card!.styles = styles({ display: 'flex', flexDirection: 'row', rowGap: '16px' });
  const desktop = structuredClone(tablet);
  desktop.card!.styles = styles({
    display: 'grid',
    gridTemplateColumns: '320px 640px',
    paddingLeft: '32px',
    paddingRight: '32px',
  });
  desktop.root!.children.push('desktop-only');
  desktop['desktop-only'] = node('desktop-only', 'aside', 'root', [], { name: 'Desktop only' });
  return {
    version: 1,
    captureId: 'imp_fixture',
    sourceUrl: 'http://localhost:3000',
    rootSelector: 'body',
    title: 'Fixture site',
    snapshots: [snapshot(375, mobile), snapshot(768, tablet), snapshot(1440, desktop)],
    cssVariables: { '--color-brand': '#6d28d9', '--spacing-gutter': '24px' },
    fonts: ['Inter, sans-serif'],
    assets: [
      {
        key: 'raster:canvas:1440',
        fileName: 'chart.png',
        mime: 'image/png',
        width: 320,
        height: 180,
        data: png,
      },
    ],
    warnings: [],
  };
}

describe('responsive website conversion', () => {
  it('creates one coherent frame with mobile base and responsive overrides', () => {
    const result = convertCapture(fixture());
    expect(result.document.rootOrder).toHaveLength(1);
    expect(result.document.breakpoints).toEqual([
      { id: 'import-tablet', name: 'Imported tablet', minWidth: 768 },
      { id: 'import-desktop', name: 'Imported desktop', minWidth: 1440 },
    ]);
    expect(structuralProblems(result.document)).toEqual([]);

    const card = Object.values(result.document.nodes).find(
      (entry) => entry.name === 'Pricing card',
    )!;
    expect(card.styles.base.display).toBe('flex');
    expect(card.styles.breakpoints?.['import-tablet']?.flexDirection).toBe('row');
    expect(card.styles.breakpoints?.['import-desktop']?.display).toBe('grid');
    expect(card.styles.breakpoints?.['import-desktop']?.padding?.left).toEqual({
      $token: 'spacing.8',
    });
  });

  it('imports tokens, raster fallbacks, and responsive-only nodes', () => {
    const capture = fixture();
    capture.snapshots[0]!.nodes.card!.unsupportedReason = 'CSS transform';
    capture.snapshots[1]!.nodes.card!.unsupportedReason = 'CSS transform';
    capture.snapshots[2]!.nodes.card!.unsupportedReason = 'CSS transform';
    capture.assets.push({
      key: 'raster:card:1440',
      fileName: 'card.png',
      mime: 'image/png',
      width: 320,
      height: 100,
      data: Buffer.from('card-raster'),
    });
    const result = convertCapture(capture);
    expect(result.document.tokens.color.brand).toBeDefined();
    expect(result.document.tokens.spacing.gutter?.$value).toEqual({ value: 24, unit: 'px' });
    expect(result.rasterizedRegions).toBe(2);
    expect(result.unsupportedCss).toEqual(['CSS transform']);
    expect(result.unmatchedResponsiveNodes).toBeGreaterThan(0);

    const chart = Object.values(result.document.nodes).find((entry) => entry.name === 'Chart')!;
    expect(chart.type).toBe('image');
    if (chart.type === 'image') expect(chart.src).toEqual({ asset: assetIdFor(png, 'image/png') });

    const desktopOnly = Object.values(result.document.nodes).find(
      (entry) => entry.name === 'Desktop only',
    )!;
    expect(desktopOnly.styles.base.display).toBe('none');
    expect(desktopOnly.styles.breakpoints?.['import-desktop']?.display).toBe('block');
  });

  it('maps common computed styles into structured Pitolet declarations', () => {
    const result = capturedStylesToDecl(
      styles({
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingTop: '8px',
        paddingRight: '12px',
        paddingBottom: '8px',
        paddingLeft: '12px',
        backgroundColor: 'rgb(255, 0, 0)',
      }),
      { x: 0, y: 0, width: 200, height: 40 },
      'button',
    );
    expect(result.display).toBe('flex');
    expect(result.justifyContent).toBe('between');
    expect(result.alignItems).toBe('center');
    expect(result.padding?.left).toEqual({ value: 12, unit: 'px' });
    expect(result.fills?.[0]?.type).toBe('solid');
  });
});

describe('import command validation', () => {
  it('requires a destination and rejects invalid viewports and command-line secrets', async () => {
    await expect(runImportCommand(['http://localhost:3000'])).rejects.toThrow('--to is required');
    await expect(
      runImportCommand([
        'http://localhost:3000',
        '--to',
        'http://localhost:4517',
        '--viewports',
        '100',
      ]),
    ).rejects.toThrow('--viewports');
    await expect(
      runImportCommand([
        'http://localhost:3000',
        '--to',
        'http://localhost:4517',
        '--token',
        'secret',
      ]),
    ).rejects.toThrow('unknown import option --token');
  });
});

describe('on-demand Chromium setup', () => {
  it('installs once after a missing-executable error and then relaunches', async () => {
    const browser = { close: vi.fn() };
    const launch = vi
      .fn()
      .mockRejectedValueOnce(new Error("Executable doesn't exist"))
      .mockResolvedValueOnce(browser);
    const install = vi.fn().mockResolvedValue(undefined);
    const onInstall = vi.fn();
    await expect(launchChromium({ launch } as never, onInstall, install)).resolves.toBe(browser);
    expect(onInstall).toHaveBeenCalledOnce();
    expect(install).toHaveBeenCalledOnce();
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it('surfaces browser download failures and does not mask unrelated launch errors', async () => {
    const missing = {
      launch: vi.fn().mockRejectedValue(new Error('browser not found; install it')),
    };
    await expect(
      launchChromium(missing as never, undefined, async () => {
        throw new Error('download unavailable');
      }),
    ).rejects.toThrow('download unavailable');

    const unrelated = { launch: vi.fn().mockRejectedValue(new Error('sandbox denied')) };
    const install = vi.fn();
    await expect(launchChromium(unrelated as never, undefined, install)).rejects.toThrow(
      'sandbox denied',
    );
    expect(install).not.toHaveBeenCalled();
  });
});
