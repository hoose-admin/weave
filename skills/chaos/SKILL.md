---
name: chaos
description: "Chaos mode — weave's third, fully-autonomous ticket-execution mode (alongside user-driven and agentic). Arms a background supervisor that drains the backlog with ZERO human input: one fresh `claude -p` per ticket in its own `chaos/TKT-NNN` git worktree, self-deliberating on technical decisions via competing viewpoint subagents, landing each ticket in `5-validating/` on a pushed branch for human review — never merging to main. Requires a Claude Max subscription (each ticket runs Opus 4.8 / xhigh under a usage throttle). Operations: arm (`/chaos`), `/chaos stop`, `/chaos resume`, `/chaos status`."
when_to_use: "User types `/chaos`, `/chaos stop`, `/chaos resume`, `/chaos status`, or says 'run chaos mode', 'drain the backlog autonomously', 'arm chaos'. NEVER entered implicitly — only via the explicit arming ceremony here. The ticket-manager flow-gate must redirect any 'chaos' request to this skill."
connects_to:
  - handoff:ticket-manager
  - handoff:adr-manager
  - handoff:feature-scout
  - handoff:ux-audit
  - handoff:a11y-audit
kind: workflow
---

# Chaos mode

> ⚠ **EXPERIMENTAL — fully autonomous, no human in the loop.** Chaos amplifies every risk in the `ticket-manager` EXPERIMENTAL warning (autonomous coding agents have wiped production databases). Its safety rests on three guarantees you must never weaken: work happens only on `chaos/TKT-NNN` branches and is **never merged to main autonomously**; every ticket ends in **`5-validating/` for human review**; and **nothing arms without the explicit ceremony below**.

## The three execution modes

|  | user-driven | agentic | **chaos** |
|---|---|---|---|
| Human gates | every step | once (commit) | **zero** |
| Entry | flow-gate | flow-gate | **`/chaos` arming ceremony only** |
| When stuck | — | wait in `2-stuck/` | **deliberate, or skip** |
| Driver | interactive | foreground `run-stack` | **background supervisor + fresh `claude -p` per ticket** |
| Isolation | current tree | current tree | **`chaos/TKT-NNN` worktree per ticket** |
| Terminal state | user moves | `5-validating/` | **`5-validating/`, branch pushed, never merged** |

Chaos is a **sibling** of the flow-gate modes, not reachable through it. The `ticket-manager` flow-gate redirects any "chaos" request here.

## Requirements (check at arm time, warn if missing)

- **Claude Max subscription.** The proactive throttle reads the 5h/7d rate-limit windows only a Max plan exposes. Each ticket's `claude -p` runs **Opus 4.8 at `xhigh`** under a per-ticket `--max-budget-usd` cap.
- **Usage snapshot bridge** wired (`chaos-statusline-snapshot.ts` tee → `~/.claude/.weave-usage-snapshot.json`). Missing/stale ⇒ chaos runs serial + reactive-only.
- **Git remote + push perms** if `push_to_remote` (default on). Absent ⇒ branches stay local.

## Operation: arm (`/chaos`)

The ONLY way to start chaos. **Default-deny** on anything short of the exact token.

1. **Preview.** Run `bun .weave/scripts/chaos-eligible.ts` and show eligible tickets (id · priority · complexity). Show caps from `.weave/cache/chaos/config.json` (defaults: `max_tickets` 10, `max_parallel` 3, pause@90%/5h, `max_adrs` 3, `generate_when_dry` on).
2. **Pre-flight** (report each result):
   - **Usage signal** — read `~/.claude/.weave-usage-snapshot.json`. Missing/stale → warn the proactive throttle is blind (reactive backoff only); offer to wire the tee: point `statusLine.command` at `chaos-statusline-snapshot.ts` wrapping the user's existing statusline (reversible on stop).
   - **Git** — `git remote get-url origin` and push perms present? If not and `push_to_remote`, warn branches stay local.
3. **Spell it out, verbatim:** "Chaos will run autonomously with **no further prompts**. It builds up to `<max_tickets>` tickets (when the backlog drains it runs its **scout rotation** — feature-scout invents features, ux-audit / a11y-audit propose improvements to what exists), each on a `chaos/TKT-NNN` branch pushed to origin, landing in `5-validating/`. It will **not** merge to main. Stop anytime: `/chaos stop` or `touch .tickets/STOP`."
4. **Require the token.** Ask the user to type exactly **`arm chaos`**. Anything else → do not start. Re-ask once on an ambiguous reply, then abort. Never infer intent.
5. **Launch detached** (the supervisor writes the `.chaos-active` flag + run record itself):
   ```bash
   nohup bun .weave/scripts/chaos-supervisor.ts > .weave/cache/chaos/supervisor.log 2>&1 &
   ```
   Then report the run id (from `.weave/cache/chaos/supervisor.log`) and that the dashboard banner + `[CHAOS]` badge are live.

