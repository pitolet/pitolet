# Pitolet marketing notes

This is a solo-founder launch with a small budget. Start in developer
communities where the product is relevant. Do not pay for promotion until an
unpaid post shows that the message works.

The main story is the problem that led to Pitolet: an agent gets the interface
close, then the user fixes the visual details on the page. The agent stays
connected over MCP.

## Positioning

Core message: _fix the interface your coding agent built._

| Audience           | Lead with                                                        | Where they are                        |
| ------------------ | ---------------------------------------------------------------- | ------------------------------------- |
| Coding-agent users | Agent changes appear on the canvas and can be undone             | r/ClaudeAI, r/mcp, X, MCP directories |
| Web developers     | CSS layout on the canvas and editable exported code              | HN, r/webdev, dev newsletters         |
| Self-hosters / OSS | AGPL, `npx pitolet`, one Docker command, designs are JSON in git | HN, r/selfhosted, awesome lists       |

Useful proof:

- The landing page is a Pitolet export.
- `npx pitolet` starts the local version.
- Documents are readable JSON.
- Agent changes appear on the canvas and can be undone.

## Assets (ready in `marketing/assets/`)

| File               | Channel                                        | When                         |
| ------------------ | ---------------------------------------------- | ---------------------------- |
| `show-hn.md`       | Hacker News launch post + prepped answers      | Launch day 1                 |
| `product-hunt.md`  | PH listing + maker comment                     | Launch day ~7                |
| `reddit.md`        | r/webdev, r/ClaudeAI, r/selfhosted posts       | Launch week, staggered       |
| `launch-thread.md` | X/Bluesky thread                               | Launch day 1, after HN is up |
| `newsletters.md`   | Console.dev submission + 25/50/100-word blurbs | Week 1–2 submissions         |
| `vs-figma.md`      | Source note for the comparison page            | Reference                    |
| `v1.0-release.md`  | GitHub v1.0 release notes                      | Historical reference         |

Existing media:

- `pitolet-demo.mp4` at the repo root is the 44-second narrated demo. Mix
  settings are in `assets/demo-voiceover.md`. The narration file is in
  `audio/`, and the silent master is in `videos/pitolet-demo-silent.mp4`.
- `marketing/videos/` contains wide and vertical cuts of three moments:
  inserting a section, changing a token, and opening the code panel.
- `marketing/gifs/`: three README-ready, palette-optimized GIFs generated from
  the same clips.

## Before promotion

- Confirm that the demo video and README GIFs still match the product.
- Build and check `/vs-figma` from its source in `site/build.ts`.
- Prepare a public, read-only demo document.
- Check the production deployment, billing, email, and npm publishing.
- Use the current tagged release. The repository is already public.

## Launch sequence

1. **Show HN** (Tue–Thu, 8–10am ET). Post from `assets/show-hn.md`. Stay at
   the keyboard to answer questions. Notes on AGPL, the CLA, Penpot, and Figma
   plugins are in the same file.
2. **MCP directories, same week.** Submit to the official
   Anthropic registry, Smithery, PulseMCP, Glama, mcp.so, awesome-mcp-servers.
   Short listing copy is in `assets/newsletters.md`.
3. **X/Bluesky thread** (`assets/launch-thread.md`) once the HN post is live,
   with the video.
4. **Product Hunt ~a week later** (`assets/product-hunt.md`). Don't burn both
   audiences the same day.
5. **Reddit, staggered over the week** (`assets/reddit.md`). Each post is
   written for its subreddit; don't cross-post identical text.
6. **Newsletter submissions** (`assets/newsletters.md`): Console.dev (free),
   TLDR submission form, JavaScript Weekly / React Status pick up strong HN
   launches on their own. Use the prepared blurbs.

## Follow-up posts

- Write about the original problem: fixing an interface after an agent gets it
  close.
- Explain how the canvas and code export share the same CSS resolver.
- Publish setup guides for the agent clients people actually use.
- Submit Pitolet to relevant open-source and self-hosting lists.

## Paid promotion

| Tactic                                             | Cost            | Note                                             |
| -------------------------------------------------- | --------------- | ------------------------------------------------ |
| Screen Studio                                      | ~$90 once       | For narrated/polished video cuts                 |
| Mid-tier dev YouTubers (50k–300k, AI-coding niche) | $200–1.5k/video | Test one channel with the demo                   |
| Console.dev sponsorship                            | ~$400           | Post-launch, point at /vs-figma                  |
| React Status / JS Weekly slot                      | $1–2k           | Only after organic launch data                   |
| EthicalAds / Carbon                                | $50–300/mo      | Small test after the unpaid launch               |
| Reddit promoted post tests                         | $100–300        | Use only if the unpaid Reddit posts perform well |

Skip Google and Meta ads unless unpaid results give a reason to test them.

At roughly $500 to $1,000, test one YouTube video and one Console.dev
placement after the Hacker News post. Review the results before setting an
ongoing budget.

## What to measure

Track repository visits, npm installs, cloud signups, first document creation,
MCP token use, and paid upgrades. Add UTM tags to channel links.

If few new accounts create an MCP token, fix that onboarding step before
buying traffic. Compare signup rates by channel before deciding where to spend.

## Promotion schedule

- **Week 1**: check the demo, README GIFs, comparison page, and production
  setup.
- **Week 2**: post to Show HN, submit to MCP directories, publish the social
  thread, and contact newsletters.
- **Week 3**: Product Hunt; Reddit staggered; first blog post; same-day issue
  replies.
- **Week 4**: compare the results by channel. If the unpaid launch worked,
  commission one YouTube video and test a Console.dev placement.
