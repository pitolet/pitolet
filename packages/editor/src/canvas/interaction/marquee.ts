export interface RectLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Left-to-right marquee selects only fully enclosed frames. Right-to-left is
 * a crossing marquee and selects anything it touches, matching established
 * canvas/CAD behavior while making accidental selections less common.
 */
export function marqueeContains(rect: RectLike, candidate: RectLike, crossing: boolean): boolean {
  if (crossing) {
    return (
      candidate.left < rect.right &&
      candidate.right > rect.left &&
      candidate.top < rect.bottom &&
      candidate.bottom > rect.top
    );
  }
  return (
    candidate.left >= rect.left &&
    candidate.right <= rect.right &&
    candidate.top >= rect.top &&
    candidate.bottom <= rect.bottom
  );
}
