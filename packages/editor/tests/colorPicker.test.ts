import { describe, expect, it } from 'vitest';
import { hexToHsv, hsvToHex } from '../src/inspector/colorPicker.js';

describe('custom color picker conversions', () => {
  it('round-trips common RGB colors through HSV', () => {
    for (const hex of ['#ff0000', '#00ff00', '#0000ff', '#16bbbc', '#ffffff', '#000000']) {
      expect(hsvToHex(hexToHsv(hex))).toBe(hex);
    }
  });

  it('preserves hue and clamps saturation and value', () => {
    expect(hsvToHex({ h: 360, s: 1, v: 1 })).toBe('#ff0000');
    expect(hsvToHex({ h: -120, s: 2, v: 2 })).toBe('#0000ff');
    expect(hsvToHex({ h: 42, s: -1, v: 0.5 })).toBe('#808080');
  });
});
