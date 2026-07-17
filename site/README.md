# Public site

The landing page and comparison page are Pitolet documents. That keeps the public site useful as a real example of the file format and export path.

- `landing.pitolet.json` builds `deploy/static/index.html`.
- `vs-figma.pitolet.json` builds `deploy/static/vs-figma/index.html`.
- `build.ts` is the editable source for both documents.

You can edit the JSON documents in Pitolet or change the factory calls in `build.ts`. Run `pnpm build:site` afterward. The build is deterministic, so the same source produces the same files.

Before committing a site change:

```bash
pnpm check:site
pnpm qa:site
```

The first command rebuilds into a temporary directory and checks every generated file without touching your working tree. The browser check opens the landing, comparison, terms, and privacy pages at mobile, tablet, and desktop widths. It saves screenshots, rejects blank output, checks internal links and overflow, and runs axe.
