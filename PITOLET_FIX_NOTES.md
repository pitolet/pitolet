# Pitolet fix notes

Implementation record for the importer, MCP, dashboard, and canvas reliability pass.

## 1. Codex MCP loader closes on Pitolet's large tool catalog

**Status:** Implemented and covered by MCP discovery-size tests

When Pitolet is connected to Codex over MCP, Codex reports that its native MCP loader closes while processing Pitolet's "unusually large tool catalog." Authentication, initialization, and `list_documents` still succeed, but the behavior makes setup look unreliable.

Investigate whether Pitolet exposes too many narrowly scoped tools during MCP initialization. Aim to reduce the initial catalog without removing capabilities, for example by consolidating closely related operations and/or exposing capability groups on demand. Confirm the actual Codex limit and reproduce the loader failure before choosing the design.

**Security note:** A write token was visible in the supplied screenshot. Revoke it and create a replacement; do not copy the token into this file.

## 2. MCP-connected agents do not discover the website import workflow

**Status:** Implemented in MCP instructions, dashboard prompts, and documentation

Pitolet already supports importing a website through the local CLI:

```bash
PITOLET_TOKEN=... pitolet import <url> --to <workspace-url>
```

The import is intentionally a local CLI operation rather than a server-side MCP tool because it needs a local Chromium browser and may need access to local development URLs. However, an agent connected through Pitolet MCP inspected the tool catalog, found only `import_design_system`, and incorrectly concluded that no full-page import workflow exists. It then proposed manually rebuilding the website.

Make the import workflow discoverable to MCP clients without pretending the cloud server can capture a local page. Consider a compact capability/help response or MCP instructions/resource that tells agents when and how to invoke the local CLI. The generated connection and import prompts should clearly distinguish website import from `import_design_system`, and should direct the agent to use the installed package through `npx pitolet import` when appropriate.

## 3. Agent connection panel has an awkward outline and stale status

**Status:** Implemented with stable foreground polling and restrained focus styling

The expanded Agent connection control shows a large bright cyan rectangular outline around the whole header. It does not fit the surrounding card styling and appears visually detached from the control it is meant to focus. Preserve an accessible keyboard focus state, but make it restrained, correctly inset, and consistent with other interactive cards.

The connection status also remains stale after the agent first uses MCP. The page continues showing the pre-connection state until the user performs a full browser refresh. Make the status update automatically after setup without flashing between states. Prefer a bounded, stable refresh strategy while the workspace is waiting for first use, then stop or reduce refreshes once connected. Also refresh relevant cached workspace/token data after actions that can affect connection state.

## 4. Recent documents do not update automatically

**Status:** Implemented through the workspace refresh coordinator

When an agent creates or updates a document through MCP, the workspace home's Recent documents section remains stale until the user refreshes the whole page. Refresh the document data automatically so new and recently changed documents appear without a browser reload.

Coordinate this with the connection-status refresh from item 3 rather than adding unrelated polling loops. The update should be stable, avoid flashing or resetting the page, preserve current interactions, and stop unnecessary background requests when the page is not visible.

## 5. Workspace header shows unnecessary owner and slug metadata

**Status:** Implemented; the workspace URL now lives in Settings

Remove the `Owner` badge and `/pitchdance-site` slug from the main workspace header. They add noise to the most prominent part of the page without helping with the usual workspace workflow.

Keep the workspace name as the header's focus. Move the slug to Workspace Settings, where it is relevant as the workspace URL or identifier. Show the current user's role quietly in People or workspace access details, especially when the role restricts available actions, instead of placing it beside every workspace title.

## 6. Website import can flatten the entire page into three screenshots

**Status:** Implemented with root safeguards, native layered gradients, and editability gates

The website importer encountered effects on the page root and rasterized the entire page once at each captured viewport. The resulting document contains three responsive image layers rather than an editable page. This defeats the main purpose of importing into Pitolet and violates the intended rule that unsupported regions may be rasterized but the whole page must never be flattened.

