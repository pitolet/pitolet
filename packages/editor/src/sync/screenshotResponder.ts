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
  let restoreCulling: (() => void) | null = null;
  try {
    const wrapper = document.querySelector<HTMLElement>(
      `[data-frame-wrapper="${message.frameId}"]`,
    );
    if (wrapper?.style.display === 'none') {
      const previous = wrapper.style.display;
      wrapper.dataset.forceRender = 'true';
      wrapper.style.display = '';
      restoreCulling = () => {
        wrapper.style.display = previous;
        delete wrapper.dataset.forceRender;
      };
      // Let layout catch up before html-to-image reads computed dimensions.
      await nextAnimationFrame();
    }
    const el = document.querySelector<HTMLElement>(`[data-node-id="${message.frameId}"]`);
    if (!el) throw new Error(`frame ${message.frameId} is not rendered`);
    const rect = el.getBoundingClientRect();
    // rect is screen-space (zoom-scaled); html-to-image renders at layout
    // size, so compute the ratio against layout dimensions.
    const layoutWidth = el.offsetWidth || rect.width;
    const layoutHeight = el.offsetHeight || rect.height;
    const layoutLargest = Math.max(layoutWidth, layoutHeight, 1);
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
      error: screenshotError(err),
    });
  } finally {
    restoreCulling?.();
  }
}

function screenshotError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Screenshot failed';
  return message.slice(0, 1_000);
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}
