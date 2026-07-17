import { describe, expect, it } from 'vitest';
import { previewWidthOptions, resolvePreviewAssetUrls } from '../src/preview/previewUtils.js';

describe('preview assets', () => {
  it('resolves content-addressed export paths through the running server', () => {
    const html = [
      '<img src="assets/logo.svg">',
      '<img src="assets/screenshot.png">',
      '<img src="https://example.com/external.png">',
    ].join('');

    expect(
      resolvePreviewAssetUrls(
        html,
        ['logo.svg', 'screenshot.png'],
        (id) => `/w/design/assets-store/${id}?share=guest-token`,
      ),
    ).toBe(
      [
        '<img src="/w/design/assets-store/logo.svg?share=guest-token">',
        '<img src="/w/design/assets-store/screenshot.png?share=guest-token">',
        '<img src="https://example.com/external.png">',
      ].join(''),
    );
  });

  it('includes the document’s real breakpoint widths', () => {
    expect(previewWidthOptions([{ minWidth: 640 }, { minWidth: 1440 }])).toEqual([
      { label: 'Fill', value: 0 },
      { label: '375', value: 375 },
      { label: '640', value: 640 },
      { label: '768', value: 768 },
      { label: '1024', value: 1024 },
      { label: '1280', value: 1280 },
      { label: '1440', value: 1440 },
    ]);
  });
});