Change fallback isolation so an unsupported style or effect rasterizes only the smallest necessary visual region. Root-level backgrounds, gradients, background images, pseudo-elements, filters, and decorative effects should not cause the supported descendant DOM to become an image. Where possible, reproduce those effects natively; otherwise place a rasterized decorative layer behind the editable DOM rather than replacing it.

More fundamentally, anything represented by normal DOM, CSS, or SVG should remain structured and editable. Treat an inability to represent those browser primitives as a Pitolet model/importer limitation to fix, not as a reason to silently rasterize them. Expand Pitolet's node and style model where required.

Rasterization should be exceptional and explicit, limited to content that has no practical editable representation at capture time, such as a pixel canvas or an inaccessible cross-origin embedded surface. Even then, prefer a purpose-built node where possible: retain SVG as vector structure, video as media, and supported embedded content as an embed. Let the user choose whether to accept any remaining raster fallback; otherwise mark the import as incomplete or failed.

If the importer cannot preserve meaningful editability, it should report the import as degraded or failed rather than presenting it as a successful migration. A 99% visual-similarity score is misleading when the result is a screenshot. Report structural/editability quality separately, including editable-node coverage, rasterized area, rasterized node count, and the exact fallback causes. Add a regression fixture for a page with root background effects and assert that its content remains editable across the responsive breakpoints.

### Confirmed PitchDance trigger

The live page is ordinary semantic DOM. The whole-page fallback is caused by Pitolet's default `body` capture root and this computed body background:

```css
background:
  radial-gradient(64% 50% at 50% 96%, ...), radial-gradient(120% 80% at 50% -16%, ...), #0d0b0a;
```

`capture.ts` accepts only one background gradient. It marks any multi-layer background as `unsupportedReason = 'background image'`. Because the unsupported node is the capture root, `convert.ts` emits viewport-specific raster images for that root and deliberately skips `appendChildren`, discarding the otherwise supported semantic descendants.

This is primarily an importer/model mismatch: the Pitolet style schema already stores `fills` as an array and its CSS renderer can output layered fills, but the importer parses only a single gradient. Its radial-gradient representation also currently loses ellipse size and position, which are used by both PitchDance body gradients.

PitchDance also has two independent decorative fixed layers:

- `.glow`: a radial gradient with `transform: translateX(-50%)` and `filter: blur(8px)`
- `.grain`: a data-URL SVG noise texture with `mix-blend-mode: overlay`

Those may require additional native effect support or isolated decorative fallbacks, but they did not justify flattening the page. The root background classification is the direct cause of the whole-page rasterization.

## 7. Build a representative website-import compatibility audit

**Status:** Implemented as a deterministic real-browser compatibility fixture; broader public-site runs remain a release audit

Run a deliberately varied set of public and locally controlled websites through the importer at mobile, tablet, and desktop widths. Use this to find both importer defects and gaps in Pitolet's underlying document/style model before presenting website import as production-ready.

The corpus should cover:

- Clean semantic HTML and ordinary responsive marketing pages
- React/Vue-style SPAs and server-rendered applications
- Flexbox, grid, nested layouts, intrinsic sizing, sticky/fixed positioning, and overflow
- Layered gradients, background images, SVG, masks, filters, blend modes, shadows, and pseudo-elements
- Forms, tables, lists, navigation, details/dialog elements, and accessible attributes
- Local and hosted fonts, responsive typography, images, picture/srcset, and media
- CSS variables, Tailwind-style utilities, CSS modules, resets, container queries, and media queries
- Animations, transitions, transforms, portals, lazy-loaded content, consent banners, and long pages
- Canvas, video, iframes, embeds, and cross-origin boundaries as explicit exceptional cases

Record more than visual similarity for each viewport:

- Whether the import completed, degraded, or failed
- Editable-node and editable-area coverage
- Rasterized node count and page-area percentage
- Preserved semantic elements, text, attributes, assets, tokens, and responsive changes
- Unsupported properties and the exact node that triggered each fallback
- Structural and responsive matching failures
- Import time, document size, node count, asset count, warnings, and crashes
- Visual similarity after excluding intentionally dynamic content

