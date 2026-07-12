# Pitolet marketing plan

This is a solo-founder launch with a small budget. Focus on places where
developers already look for tools, and spend only after an organic channel
shows that it can bring the right users. The two clearest product stories are:

1. **Coding agents work in the same shippable artifact.** Claude Code edits
   the canvas live over MCP, you can ⌘Z it, and the changed document remains
   real DOM/CSS that exports deterministically to code.
2. **The landing page is a Pitolet document**, exported by Pitolet's own
   codegen. Every post gets to say "the page you're reading is the demo."

## Positioning

Core message: *the design tool your coding agent can use — real DOM and CSS on
the canvas, the file lives in your repo, no handoff.*

| Audience | Lead with | Where they are |
|---|---|---|
| AI-coding early adopters | 20 MCP tools; agent edits live, undoable | r/ClaudeAI, r/mcp, X, MCP directories |
| Figma-frustrated devs | real flexbox, real `:hover`, codegen that isn't px soup | HN, r/webdev, dev newsletters |
| Self-hosters / OSS | AGPL, `npx pitolet`, one Docker command, designs are JSON in git | HN, r/selfhosted, awesome lists |

Proof points to repeat everywhere: landing page is a Pitolet export ·
`npx pitolet` works cold · designs diff cleanly in git · agent edits are
undoable in-editor.

## Assets (ready in `marketing/assets/`)

| File | Channel | When |
|---|---|---|
| `show-hn.md` | Hacker News launch post + prepped answers | Launch day 1 |
| `product-hunt.md` | PH listing + maker comment | Launch day ~7 |
| `reddit.md` | r/webdev, r/ClaudeAI, r/selfhosted posts | Launch week, staggered |
| `launch-thread.md` | X/Bluesky thread | Launch day 1, after HN is up |
| `newsletters.md` | Console.dev submission + 25/50/100-word blurbs | Week 1–2 submissions |
| `vs-figma.md` | pitolet.com/vs-figma page copy (build as a Pitolet doc) | Before launch |
| `v1.0-release.md` | GitHub v1.0 release notes | Release day |

Existing media:

- `pitolet-demo.mp4` at the repo root: the ElevenLabs-narrated and music-mixed
  44s hero demo (1080p). Voiceover script and mix settings are in
  `assets/demo-voiceover.md`; the generated narration is in `audio/`, and the
  silent master is in `videos/pitolet-demo-silent.mp4`.
- `marketing/videos/`: six social cuts, three clips × two formats.
  `insert` (12s, agent adds a section live) → pinned tweet, thread slot 3,
  YouTuber hand-off. `recolor` (10s, token change re-styles the doc) →
  thread slot 4, Reels/Shorts vertical. `code` (10s, inspector + React
  export) → r/webdev and the codegen argument. Wide = 1600×900 for
  X/LinkedIn; tall = 1080×1920 for Reels/Shorts/TikTok. Each opens on a
  hook card and closes on the npx chip.
- `marketing/gifs/`: three README-ready, palette-optimized GIFs generated from
  the same clips.

## Pre-launch checklist

- [x] Demo video with voiceover; 3 GIFs; hero GIF at the top of the README
- [ ] `/vs-figma` page live (copy in `assets/vs-figma.md`)
- [ ] Public read-only demo doc via a share link (dogfoods the share feature)
- [ ] Deploy: Hetzner VPS, DNS, Paddle live keys, Resend, npm Trusted
      Publisher, deprecate 0.1.0 (see deploy/README.md)
- [ ] Repo public + v1.0 tagged a few days before the HN post

## Launch sequence

1. **Repo public + tag v1.0.** A few days early so the repo has releases and
   green CI when traffic arrives.
2. **Show HN** (Tue–Thu, 8–10am ET). Post from `assets/show-hn.md`. Stay at
   the keyboard all day; comment quality decides the front page. Prepped
   answers for AGPL/CLA/Penpot/why-not-a-plugin are in the same file.
3. **MCP directories, same week** — the unfair free channel: official
   Anthropic registry, Smithery, PulseMCP, Glama, mcp.so, awesome-mcp-servers.
   Short listing copy is in `assets/newsletters.md`.
4. **X/Bluesky thread** (`assets/launch-thread.md`) once the HN post is live,
   with the video. Tag the MCP/Claude Code community; Anthropic DevRel
   amplifies good MCP servers.
5. **Product Hunt ~a week later** (`assets/product-hunt.md`). Don't burn both
   audiences the same day.
6. **Reddit, staggered over the week** (`assets/reddit.md`). Each post is
   written for its subreddit; don't cross-post identical text.
7. **Newsletter submissions** (`assets/newsletters.md`): Console.dev (free),
   TLDR submission form, JavaScript Weekly / React Status pick up strong HN
   launches on their own — the blurbs make it easy for them.

## Ongoing free channels

- **Content, one post every 1–2 weeks.** In order: "I let Claude Code redesign
  my landing page" (narrative, shareable) · why design tools lie about layout
  (technical essay, the resolve.ts single-source-of-truth story) · your design
  system as tokens the agent actually uses · per-agent setup guides (Claude
  Code, Cursor, Windsurf, Cline) as SEO landing pages.
- **Build in public on X/Bluesky**: ship-logs, GIFs, agent clips.
- **OSS flywheel**: same-day replies to first issues, `good first issue`
  labels, public roadmap in Discussions. Submit to awesome-selfhosted and
  awesome-react.

## Paid (spend only where it multiplies)

| Tactic | Cost | Note |
|---|---|---|
| Screen Studio | ~$90 once | For narrated/polished video cuts |
| Mid-tier dev YouTubers (50k–300k, AI-coding niche) | $200–1.5k/video | Best $/attention; the agent demo is inherently visual |
| Console.dev sponsorship | ~$400 | Post-launch, point at /vs-figma |
| React Status / JS Weekly slot | $1–2k | Only after organic launch data |
| EthicalAds / Carbon | $50–300/mo | Cheap always-on, low ceiling |
| Reddit promoted post tests | $100–300 | Only channel where paid looks native |

Skip Google/Meta ads: contested CPCs, dev ad-blindness.

Budget shapes: **$100** = Screen Studio + all-organic. **$500–1k launch
boost** = + one YouTube video + Console.dev, timed 1–2 weeks post-HN.
**$500/mo ongoing** = rotate one newsletter or video slot + $100 ads.

## Funnel and metrics

Stars / npm installs → cloud signups → activated (doc created + MCP token
used) → Pro. UTM-tag every channel link. Watch:

- **MCP token creation rate** among signups — the activation event for the
  differentiated use case. If low, fix onboarding ("connect your agent" step),
  not traffic.
- Star→signup ratio per channel; spend follows the best ratio.
- Free→Pro pressure points are team features (workspaces, members, history,
  share links) — team-workflow content is monetization content.

## First 30 days

- **Week 1**: voiceover + GIFs, README hero GIF, /vs-figma live, deploy
  checklist done.
- **Week 2**: repo public, v1.0 → Show HN (full-day comment duty) → MCP
  directories + X thread + newsletter submissions.
- **Week 3**: Product Hunt; Reddit staggered; first blog post; same-day issue
  replies.
- **Week 4**: review funnel per channel; commission one YouTube video +
  Console.dev slot using week-one numbers as social proof.
