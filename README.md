# /brag

**You built it. Now brag.**

> **Want a video without running `/brag` yourself?** Paste your site's link at [letsbrag.app](https://letsbrag.app).

[![the /brag launch site — you built it, now brag](docs/assets/hero.png)](https://latent-spaces.github.io/brag/)

`/brag` is an agent skill that turns the project you created into a short, shareable launch trailer — a recording of the product, music, captions, and share copy. One command. Hyperframes is still there as `/brag --full`.

The looping video on the [launch site](https://latent-spaces.github.io/brag/) was made by `/brag` on this very repo. 

## Rather not run it yourself? Use letsbrag.app

[letsbrag.app](https://letsbrag.app) runs `/brag` for you. Paste your site's link and get a 20-second launch video with music, motion, and share copy. No setup, no subscription.

The skill stays free and open source. Install it below and run it yourself anytime.

## New: `/brag-slim`

**The trailer pipeline, and the path `/brag` uses by default.**

A recording of the product, cut and scored by the scripts in this repo, with captions and share copy. Hyperframes is not required.

On every model, `/brag` uses this pipeline. Run `/brag --full` for the Hyperframes workflow.

**Install just `/brag-slim`:**

```bash
npx skills add https://github.com/latent-spaces/brag --skill brag-slim
```

Already have the Claude Code `/brag` plugin? `/brag-slim` has shipped with it since 0.4.0. Version 0.6.0 makes the pipeline the default. Run `claude plugin update brag`.

## Install /brag

**Codex:**

```bash
codex plugin marketplace add latent-spaces/brag
codex plugin add brag@brag
```

To update it later:

```bash
codex plugin marketplace upgrade brag
codex plugin add brag@brag
```

**Claude Code:**

```bash
/plugin marketplace add latent-spaces/brag
/plugin install brag@brag
```

Then run `/brag` inside any project. The plugin includes `/brag-slim` too.

**Any other agent** — one command via the [`skills`](https://github.com/vercel-labs/skills) CLI (Cursor, Codex, Copilot, Gemini CLI, opencode, and more):

```bash
npx skills add https://github.com/latent-spaces/brag --skill brag
```

Add `-g` to install globally (available in every project); drop it to scope to the current one. ([browse on skills.sh](https://www.skills.sh/latent-spaces/brag/brag))

<details>
<summary>No installer? Copy the skill directly.</summary>

```bash
rsync -a --exclude '.DS_Store' skills/brag/ ~/.claude/skills/brag/
rsync -a --exclude '.DS_Store' skills/brag-slim/ ~/.claude/skills/brag-slim/  # optional: the /brag-slim command
```

Restart Claude Code after copying.
</details>

### Also works with

This repo exposes the skill at every agent's standard discovery path via symlinks. No extra config needed.

| Agent | How it discovers |
|---|---|
| **Google Antigravity** | Auto-detects from `.agents/skills/brag/` at project root or `~/.gemini/config/skills/brag/` globally |
| **opencode** | Auto-detects from `.opencode/skills/brag/` at project root |
| **Codex CLI** | Reads `.agents/skills/brag/`, walking up to repo root |
| **Claude Code** | Also reads `.claude/skills/brag/` (in addition to the `.claude-plugin/` marketplace install above) |
| **Other agents** | Point custom instructions at `skills/brag/SKILL.md` — see [`docs/other-agents.md`](docs/other-agents.md) |

> **Windows users:** Git requires `git config core.symlinks true` (or `git clone -c core.symlinks=true`) and Windows Developer Mode or Administrator privileges to create symlinks. If symlinks don't work on your system, copy `skills/brag/` to the agent's skill directory manually instead.

## Use it

From any project directory, ask your agent:

```text
let's /brag
```

Or steer the tone:

```text
/brag --tone "fake Series A launch from 2016"
```

Voiceover is off by default. Enable it explicitly with:

```text
/brag --voice
```

Narration is off unless you pass `--voice`. It uses Kokoro when `npx hyperframes tts` is available. The trailer still has to work with the sound off.

You get a `brag-output/` folder with the plan, `spec.json`, share copy, captions, a poster, and `brag.mp4`. `--pack` also writes the vertical and square cuts. `--full` still writes a Hyperframes composition instead of `spec.json`.

## How it works

`/brag` owns the story: the product angle, the tone, and which moments to show. It writes a `spec.json`. The scripts record a browser session when the product can be driven, then cut, score, caption, and render the trailer. `/brag --full` hands the same kind of brief to [Hyperframes](https://hyperframes.heygen.com/) instead.

## Requirements

- An agent that supports Agent Skills — Claude Code, Cursor, opencode, Codex CLI, or any agent with custom instructions (see "Also works with" above)
- Node.js 22+
- FFmpeg on `PATH`
- Chrome, for a recorded take
- Playwright, so the recorder can drive the page (`npm install playwright` in the project, or pass a path to an install you already have)
- Hyperframes CLI — only for `/brag --full`, and for `/brag --voice` when you want Kokoro narration (`npx hyperframes doctor`)

## What's in this repo

- `skills/brag/` — the `/brag` skill. The default run follows the bundled `slim.md`
- `skills/brag-slim/` — the trailer pipeline: the skill, plus `scripts/` (`spec.mjs`, `render.mjs`, capture, compose, sound)
- `examples/` — fake product sites used as a benchmark suite
- `docs/` — the launch site (GitHub Pages)
- `plugin.json` — portable Agent Plugins manifest
- `.codex-plugin/` — Codex compatibility manifest
- `.claude-plugin/` — Claude Code manifest + shared marketplace catalog (also recognized by Codex)
- `.claude/skills/brag/` — symlink → `skills/brag/` (Claude Code discovery)
- `.agents/skills/brag/` — symlink → `skills/brag/` (Codex CLI + opencode discovery)
- `.opencode/skills/brag/` — symlink → `skills/brag/` (opencode discovery)

## Credits

- Default soundtrack — generated in this repo, one bed per tone
- Music on `/brag --full` — [ende.app](https://ende.app/en) "Happy Beats / Business Moves" (CC BY 4.0)
- Sound effects on `/brag --full` — [Kenney](https://kenney.nl/)
- `/brag --full` — [Hyperframes](https://hyperframes.heygen.com/)
- Fake demo sites — built with [Impeccable](https://impeccable.style/)

## Contributing

Contributions, ideas, and new demo brags are welcome — open an issue or a PR.

## Star History

<a href="https://www.star-history.com/?type=date&repos=latent-spaces%2Fbrag">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=latent-spaces/brag&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=latent-spaces/brag&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=latent-spaces/brag&type=date&legend=top-left" />
 </picture>
</a>
