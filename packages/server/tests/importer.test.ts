import { structuralProblems } from '@pitolet/schema';
import { describe, expect, it, vi } from 'vitest';
import { decodeDataUrl, extractMediaMinWidths, launchChromium } from '../src/importer/capture.js';
import { runImportCommand } from '../src/importer/command.js';
import {
  createImportResourcePolicy,
  isPublicNetworkAddress,
} from '../src/importer/networkPolicy.js';
import {
  assetIdFor,
  capturedStylesToDecl,
  convertCapture,
  inferConstrainedFillAlignment,
  shouldFillAvailableWidth,
} from '../src/importer/convert.js';
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
    backgroundImage: 'none',
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
    breakpointWidths: [768, 1440],
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
      { id: 'import-768', name: 'Tablet', minWidth: 768 },
      { id: 'import-1440', name: 'Wide', minWidth: 1440 },
    ]);
    expect(structuralProblems(result.document)).toEqual([]);

    const card = Object.values(result.document.nodes).find(
      (entry) => entry.name === 'Pricing card',
    )!;
    expect(card.styles.base.display).toBe('flex');
    expect(card.styles.breakpoints?.['import-768']?.flexDirection).toBe('row');
    expect(card.styles.breakpoints?.['import-1440']?.display).toBe('grid');
    expect(card.styles.breakpoints?.['import-1440']?.padding?.left).toEqual({
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
    expect(desktopOnly.styles.breakpoints?.['import-1440']?.display).toBe('block');
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

  it('preserves reverse flex layout, normal line height, and supported border sides', () => {
    const result = capturedStylesToDecl(
      styles({
        display: 'flex',
        flexDirection: 'row-reverse',
        flexWrap: 'wrap-reverse',
        lineHeight: 'normal',
        borderTopWidth: '0px',
        borderRightWidth: '2px',
        borderRightStyle: 'solid',
        borderRightColor: 'rgb(255, 0, 0)',
        borderBottomWidth: '0px',
        borderLeftWidth: '2px',
        borderLeftStyle: 'solid',
        borderLeftColor: 'rgb(255, 0, 0)',
      }),
      { x: 0, y: 0, width: 200, height: 40 },
      'div',
    );
    expect(result.flexDirection).toBe('row-reverse');
    expect(result.flexWrap).toBe('wrap-reverse');
    expect(result.lineHeight).toBe(1.2);
    expect(result.border).toMatchObject({
      width: { value: 2, unit: 'px' },
      sides: { top: false, right: true, bottom: false, left: true },
    });
  });

  it('keeps common CSS gradients editable instead of flattening their subtree', () => {
    const linear = capturedStylesToDecl(
      styles({
        backgroundColor: 'rgba(0, 0, 0, 0)',
        backgroundImage:
          'linear-gradient(180deg, oklch(0.15 0.022 225) 0%, oklch(0.125 0.007 250) 48%, oklch(0.145 0.017 230) 100%)',
      }),
      { x: 0, y: 0, width: 1440, height: 900 },
      'main',
    );
    expect(linear.fills).toHaveLength(1);
    expect(linear.fills?.[0]).toMatchObject({
      type: 'linear',
      angle: 180,
      stops: [{ position: 0 }, { position: 0.48 }, { position: 1 }],
    });

    const radial = capturedStylesToDecl(
      styles({
        backgroundImage: 'radial-gradient(circle, rgb(40, 50, 60) 0%, rgb(15, 20, 25) 78%)',
      }),
      { x: 0, y: 0, width: 400, height: 300 },
      'section',
    );
    expect(radial.fills?.at(-1)).toMatchObject({
      type: 'radial',
      stops: [{ position: 0 }, { position: 0.78 }],
    });
  });

  it('preserves fill-width intent for centered and max-width content columns', () => {
    const parent = node('parent', 'section', null, ['child'], {
      rect: { x: 0, y: 0, width: 1440, height: 800 },
      styles: styles({
        display: 'flex',
        alignItems: 'center',
        paddingLeft: '40px',
        paddingRight: '40px',
      }),
    });
    const fullChild = node('child', 'div', 'parent', [], {
      rect: { x: 40, y: 0, width: 1360, height: 100 },
    });
    expect(shouldFillAvailableWidth(fullChild, parent)).toBe(true);

    const constrainedChild = node('child', 'div', 'parent', [], {
      rect: { x: 160, y: 0, width: 1120, height: 100 },
      styles: styles({ maxWidth: '1120px', alignSelf: 'stretch' }),
    });
    expect(shouldFillAvailableWidth(constrainedChild, parent)).toBe(true);
    expect(inferConstrainedFillAlignment(constrainedChild, parent)).toBe('center');

    const gridCard = node('card', 'article', 'parent', [], {
      rect: { x: 40, y: 0, width: 320, height: 100 },
    });
    expect(shouldFillAvailableWidth(gridCard, parent)).toBe(false);
  });

  it('writes inferred centering into imported max-width flex children', () => {
    const root = node('root', 'section', null, ['child'], {
      rect: { x: 0, y: 0, width: 1440, height: 800 },
      styles: styles({
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        paddingLeft: '40px',
        paddingRight: '40px',
      }),
    });
    const child = node('child', 'div', 'root', [], {
      name: 'Content wrapper',
      rect: { x: 160, y: 0, width: 1120, height: 100 },
      styles: styles({ maxWidth: '1120px', alignSelf: 'stretch' }),
    });
    const capture = fixture();
    capture.snapshots = [snapshot(1440, { root, child })];
    capture.assets = [];

    const result = convertCapture(capture);
    const imported = Object.values(result.document.nodes).find(
      (entry) => entry.name === 'Content wrapper',
    );

    expect(imported?.styles.base).toMatchObject({
      width: 'fill',
      maxWidth: { value: 1120, unit: 'px' },
      alignSelf: 'center',
    });
  });

  it('keeps responsive images fluid and preserves their aspect ratio', () => {
    const makeNodes = (width: number) => {
      const innerWidth = width - 32;
      return {
        root: node('root', 'main', null, ['hero-image'], {
          rect: { x: 0, y: 0, width, height: innerWidth / 1.6 },
          styles: styles({ paddingLeft: '16px', paddingRight: '16px' }),
        }),
        'hero-image': node('hero-image', 'img', 'root', [], {
          name: 'Hero image',
          assetUrl: 'http://localhost:3000/hero.png',
          rect: { x: 16, y: 0, width: innerWidth, height: innerWidth / 1.6 },
          styles: styles({
            display: 'block',
            width: `${innerWidth}px`,
            height: `${innerWidth / 1.6}px`,
          }),
        }),
      };
    };
    const capture = fixture();
    capture.snapshots = [375, 768, 1440].map((width) => snapshot(width, makeNodes(width)));
    capture.breakpointWidths = [768, 1440];
    capture.assets = [
      {
        key: 'url:http://localhost:3000/hero.png',
        fileName: 'hero.png',
        mime: 'image/png',
        width: 1408,
        height: 880,
        data: png,
      },
    ];

    const result = convertCapture(capture);
    const image = Object.values(result.document.nodes).find((entry) => entry.name === 'Hero image');
    expect(image?.type).toBe('image');
    expect(image?.styles.base.width).toBe('fill');
    expect(image?.styles.base.height).toBe('auto');
    expect(image?.styles.breakpoints).toBeUndefined();
  });

  it('preserves intrinsic controls and resets responsive properties that stop applying', () => {
    const mobileRoot = node('root', 'main', null, ['action', 'panel'], {
      rect: { x: 0, y: 0, width: 375, height: 600 },
      styles: styles({ display: 'flex', flexDirection: 'column', alignItems: 'center' }),
    });
    const mobileAction = node('action', 'a', 'root', [], {
      name: 'Action',
      text: 'Open',
      rect: { x: 110, y: 0, width: 155, height: 48 },
      styles: styles({ display: 'block', alignSelf: 'auto' }),
    });
    const mobilePanel = node('panel', 'section', 'root', [], {
      name: 'Responsive panel',
      rect: { x: 0, y: 80, width: 375, height: 200 },
      styles: styles({
        display: 'grid',
        gridTemplateColumns: '120px 255px',
        position: 'relative',
        boxShadow: 'rgb(0, 0, 0) 0px 8px 24px 0px',
        mixBlendMode: 'multiply',
      }),
    });

    const tabletRoot = structuredClone(mobileRoot);
    tabletRoot.rect.width = 768;
    const tabletAction = structuredClone(mobileAction);
    tabletAction.rect = { x: 306, y: 0, width: 156, height: 48 };
    const tabletPanel = structuredClone(mobilePanel);
    tabletPanel.rect = { x: 284, y: 80, width: 200, height: 200 };
    tabletPanel.styles = styles({
      display: 'grid',
      gridTemplateColumns: 'none',
      position: 'static',
      boxShadow: 'none',
      mixBlendMode: 'normal',
    });

    const capture = fixture();
    capture.snapshots = [
      snapshot(375, { root: mobileRoot, action: mobileAction, panel: mobilePanel }),
      snapshot(768, { root: tabletRoot, action: tabletAction, panel: tabletPanel }),
    ];
    capture.breakpointWidths = [768];
    capture.assets = [];

    const result = convertCapture(capture);
    const action = Object.values(result.document.nodes).find((entry) => entry.name === 'Action')!;
    expect(action.styles.base).toMatchObject({ width: 'auto', alignSelf: 'auto' });
    expect(action.styles.breakpoints?.['import-768']?.width).toBeUndefined();

    const panel = Object.values(result.document.nodes).find(
      (entry) => entry.name === 'Responsive panel',
    )!;
    expect(panel.styles.base).toMatchObject({
      width: 'fill',
      position: 'relative',
      blendMode: 'multiply',
    });
    expect(panel.styles.base.shadows).toHaveLength(1);
    expect(panel.styles.base.gridTemplateColumns).toHaveLength(2);
    expect(panel.styles.breakpoints?.['import-768']).toMatchObject({
      width: 'auto',
      position: 'static',
      blendMode: 'normal',
      shadows: [],
      gridTemplateColumns: [],
    });
  });

  it('extracts source breakpoint thresholds from modern and classic media queries', () => {
    expect(
      extractMediaMinWidths(
        ['(min-width: 640px)', '(48em <= width)', '(width >= 64rem)', '(max-width: 500px)'],
        16,
      ),
    ).toEqual([640, 768, 1024]);
  });

  it('decodes percent-encoded and base64 data images with metadata', () => {
    const svg = decodeDataUrl(
      'data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3C%2Fsvg%3E',
    );
    expect(svg?.mime).toBe('image/svg+xml');
    expect(svg?.data.toString()).toContain('<svg');

    const encoded = Buffer.from('image-bytes').toString('base64');
    expect(decodeDataUrl(`data:image/png;base64,${encoded}`)?.data.toString()).toBe('image-bytes');
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
    await expect(
      runImportCommand(['http://localhost:3000', '--to', 'http://192.0.2.10:4517']),
    ).rejects.toThrow('refusing plaintext import destination');
    await expect(
      runImportCommand(['http://localhost:3000', '--to', 'http://127.attacker.example:4517']),
    ).rejects.toThrow('refusing plaintext import destination');
    await expect(
      runImportCommand(['http://example.com', '--to', 'http://localhost:4517']),
    ).rejects.toThrow('refusing plaintext source');
    await expect(
      runImportCommand(['https://user:secret@example.com', '--to', 'http://localhost:4517']),
    ).rejects.toThrow('must not contain embedded credentials');
    await expect(
      runImportCommand([
        'http://localhost:3000',
        '--to',
        'https://app.pitolet.com/w/demo?token=secret',
      ]),
    ).rejects.toThrow('must not contain a query string or fragment');
    await expect(
      runImportCommand([
        'http://localhost:3000',
        '--to',
        'http://localhost:4517',
        '--to',
        'http://localhost:4518',
      ]),
    ).rejects.toThrow('duplicate import option --to');
  });
});

