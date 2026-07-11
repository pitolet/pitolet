import type { ClientMessage, ServerMessage } from '@pitolet/schema';
import { toJpeg } from 'html-to-image';

/**
 * Answers server request-screenshot messages (MCP get_screenshot) by
 * rasterizing the frame's live DOM.
 */
export async function respondToScreenshotRequest(
  message: Extract<ServerMessage, { t: 'request-screenshot' }>,
  send: (reply: ClientMessage) => void,
): Promise<void> {
  try {
    const el = document.querySelector<HTMLElement>(`[data-node-id="${message.frameId}"]`);
    if (!el) throw new Error(`frame ${message.frameId} is not rendered`);
    const rect = el.getBoundingClientRect();
    const largest = Math.max(rect.width, rect.height, 1);
    // rect is screen-space (zoom-scaled); html-to-image renders at layout
    // size, so compute the ratio against layout dimensions.
    const layoutWidth = el.offsetWidth || rect.width;
    const layoutHeight = el.offsetHeight || rect.height;
    const layoutLargest = Math.max(layoutWidth, layoutHeight, 1);
    void largest;
    const pixelRatio = Math.min(1, message.maxSize / layoutLargest);

    const dataUrl = await toJpeg(el, {
      quality: 0.85,
      pixelRatio,
      backgroundColor: '#ffffff',
      skipFonts: true,
    });
    send({ t: 'screenshot-result', reqId: message.reqId, dataUrl });
  } catch (err) {
    send({
      t: 'screenshot-result',
      reqId: message.reqId,
      error: err instanceof Error ? err.message : 'screenshot failed',
    });
  }
}
