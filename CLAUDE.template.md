# Project instructions

> Starter file written by **weave** setup. Customize the "Your project" section
> for your codebase; the weave conventions above it are ready to use.

## Working with weave

This repo is wired to **weave** — a local, file-based ticket board plus a set of
Claude Code skills. Tracked work flows through tickets in `.tickets/`; the board
is a local dashboard (`cd .weave && bun run start` → http://127.0.0.1:5174).

- **Just find and fix things.** Don't ask permission for additive, reversible, or
  read-only changes. Ask first only for destructive/irreversible actions (delete,
  drop, overwrite) and for `git commit` / `git push` — **you own git**.
- Run tracked work through tickets. Use the `ticket-manager` skill to create,
  refine, build, test, and validate them; the board reflects the lifecycle.
- Keep answers and summaries short.

## Ticket lifecycle (the `.tickets/` buckets)

```
scratch → 0-backlog → 1-staging → 3-building → 4-testing → 5-validating → 6-complete → 7-archive
                                  ↘ 2-stuck (blocked) ↗
```

Each ticket is a markdown file with YAML frontmatter (`id`, `title`, `status`,
`priority`, `domain`, `depends_on`, `blocks`, `related`, `files_touched`, …).
Domains default to `app | infra | docs | meta` — rename them for your repo.

## Skills available

| Skill | What it does |
|---|---|
| `ticket-manager` | Owns the `.tickets/` lifecycle (create / refine / build / test / validate / link). |
| `bug-scan` | Multi-agent bug hunt → files verified findings as backlog tickets. |
| `adr-manager` / `adr-researcher` | Create and research Architecture Decision Records (`.tickets/ADRs/`). |
| `security` | Wraps the `/security-review` engine and composes findings into the board (dedup, severity, snapshot diff, auto-draft). |
| `skill-builder` / `skill-generator` / `skill-organizer` | Author, bootstrap, and curate your own skills. |

## The dashboard

```
cd .weave && bun run start     # http://127.0.0.1:5174
```

Board (drag tickets between buckets), ticket editor, ADRs, and graph views
(`tickets`, `dataflow`, `ai`, `schemas`). No database, no build step — files on
disk are the source of truth. The dashboard never runs git.

---

## Your project

<!-- Describe your stack, key directories, build/test commands, and any
     project-specific conventions here. For example: -->

- **Stack:** <languages / frameworks>
- **Run / build:** <commands>
- **Tests:** <how to run them — and run them before marking a ticket done>
- **Conventions:** <anything Claude should always follow>