describe('capture network policy', () => {
  it('allows plaintext only for literal loopback source addresses', async () => {
    await expect(createImportResourcePolicy('http://127.0.0.1:3000')).resolves.toBeDefined();
    await expect(createImportResourcePolicy('http://[::1]:3000')).resolves.toBeDefined();
    await expect(createImportResourcePolicy('http://192.168.1.10:3000')).rejects.toThrow(
      'refusing plaintext source',
    );
    await expect(createImportResourcePolicy('http://8.8.8.8:3000')).rejects.toThrow(
      'refusing plaintext source',
    );
  });

  it('keeps local development local and blocks metadata/LAN pivots', async () => {
    const policy = await createImportResourcePolicy('http://localhost:3000');
    await expect(policy.assertAllowed('http://127.0.0.1:5173/app.js')).resolves.toBeUndefined();
    await expect(policy.assertAllowed('http://[::1]:5173/ws')).resolves.toBeUndefined();
    await expect(policy.assertAllowed('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(
      'blocked',
    );
    await expect(policy.assertAllowed('http://10.0.0.4/admin')).rejects.toThrow('blocked');
  });

  it('allows public HTTPS resources but never private addresses or implicit plaintext', async () => {
    const policy = await createImportResourcePolicy('https://8.8.8.8/page');
    await expect(policy.assertAllowed('https://1.1.1.1/image.png')).resolves.toBeUndefined();
    await expect(policy.assertAllowed('https://127.0.0.1/secret')).rejects.toThrow('blocked');
    await expect(policy.assertAllowed('https://[fc00::1]/secret')).rejects.toThrow('blocked');
    await expect(policy.assertAllowed('http://1.1.1.1/image.png')).rejects.toThrow('plaintext');
    await expect(policy.assertAllowed('file:///etc/passwd')).rejects.toThrow('blocked protocol');
    await expect(policy.assertAllowed('ftp://8.8.8.8/file')).rejects.toThrow('blocked protocol');

    const optedIn = await createImportResourcePolicy('http://8.8.8.8/page', {
      allowInsecureHttp: true,
    });
    await expect(optedIn.assertAllowed('http://1.1.1.1/image.png')).resolves.toBeUndefined();
    await expect(optedIn.assertAllowed('http://192.168.1.1/admin')).rejects.toThrow('blocked');
  });

  it('classifies non-routable, documentation, mapped, and public IPs conservatively', () => {
    expect(isPublicNetworkAddress('8.8.8.8')).toBe(true);
    expect(isPublicNetworkAddress('1.1.1.1')).toBe(true);
    expect(isPublicNetworkAddress('127.0.0.1')).toBe(false);
    expect(isPublicNetworkAddress('100.64.0.1')).toBe(false);
    expect(isPublicNetworkAddress('192.0.2.1')).toBe(false);
    expect(isPublicNetworkAddress('198.51.100.1')).toBe(false);
    expect(isPublicNetworkAddress('203.0.113.1')).toBe(false);
    expect(isPublicNetworkAddress('2001:4860:4860::8888')).toBe(true);
    expect(isPublicNetworkAddress('2001::1')).toBe(false);
    expect(isPublicNetworkAddress('2001:2::1')).toBe(false);
    expect(isPublicNetworkAddress('2001:20::1')).toBe(false);
    expect(isPublicNetworkAddress('2001:db8::1')).toBe(false);
    expect(isPublicNetworkAddress('2002:0808:0808::1')).toBe(false);
    expect(isPublicNetworkAddress('3ffe::1')).toBe(false);
    expect(isPublicNetworkAddress('::ffff:127.0.0.1')).toBe(false);
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
    for (const [options] of launch.mock.calls) {
      expect(options).toMatchObject({
        headless: true,
        args: expect.arrayContaining([
          '--disable-background-networking',
          '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
        ]),
      });
    }
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
