export interface HsvColor {
  /** Hue in degrees. */
  h: number;
  /** Saturation from 0 to 1. */
  s: number;
  /** Value from 0 to 1. */
  v: number;
}

export function hexToHsv(hex: string): HsvColor {
  const normalized = hex.replace('#', '').slice(0, 6).padEnd(6, '0');
  const red = Number.parseInt(normalized.slice(0, 2), 16) / 255;
  const green = Number.parseInt(normalized.slice(2, 4), 16) / 255;
  const blue = Number.parseInt(normalized.slice(4, 6), 16) / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;

  let hue = 0;
  if (delta > 0) {
    if (max === red) hue = 60 * (((green - blue) / delta) % 6);
    else if (max === green) hue = 60 * ((blue - red) / delta + 2);
    else hue = 60 * ((red - green) / delta + 4);
  }
  if (hue < 0) hue += 360;

  return {
    h: hue,
    s: max === 0 ? 0 : delta / max,
    v: max,
  };
}

export function hsvToHex({ h, s, v }: HsvColor): string {
  const hue = ((h % 360) + 360) % 360;
  const saturation = clamp(s);
  const value = clamp(v);
  const chroma = value * saturation;
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const match = value - chroma;

  const [red, green, blue] =
    hue < 60
      ? [chroma, x, 0]
      : hue < 120
        ? [x, chroma, 0]
        : hue < 180
          ? [0, chroma, x]
          : hue < 240
            ? [0, x, chroma]
            : hue < 300
              ? [x, 0, chroma]
              : [chroma, 0, x];

  return `#${[red, green, blue]
    .map((channel) =>
      Math.round((channel + match) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}
