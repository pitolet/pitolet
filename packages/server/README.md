# Pitolet

Pitolet is a visual editor for web interfaces. It runs locally by default and
also exposes an API and MCP server so coding agents can work on the same
document.

```bash
npx pitolet
```

The server listens on `127.0.0.1:4517`. Set `PITOLET_PASSWORD` before exposing
it to another machine.

To import a page:

```bash
PITOLET_TOKEN=... npx pitolet import http://localhost:3000 \
  --to https://app.pitolet.com/w/my-workspace
```

Import uses Playwright Core and downloads its matching Chromium build the first
time it is needed. The browser is cached for later imports.

See [the repository](https://github.com/pitolet/pitolet) for setup, MCP, import,
self-hosting, and licensing details.
