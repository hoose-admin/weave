# weave

A local, file-based **Claude Code UI + ticket board + codebase map + (a few Claude Code skills)** you can
drop into any repo. Clone it, run one setup script against your project, and you
get a localhost dashboard, a graph of your codebase, and a backlog that fills
itself from a bug-scan of your own code.

No database. No build pipeline. No external services. Markdown files on disk are
the source of truth, served by a tiny [Bun](https://bun.sh) process on
`127.0.0.1`.

---

## Quickstart

```bash
git clone <this-repo> weave
cd weave
bash setup.sh /path/to/your/repo      # defaults to the current directory

cd /path/to/your/repo/.weave
bun run start                          # → http://127.0.0.1:5174

To kill:  lsof -ti :5174 | xargs kill
```

That's it. Open the URL and you'll see your board, your codebase graph, and (if
Claude Code is installed) a backlog of real findings from your code.

### Requirements

- **[Bun](https://bun.sh)** — runs the dashboard and the CLI. *(required)*
- **[Claude Code](https://claude.com/claude-code)** — powers the `bug-scan` skill
  that fills the backlog from your code. *(optional, but it's the point)*
- **[ttyd](https://github.com/tsl0922/ttyd)** + **[tmux](https://github.com/tmux/tmux)**
  — power the **Terminal** tab (`brew install ttyd tmux`). *(optional)*

---

## What `setup.sh` does

1. **Vendors the app** — copies the Bun dashboard into `your-repo/.weave/`.
2. **Installs the skills + hook + commands** into `your-repo/.claude/`, merging
   weave's hook into any existing `.claude/settings.json` (idempotent,
   non-destructive). Commands include the vendored, stack-agnostic
   `/security-review` engine (MIT) that the `security` skill wraps.
3. **Scaffolds the board** — `your-repo/.tickets/` with the 9 lifecycle buckets
   and an `ADRs/` folder.
4. **Writes `weave.config.json`** and a starter `CLAUDE.md` (only if you don't
   already have one).
5. **Builds the dashboard graphs** — deterministic, no Claude needed. The
   `dataflow` and `schemas` graphs are detected straight from your code here.
6. **Runs `bug-scan`** (if Claude Code is present) — files verified bugs into the
   backlog. The board is populated by *your* code from minute one.

Flags: `--no-scan` (skip step 6), `--start` (launch the board at the end),
`--port N`.

> The headless bug-scan pass (`claude -p …`) is best-effort. If it doesn't fully
> complete under your permission settings, just run it interactively in Claude
> Code: `/bug-scan`. Everything else in setup is deterministic.

---

## The board

Tickets are markdown files with YAML frontmatter. They flow through buckets:

```
scratch → 0-backlog → 1-staging → 3-building → 4-testing → 5-validating → 6-complete → 7-archive
                                  ↘ 2-stuck ↗
```

Drag tickets between buckets in the UI, edit them in the browser, or let the
`ticket-manager` skill drive the lifecycle. Completed tickets auto-archive after
7 days.

## The graphs (`/graphs/...`)

| View | What it shows |
|---|---|
| **tickets** | `depends_on` / `blocks` / `related` across the board. |
| **dataflow** | Architecture diagram — frontend routes → backend container(s)/endpoints → databases, detected per repo. |
| **ai** | The full Claude Code ecosystem — skills, agents, hooks, MCP, settings. |
| **schemas** | Your databases — detects Firestore / SQL / BigQuery usage and maps each one's tables/collections, columns/fields, and relationships. |
| **adrs** | Architecture Decision Records and the tickets that implement them. |

## The terminal (`/terminal`)

Open `zsh` terminals in the browser and run `claude` (or anything) in them. Each
session is a [ttyd](https://github.com/tsl0922/ttyd) process bound to
`127.0.0.1`, backed by a [tmux](https://github.com/tmux/tmux) session so it
survives page refreshes and dashboard restarts. The left sidebar lists open
sessions; the **+** button (top-left) opens one in the default working directory
set in the bar beside it — which defaults to `~`. Requires `ttyd` + `tmux`
(`brew install ttyd tmux`) — the tab shows an install hint if they're missing.

Each tab carries a **live status dot** — pulsing amber while something is running
(e.g. Claude working), red when it's waiting on you (a permission prompt), green
when a background run just finished and you haven't looked yet, and nothing when
idle — plus a short **AI summary** of what's happening. weave reads
each terminal's screen with `tmux capture-pane`; the dot is a purely local
heuristic, while the summaries call the Anthropic API (Haiku).

> These are fully interactive, writable shells on your machine. ttyd binds to
> localhost only and there's no extra auth — the same trust model as the rest of
> the localhost-only dashboard.
>
> **Status, summaries, and notifications are 100% local.** When Claude Code runs
> in a weave terminal, a hook (`terminal_live.ts`) writes its state, a few-word
> summary of your last prompt, and any pending permission/idle prompt to a local
> file the dashboard reads — no API key, nothing leaves your machine. Terminals
> without the hook fall back to a local status dot inferred from the tmux pane.

## The skills

| Skill | Kind | What it does |
|---|---|---|
| `ticket-manager` | utility | Owns the `.tickets/` lifecycle. The hub. |
| `bug-scan` | workflow | Fan-out bug hunt → adversarial verify → files backlog tickets. |
| `adr-manager` | workflow | Create / transition / link Architecture Decision Records. |
| `adr-researcher` | audit | Researches a decision and drafts an ADR. |
| `security` | audit | Wraps the off-the-shelf `/security-review` engine and composes findings into the board (dedup, severity, snapshot diff, auto-draft). |
| `skill-builder` | utility | Author and audit skills. |
| `skill-generator` | generator | Bootstrap a skill portfolio for a new repo. |
| `skill-organizer` | orchestrator | Curate an existing portfolio (merges, renames, retirements). |

---

## Layout of this repo

```
weave/
├── setup.sh                 # the installer
├── settings.template.json   # hook wiring merged into the target's .claude/settings.json
├── CLAUDE.template.md        # starter project instructions copied into the target
├── scripts/merge-settings.ts
├── app/.weave/              # the Bun dashboard, vendored into <target>/.weave
│   ├── server.ts            # Bun.serve + REST API + static serving
│   ├── weave.config.ts      # path/port resolver (env + weave.config.json overrides)
│   ├── lib/                 # tickets, ADRs, frontmatter, graph builders
│   ├── public/              # vanilla-JS UI (board, ticket editor, Cytoscape graphs)
│   └── scripts/ticket-cli.ts# next-id / audit-ids / create (headless ticket filing)
├── skills/                  # installed into <target>/.claude/skills
├── commands/                # vendored /security-review engine → <target>/.claude/commands
└── hooks/skill_reflect.ts   # installed into <target>/.claude/hooks (runs on Bun)
```

## Configuration

The vendored layout (`<repo>/.weave` beside `<repo>/.tickets` and
`<repo>/.claude`) works with zero config. To override, edit `weave.config.json`
at your repo root or set env vars:

| Setting | `weave.config.json` | env var | default |
|---|---|---|---|
| Repo root | `repoRoot` | `WEAVE_REPO_ROOT` | parent of `.weave/` |
| Tickets dir | `ticketsRoot` | `WEAVE_TICKETS_ROOT` | `<repo>/.tickets` |
| ADRs dir | `adrsRoot` | `WEAVE_ADRS_ROOT` | `<tickets>/ADRs` |
| Port | `port` | `PORT` | `5174` |

## Notes

- **File-based, localhost-only.** The server binds `127.0.0.1`, has no auth layer,
  and **never runs git** — you own commits.
- `.weave/cache/` holds generated graph JSON; it's safe to delete (rebuilt on
  demand) and is gitignored.
- The board's data — `.tickets/` — is plain markdown. Commit it to version your
  backlog alongside your code, or gitignore it to keep it local.
