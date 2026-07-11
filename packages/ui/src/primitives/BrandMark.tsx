import type { SVGProps } from 'react';

export interface BrandMarkProps extends SVGProps<SVGSVGElement> {
  /** Icon size in pixels (width and height). */
  size?: number;
}

/**
 * Pitolet brand mark: an open twin-peak ridgeline stroke. Inherits `currentColor`
 * so callers can tint it via `color`.
 */
export function BrandMark({ size = 20, ...props }: BrandMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M3 18 L9.5 6 L13.5 13 L16.5 8.5 L21 18" />
    </svg>
  );
}
