---
name: repo-map
description: "Builds a rich, semantic code-structure graph for the weave dashboard's /graphs/repo-map view by introspecting an arbitrary repo with an agent — languages, top-level modules, entrypoints, and the load-bearing cross-module import edges — and writes it to the dashboard cache so it wins over the heuristic fallback. Output is a FLAT Cytoscape graph (dir/file nodes, contains/imports edges) the viewer styles verbatim. Writes exactly one file: <REPO_ROOT>/.weave/cache/repo-map-graph.json."
when_to_use: "User says 'build the repo map', 'map this codebase', 'rich repo-map graph', 'regenerate the repo map with an agent', 'the repo-map graph is just a dumb file walk, make it smarter', 'understand this repo as a graph', 'show me the module map'."
connects_to: []
kind: generator
---

# Repo Map

Produces a richer, semantic version of the dashboard's `/graphs/repo-map` graph by reading an arbitrary repo with an agent and writing the result to the dashboard cache. The server serves a written cache verbatim, so this rich output replaces the built-in heuristic file-walk until someone forces `?rebuild=1`.

## When to invoke

- "build / regenerate the repo map" → `build-repo-map`
- "map this codebase as a graph" → `build-repo-map`
- "the repo-map view is just a flat file dump — make it semantic" → `build-repo-map`

## When NOT to invoke

- The user wants the cheap automatic file-walk (no agent) — that already runs on its own when no cache exists, or via `cd .weave && bun run build:graphs`. Don't invoke this skill for that.
- The user wants the *tickets*, *skills*, *adrs*, or *ai* graph — those are separate builders; this skill only touches `repo-map`.
- The user wants to edit the heuristic builder logic in `.weave/lib/graphs/repo-map.ts` — that's a code change, not a graph build.

## How this fits the dashboard

- The server treats the `repo-map` cache as **always fresh** (`newestSourceMtime` returns 0 for this kind), so a written `repo-map-graph.json` is served as-is and is never silently rebuilt. Your rich graph wins.
- `?rebuild=1` on the view forces the heuristic file-walk builder and overwrites your cache. Tell the user this is the only thing that discards the rich map.
- The fallback builder (`.weave/lib/graphs/repo-map.ts`) and `bun run build:graphs` are the cheap path; this skill is the rich path. They produce the **same JSON shape** — match it exactly so the viewer styles either one.

## Output contract (match exactly)

Top-level shape — nothing more, nothing less:

```
{ "nodes": [...], "edges": [...], "meta": {...} }
```

Node — `kind` is `"dir"` or `"file"` ONLY:

```
{ "data": { "id": "...", "label": "...", "kind": "dir"|"file", "lang"?: "...", "entry"?: true } }
```

Edge — `kind` is `"contains"` or `"imports"` ONLY:

```
{ "data": { "id": "...", "source": "...", "target": "...", "kind": "contains"|"imports" } }
```

`meta`:

```
{ "built": "<ISO-8601>", "counts": { "dirs": N, "files": N, "totalFiles": N, "imports": N, "<lang>": N, ... }, "warnings": [ { "kind": "...", "detail": "..." } ], "source": "skill" }
```

Hard rules the viewer depends on (`.weave/public/graphs.js`, repo-map style block + `infoLine`):

- **FLAT graph only. No compound / `parent` nodes.** Directories are ordinary `kind:"dir"` nodes linked to their children by `contains` edges. The default dagre layout throws on compound nodes — a `parent` field crashes the view.
- `lang` is the language token: `ts, js, py, go, rs, rb, java, c, cpp, cs, php, swift, kt, scala, sh, sql, vue, svelte`. The viewer color-codes `ts / js / py / go / rs / rb`; others render with the default file style — still set `lang` for them.
- `entry: true` marks an entrypoint; the viewer renders it as a star. Put it ONLY on `file` nodes.
- `id` must be unique and stable. Use the repo-relative POSIX path for files (`src/server.ts`) and a `dir:`-prefixed relative path for directories (`dir:src`). `contains`/`imports` edge `source`/`target` reference these ids. `label` is the short basename.
- `meta.source` = `"skill"` (this is how a reader tells the rich map from the heuristic, whose source is `"heuristic"`).
- `meta.counts` MUST include `dirs`, `files`, `totalFiles`, `imports`, plus one entry per language (`ts`, `py`, …). `infoLine` reads these.
- **Never silently cap.** Any collapse, drop, or omission ("showing directory level only", "dropped N vendored dirs", "N dynamic imports unresolved") goes in `meta.warnings` as `{kind, detail}`.

