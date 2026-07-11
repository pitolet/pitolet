# site/

The public site is made from real Pitolet documents. `landing.pitolet.json`
generates `deploy/static/index.html`, and `vs-figma.pitolet.json` generates
`deploy/static/vs-figma/index.html`, both through Pitolet's own codegen
(`buildPreviewHtml`). The pages double as working demos of the tool.

To edit: open either `.pitolet.json` document in Pitolet, **or** edit the factory
calls in `build.ts`.

To rebuild: `node site/build.mjs`. The build is deterministic, so re-running it produces byte-identical output.