## Operation: `/chaos stop`

`touch .tickets/STOP` and remove `~/.claude/.chaos-active`. The supervisor halts at the top of its next loop iteration. Tell the user to delete `.tickets/STOP` before any future run. If the statusline tee was wired at arm time, offer to restore the original `statusLine.command`.

## Operation: `/chaos resume`

For resuming after a `/chaos stop` or a crash (the supervisor self-resumes from a usage pause via in-process backoff). Find the newest `.weave/cache/chaos/run-*.json` with status `paused_usage` or `running`, ensure `.tickets/STOP` is gone, then `nohup bun .weave/scripts/chaos-supervisor.ts --run <id> > .weave/cache/chaos/supervisor.log 2>&1 &`.

## Operation: `/chaos status`

Read the active run record (`.weave/cache/chaos/run-*.json`): report status, tickets built/skipped, in-flight, usage at last check, and the run-report path `.tickets/chaos-runs/run-<id>.md`.

## The autonomy doctrine (what each worker does)

Every ticket is driven by a fresh `claude -p` following `.weave/templates/chaos-work.md`:
- Drive the `ticket-manager` pipeline refine → pass-2 → build → test → validate, headless.
- On a blocking decision apply the discriminator: **"Could a competent senior engineer pick a defensible answer from the codebase + best practices alone, with no business input?"** YES → spawn 2–3 viewpoint subagents, judge on merit, document, continue. NO → `mark-stuck`, and the supervisor skips to the next ticket.
- Document: routine calls → `### Autonomous Decision` block on the ticket; architectural calls → an ADR (reuse `adr-researcher`/`adr-manager`, link `implements_adr`).
- Complexity 4–5 → bounce back to `0-backlog/` for a human `plan-stack` (chaos builds ≤3 only).

## The scout rotation (self-sustaining work)

When the backlog drains, chaos doesn't stop — it rotates through its **scouts** (config `scouts`, round-robin from a per-run cursor), only finalizing when a *full* rotation turns up nothing:
- **`feature-scout`** — invents new features (generative).
- **`ux-audit`** — reviews the existing app's routing / flow / visual hierarchy / feedback & loading states / animation polish against Nielsen's heuristics and files improvement tickets (optimization). Pure code-read → runs autonomously.
- **`a11y-audit`** — WCAG 2.2 AA gaps; runs the real axe-core/pa11y engine on-demand (with a dev server) or a high-confidence static read inside the loop.

All scouts run **ponytail OFF** (propose boldly) and file `ai-proposed`-tagged backlog tickets that chaos then builds — closing the loop from *find* → *fix*. `bug-scan` can be added to the rotation too. This three-seam mix (corrective / generative / optimization) is what keeps a run from just piling on features; the caps remain the only brakes.

## Architectural coherence (full-stack)

Each worker has fresh context, so architecture is kept coherent by **externalizing** it, not by memory:
- Workers read the architecture surface (ADRs + the `/graphs/schemas` & `/graphs/dataflow` maps + `CLAUDE.md`) and **extend existing contracts** rather than invent parallel ones; new cross-cutting contracts are written back as **ADRs** — the shared spine every future fresh-context worker inherits.
- A full-stack slice's **tightly-coupled layers build together in one ticket** (coherent by construction). A large feature (complexity 4–5) is **decomposed contract-first**: a foundation ticket (shared contract + ADR, tagged `architecture`) that the others `depends_on`, plus loosely-coupled ≤3 pieces — only the irreducibly-coupled-and-large case is punted to a human.
- **Architecture tickets run strictly alone** (the supervisor never co-schedules two contract-establishers), and the validate gate fails on architectural drift.

## Reviewing a run (human, later)

Open `.tickets/chaos-runs/run-<id>.md`: every built ticket sits in `5-validating/` with its decision blocks/ADRs, on a pushed `chaos/TKT-NNN` branch. **Approve by moving a ticket to `6-complete/`** (one at a time on the board, or `/chaos-land` for all) — approved branches merge to main via the reconciler. Anything you don't approve, send back.