## Size budget

Keep it legible: **aim for ≤ ~300 nodes.** For a large repo, collapse to directory / module level — drop individual `file` nodes, keep `dir` nodes, and aggregate imports to one `imports` edge per `(fromDir → toDir)` pair (mirrors the heuristic's directory-level mode). Record the collapse in `meta.warnings` (e.g. `{kind:"collapsed", detail:"1842 files exceed the ~300-node budget — directory level only"}`). Prefer semantic grouping (one node per feature / package) over raw directory nesting where it aids comprehension — but still emit it as the flat dir/file shape above.

## Procedure: build-repo-map

1. **Resolve `REPO_ROOT`.** It's the repo that contains the dashboard's `.weave/` directory — the **parent of the `.weave/` dir that holds the running `server.ts`** (default per `weave.config.ts`; a `weave.config.json` `repoRoot` or `$WEAVE_REPO_ROOT` can override it). The cache you write goes in that same `.weave/` dir's `cache/` folder. State the resolved `REPO_ROOT` and the absolute cache path back to the user before writing.

2. **Introspect the repo.** Spawn a fresh `Explore` subagent (read-only) — or read directly for a small repo — to gather:
   - **Languages** present and rough file counts per language (from extensions).
   - **Top-level modules / packages** — the real organizing units (e.g. `src/`, `cmd/`, workspace packages, Python packages with `__init__.py`, Go modules, Rust crates). Group semantically; one node per package beats one node per nested directory.
   - **Entrypoints** — `index.*`, `main.*`, `__main__.py`, `mod.rs`/`lib.rs`, `app.*`, `server.*`, plus anything a package manifest names as `bin` / `main` / `scripts` start command / `[[bin]]`. Mark these `entry: true`.
   - **The load-bearing cross-module import edges** — which modules depend on which. You don't need every import; you need the dependency backbone between the top-level units. Resolve them best-effort.
   - Ignore the usual noise: `node_modules`, `.git`, `dist`, `build`, `out`, `.next`, `__pycache__`, `.venv`/`venv`, `target`, `vendor`, `coverage`, `.cache`, and the dashboard's own `.weave/`.

3. **Assemble the FLAT graph** from the introspection:
   - One `dir` node per kept module/directory; `contains` edges parent→child and dir→file.
   - One `file` node per kept file (skip at the file level if over budget — see Size budget), with `lang` set and `entry: true` where applicable.
   - `imports` edges for the dependency backbone (file→file when at file level; `dir:`→`dir:` aggregated when collapsed).
   - Fill `meta.counts` (incl. per-language) and `meta.warnings`; set `meta.source = "skill"` and `meta.built` to the current ISO timestamp.
   - Sanity-check before writing: every edge endpoint resolves to a node id; no node has a `parent` field; `kind` values are only `dir`/`file` and `contains`/`imports`; node count is within budget or the overflow is recorded in `warnings`.

4. **Write the cache.** Write the JSON (pretty-printed) to `<REPO_ROOT>/.weave/cache/repo-map-graph.json`, creating the `cache/` directory if absent. This is the ONLY file the skill writes.

5. **Tell the user to view it.** Point them at `http://127.0.0.1:5174/graphs/repo-map` (the dashboard's default port; honor a `weave.config.json` `port` / `$PORT` override if set). Note that `?rebuild=1` would discard this rich map and fall back to the heuristic file-walk. Echo a one-line summary: node/edge counts, languages, and any warnings.

## Boundaries

- **Never runs git.** No `git` of any kind. Introspection is filesystem reads only.
- **Writes exactly one file:** `<REPO_ROOT>/.weave/cache/repo-map-graph.json`. Touches nothing else — not source, not the heuristic builder, not other graph caches.
- **Flat graph only.** No compound/`parent` nodes — they crash the dagre layout. Directories are ordinary nodes.
- **Best-effort, honest.** Drop dynamic / generated / unresolvable imports rather than guess at a target; record what was dropped or collapsed in `meta.warnings`. Never fabricate an edge to a module you couldn't resolve, and never silently cap.

## Prerequisites

- A weave install with `.weave/` present (the dir containing `server.ts` and `lib/graphs/repo-map.ts`); `REPO_ROOT` resolves to its parent.
- The dashboard server running (`cd .weave && bun run start`, or however it's started) to view the result at the URL above — not required to write the cache.
