import type { PitoletDocument, NodeId } from '@pitolet/schema';
import { nodeToHtml } from './html.js';

/**
 * A self-contained HTML document for one frame, rendered from GENERATED code
 * — hover states are real :hover rules, breakpoints are real media queries.
 * Used by the editor's Preview mode (iframe srcdoc) and by headless
 * screenshots (Playwright page.setContent).
 */
export function buildPreviewHtml(doc: PitoletDocument, frameId: NodeId): string {
  const { html, css } = nodeToHtml(doc, frameId);
  return `<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; border: 0 solid; font: inherit; color: inherit; }
html, body { min-height: 100%; }
body { font-family: system-ui, sans-serif; font-size: 16px; line-height: 1.5; color: oklch(0.21 0.02 250); background: white; }
ul, ol { list-style: none; }
img, video, svg { display: block; max-width: 100%; }
a { text-decoration: inherit; }
button, input, select, textarea { background: transparent; appearance: none; }
${css}
</style>
</head>
<body>
${html}
</body>
</html>`;
}