Automatically fail the audit when ordinary DOM/CSS/SVG is flattened, when a root fallback suppresses supported descendants, or when the result is visually accurate but materially uneditable. Each discovered failure should be reduced to a small local fixture and added to the permanent importer regression suite. Keep a smaller deterministic fixture suite for CI and a broader periodically run real-site audit for discovery.

Use only publicly accessible pages or pages under the user's control, respect reasonable request limits, and avoid authenticated or personal content. Do not retain captured third-party assets or screenshots beyond the diagnostic run unless they are replaced with locally created regression fixtures.

## 8. Editor logo should return to the workspace list

**Status:** Implemented for private cloud editor sessions

In Pitolet Cloud, clicking the Pitolet logo/wordmark in the editor's top-left navigation should return the user to the workspace list/home screen. Implement it as a real keyboard-accessible link with an appropriate accessible name, visible hover/focus treatment, and no loss of unsaved work without the existing navigation warning or save behavior.

Keep environment behavior explicit: the cloud editor should navigate to the cloud workspace list, public share sessions should not expose private dashboard navigation, and self-hosted Pitolet should use its appropriate local home/document route rather than a cloud URL.

## 9. Detailed importer, model, CLI, and MCP limitation inventory

**Status:** Reproduced and addressed where representable; intentional product boundaries remain documented below

Another AI agent reported the following while importing and then manually recreating PitchDance. Treat this as a test backlog rather than proven fact. Record the source code path, minimal reproduction, expected behavior, actual behavior, severity, and whether the limitation belongs to capture, conversion, the Pitolet schema, rendering/code generation, cloud packaging, or MCP.

### Rasterization and unsupported content

- Unsupported styling on an ancestor rasterizes its entire subtree.
- There is no default safeguard against rasterizing the page/root.
- CSS transforms, filters, fixed positioning, pseudo-elements, and some asymmetric borders trigger rasterization.
- Multiple background layers are not imported.
- Radial-gradient position, shape, and dimensions are not preserved.
- Inline SVG cannot become editable vector/path nodes.
- Canvas, video, iframe, object, and embed content cannot become editable native content.

The root/ancestor rasterization and layered-gradient failure are already independently confirmed in item 6. For the other cases, distinguish between a missing native Pitolet capability, an importer parser limitation, and genuinely opaque external content. Ordinary DOM, CSS, and SVG must not silently become screenshots.

### Behavior and interaction states

- JavaScript behavior, event listeners, form behavior, dropdown logic, transitions, and animations are not imported.
- Hover, focus, and active styles are not imported.

Define the intended boundary explicitly. Pitolet should preserve native semantic controls and representable CSS states/transitions even if arbitrary application JavaScript and business logic remain out of scope. Reports and user-facing copy must distinguish unsupported behavior from dropped behavior.

### Responsive layout fidelity

- Computed styles are flattened at sampled widths, losing fluid `clamp()`, source units, `svh`, `fr`, `minmax()`, and other layout intent.
- Imports accept at most five viewport widths.
- `max-width` source breakpoints may not be discovered correctly.
- Only captured widths become Pitolet breakpoints, so intermediate widths may diverge.

Test both sampled-width accuracy and interpolation between samples. Preserve source layout expressions where safe and parseable rather than always reconstructing them from computed pixels. Verify whether the five-width limit is intentional and whether it is sufficient after source breakpoints are discovered.

### Dropped and approximated CSS

- Reportedly omitted properties include `text-transform`, `visibility`, `white-space`, detailed `font-style`, and optical sizing.
- Only the first box shadow may be imported.
- Trailing `inset` shadow syntax may be parsed incorrectly.
- White colors may occasionally fail OKLCH validation because floating-point conversion produces lightness slightly above `1`.
- Import reports do not comprehensively disclose dropped or approximated CSS.

Build a property-support matrix backed by fixtures. Clamp color conversion safely at schema boundaries. Parse complete shadow lists and valid `inset` placement. Every dropped, approximated, or normalized declaration should be counted and traceable in the report without flooding users with duplicate warnings.

### Fonts and assets

