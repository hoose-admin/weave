---
allowed-tools: Bash(bun .weave/scripts/smoke.ts:*), Bash(bun run smoke:*), Read, Glob
description: Run the deterministic headless-browser smoke check on the project's web app — fails on console errors / uncaught exceptions / stuck spinners
---

Run weave's headless-browser **smoke** check (see the `smoke` skill).

1. Run `bun .weave/scripts/smoke.ts --ticket $ARGUMENTS` (omit `--ticket` if `$ARGUMENTS` is empty — artifacts then land under `.weave/cache/smoke/adhoc/`).
2. Read the `SmokeResult` JSON from stdout. Report, per route: pass/fail, the **verbatim** console errors, page errors, failed requests, and the screenshot path under `.weave/cache/smoke/<ticket>/`.
3. If `status` is `skipped`, say why (no `smoke` block in `weave.config.json`, browsers not provisioned → `cd .weave && bun run install:browsers`, or driver absent) — a skip is **not** a pass. If `fail`/`error`, surface the failing route + console errors prominently.

This is read-only verification — it boots the app on a free port and tears it down; it does not edit code or move tickets.