- Cross-origin stylesheets may prevent font discovery without a warning.
- Font embedding accepts WOFF and WOFF2 but not TTF or OTF.
- Font fallback stacks may be reduced to the first family.
- Accepted assets are reportedly limited to PNG, JPEG, GIF, WebP, WOFF, and WOFF2.

Verify each format and browser/CORS case. Preserve complete fallback stacks. Surface inaccessible font stylesheets and font substitutions. Decide which additional formats should be supported natively, converted safely, or rejected with a precise warning.

### Limits and document structure

- Current reported limits are 10,000 nodes, 500 assets, 200 raster regions, 20 MB per asset, and 100 MB total assets.
- Repeated structures are not inferred as reusable Pitolet components.
- Original CSS classes and design-system structure are replaced by computed styles and inferred tokens.

Limits are not automatically bugs, but must fail safely and be documented. Test realistic large pages near every boundary. Explore conservative component inference only when matching is unambiguous, and preserve useful source metadata/class information without binding the Pitolet document to brittle source CSS.

### Verification and reporting

- Visual similarity can score a fully rasterized page highly because it does not measure editability.
- The score may underweight perceptually obvious differences such as typography on large dark pages.
- Reports do not comprehensively list dropped or approximated CSS.

Item 6 already requires separate structural/editability scoring. Calibrate perceptual comparison with typography- and contrast-sensitive fixtures, and make degraded imports impossible to present as high-quality solely because their screenshots match.

### Capture controls

- The CLI lacks hooks for injecting temporary CSS, hiding dynamic elements, freezing scripts, excluding helper nodes, or running a controlled pre-capture script.

Evaluate safe, explicit capture customization. Prefer constrained flags/configuration for common deterministic tasks. Any arbitrary pre-capture scripting needs a clear trust model because it executes in the local capture browser and could change what is imported.

### MCP reliability and missing operations

- MCP tool discovery was reported at roughly 1.88 MB, with `insert_nodes` alone roughly 1.78 MB, causing Codex's native MCP connection to fail.
- The advertised MCP screenshot operation reportedly fails because Chromium is absent from the cloud runtime.
- MCP reportedly lacks document deletion and renaming, making failed-import cleanup difficult for agents.

The oversized MCP catalog is already tracked in item 1; these measurements identify `insert_nodes` as the likely primary cause and must be reproduced against the current package. Inspect whether a huge generated input schema, repeated schema branches, or descriptions cause the size. Reduce discovery payload without losing node insertion capability.

Test the screenshot tool in the actual production image. Either package its required runtime, implement it using a connected editor/runtime that already renders the document, or stop advertising it where it cannot work. Add safe document rename and deletion operations with appropriate authorization, collision handling, confirmation/destructive-operation semantics, and tests; do not conflate these with the local website-import command.

## 10. Visual feedback exists but is not a reliable or encouraged agent workflow

**Status:** Implemented with MCP guidance, responsive/state capture, and a browser-equipped cloud image

Pitolet currently exposes an MCP `get_screenshot` tool for a frame. When an editor is open for the document, the server asks that editor to render the frame and returns a JPEG to the agent. Without an open editor, the implementation falls back to headless Chromium. The README documents the tool, but the MCP server supplies no workflow instructions telling agents to inspect their work visually, and the write-tool descriptions do not prompt agents to use it after meaningful changes.

Make visual verification a normal part of the agent workflow:

- MCP instructions and setup prompts should tell agents to use `get_screenshot` after creating a page and after substantial visual edits.
- Encourage a short inspect → edit → screenshot → refine loop, while avoiding a screenshot after every tiny mutation.
- Tool output and guidance should identify which frame and responsive width/state was inspected.
- Let agents request the relevant breakpoint and interaction state, not merely a generic frame image.
- Provide a way to compare two iterations or source/reference imagery when available, with visual feedback remaining advisory rather than automatically overwriting good structure.
- Keep accessibility and structural checks alongside screenshots because visual inspection alone cannot confirm semantics or editability.

Make the tool reliable in every advertised environment. In Cloud, prefer rendering through a connected editor when possible, but clearly handle the case where no editor is connected. Verify the production container's headless fallback; if Cloud cannot provide Chromium safely, either add a dedicated rendering service/runtime or return a precise action the agent/user can take. Do not advertise a fallback that is known not to work.

Add tests for an open cloud editor, no open editor, self-hosted mode, multiple frames, breakpoints/states, timeouts, disconnected editors, oversized frames, and image delivery to MCP clients. Also measure whether the visual-verification guidance actually causes representative agents to call the tool at appropriate points.

### Confirmed Cloud screenshot failure

An agent using the production Cloud MCP endpoint confirmed that `get_screenshot` could not find its compatible Playwright Chromium binary. Running `pitolet import` once did not fix it. This is expected from the current architecture but contradicts the guidance: the import command downloads Chromium into the user's local CLI cache, while the failed screenshot fallback executes inside Pitolet Cloud's separate runtime/container. The local download cannot provision the cloud container.

Treat this as a Cloud packaging/runtime defect and a documentation defect. Remove the misleading Cloud advice immediately when implementing the fix. The production deployment must either contain a compatible browser, delegate fallback rendering to an isolated rendering service, or require a connected editor and report that requirement accurately. Verify browser-version compatibility during image build and with a production-image smoke test, rather than merely testing whether screenshot failure has a helpful message.

## 11. Horizontal canvas panning triggers browser back navigation

**Status:** Implemented with contained trackpad gestures and a Hand tool

On Chrome/macOS, attempting to pan the canvas left with a two-finger horizontal trackpad gesture can trigger the browser's swipe-to-go-back navigation. This makes part of the infinite canvas difficult or unsafe to reach and can unexpectedly leave the editor.

Contain horizontal overscroll within the editor canvas using the appropriate `overscroll-behavior` on the canvas viewport and, where necessary, the editor document root. Ensure the canvas wheel handler is explicitly non-passive, consumes cancellable trackpad gestures while the pointer is over the canvas, calls `preventDefault()`, and applies both horizontal and vertical deltas to the camera. Do not block ordinary scrolling or browser gestures in dashboard pages, inspector controls, menus, text fields, or other non-canvas surfaces.

Test genuine trackpad-style wheel sequences as well as mouse wheels on Chrome/macOS where possible. Cover panning in every direction, gestures beginning near the viewport edge, zoom modifiers, Space-drag panning, nested scrollable panels, and the editor's own back/navigation behavior. Verify that preventing browser history navigation does not trap users or break keyboard-accessible navigation.

Add a dedicated Hand/Pan tool to the editor toolbar so canvas navigation is discoverable without knowing a shortcut. While active, dragging anywhere on the canvas pans and uses clear open-hand/closed-hand cursor feedback without selecting or moving layers. Keep hold-Space as a temporary Hand tool from any other tool, restoring the previous tool on release. Give the Hand tool a visible tooltip and a conventional shortcut such as `H`, ensure Escape returns to Select consistently with the existing tool behavior, and include it in keyboard-help/onboarding copy. Avoid making the toolbar cramped at narrower editor widths.

## 12. Drag-selection does not auto-pan at canvas edges

**Status:** Implemented for all edges and corners with frame-rate-independent camera updates

When a user drags a selection marquee to the edge of the visible canvas, the viewport remains fixed. This prevents a single drag from selecting content beyond the current viewport and makes large or zoomed-in documents awkward to work with.

Add edge-triggered auto-pan while marquee selection is active. As the pointer approaches or moves beyond a canvas edge, move the camera in that direction and continue updating the marquee in canvas coordinates. The speed should increase gradually near the edge, remain stable across zoom levels and display refresh rates, and stop immediately when the pointer returns to the safe area or the drag ends.

Keep the behavior limited to canvas operations that need it. Test all four edges and corners, low and high zoom levels, pointer capture outside the editor window, browser resizing during a drag, locked or hidden layers, and cancellation with Escape. Verify that selection results remain correct while the camera moves and that auto-pan does not fight the Hand tool, Space-drag panning, layer dragging, resizing, or ordinary trackpad scrolling. Consider using the same well-tested edge-scroll primitive for moving and resizing layers where continuing beyond the viewport is also expected, while keeping each interaction's activation rules explicit.
