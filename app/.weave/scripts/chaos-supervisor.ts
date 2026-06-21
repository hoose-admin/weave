// chaos mode — the supervisor loop (the driver).
//
// A long-running Bun process that drains the backlog fully autonomously. For
// each eligible ticket it forks a FRESH `claude -p` in its own `chaos/TKT-NNN`
// git worktree (clean context every time; the ticket file is the handoff),
// pins Opus 4.8 / xhigh / a per-ticket budget, and on success commits + pushes
// the branch and lands the ticket in `5-validating/` for human review. It
// NEVER merges to main; approval (a human move to `6-complete/`) merges via the
// reconciler.
//
// Board vs code: the worker's CWD is the worktree (code isolation → the branch
// diff is pure code) but its `WEAVE_TICKETS_ROOT` points at the ROOT repo's
// board, so lifecycle moves are shared (correct picking + live dashboard). The
// worker does NOT commit/push — the supervisor does, after a clean outcome.
//
// Brakes (the ONLY things that stop a self-sustaining run): `.tickets/STOP`,
// the run caps, and the usage throttle (pause at 90% of the 5h window, plus
// reactive backoff on a real rate-limit). Resume is in-process (the supervisor
// is already persistent) — no external scheduler needed.
//
//   bun scripts/chaos-supervisor.ts            # new run
//   bun scripts/chaos-supervisor.ts --run <id> # resume an existing run record
//   bun scripts/chaos-supervisor.ts --dry-run  # simulate (no claude, no git)

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, symlinkSync } from "node:fs";
import { basename, join } from "node:path";

import { REPO_ROOT, TICKETS_ROOT } from "../weave.config.ts";
import { listBucket, moveTicket, readTicket } from "../lib/tickets.ts";
import {
  type ChaosConfig,
  type ChaosRun,
  type ProcessedTicket,
  chaosBranch,
  clearChaosFlag,
  desiredConcurrency,
  loadConfig,
  newRun,
  nowISO,
  readRun,
  readSnapshot,
  stopRequested,
  usagePause,
  worktreePath,
  writeChaosFlag,
  writeRun,
} from "../lib/chaos.ts";
import { pickBatch, type Eligible } from "./chaos-eligible.ts";

const DRY_RUN = process.argv.includes("--dry-run");

// Tools the worker may never use — the supervisor owns commit/push/branch ops,
// and destructive commands are off-limits. The chaos-guard PreToolUse hook is
// the second, repo-wide layer of this same boundary.
const WORKER_DENY = [
  "Bash(rm:*)",
  "Bash(git push:*)",
  "Bash(git commit:*)",
  "Bash(git rm:*)",
  "Bash(git reset:*)",
  "Bash(git checkout:*)",
  "Bash(git switch:*)",
  "Bash(git worktree:*)",
  "Bash(git merge:*)",
  "Bash(git rebase:*)",
  "Bash(npm publish:*)",
];

type Sh = { code: number; stdout: string; stderr: string };

function sh(cmd: string, args: string[], cwd?: string, env?: Record<string, string>): Sh {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function git(args: string[], cwd = REPO_ROOT): Sh {
  return sh("git", ["-C", cwd, ...args]);
}

function log(msg: string): void {
  process.stdout.write(`[chaos] ${msg}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

// ── git / worktree ─────────────────────────────────────────────────────────────

function hasRemote(): boolean {
  return git(["remote", "get-url", "origin"]).code === 0;
}

function compareUrl(branch: string): string | undefined {
  const r = git(["remote", "get-url", "origin"]);
  if (r.code !== 0) return undefined;
  const m = r.stdout.trim().match(/github\.com[:/](.+?)(?:\.git)?$/);
  return m ? `https://github.com/${m[1]}/tree/${branch}` : undefined;
}

function createWorktree(ticketId: string): { path: string; branch: string } | null {
  const path = worktreePath(ticketId);
  const branch = chaosBranch(ticketId);
  if (existsSync(path)) {
    git(["worktree", "remove", "--force", path]); // stale leftover
  }
  // If the branch already exists (a prior interrupted attempt), reuse it.
  const branchExists = git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).code === 0;
  const add = branchExists
    ? git(["worktree", "add", path, branch])
    : git(["worktree", "add", "-b", branch, path]);
  if (add.code !== 0) {
    log(`worktree add failed for ${ticketId}: ${add.stderr.trim()}`);
    return null;
  }
  // Seed top-level node_modules as a symlink so the worktree runs immediately
  // (mirrors wt.sh; cheap and gitignored so it never enters the diff).
  const nm = `${REPO_ROOT}/node_modules`;
  if (existsSync(nm) && !existsSync(`${path}/node_modules`)) {
    try {
      symlinkSync(nm, `${path}/node_modules`);
    } catch {
      /* best-effort */
    }
  }
  return { path, branch };
}

function removeWorktree(path: string): void {
  git(["worktree", "remove", "--force", path]);
}

// ── the worker child ───────────────────────────────────────────────────────────

type WorkerResult = { rateLimited: boolean; code: number };

/** Fork a fresh `claude -p` to drive one ticket through the ticket-manager
 *  pipeline headlessly. Pins model/effort/budget, points the board at root,
 *  turns ponytail ON (build wants lean code). Returns whether it hit a real
 *  rate-limit so the supervisor can back off. */
function workerPrompt(ticketId: string, cfg: ChaosConfig): string {
  // Inject the worker doctrine inline (read from the vendored template, always
  // present at root) so the worker never depends on the worktree having the
  // command/skill committed.
  const tmpl = readFileSync(join(import.meta.dir, "..", "templates", "chaos-work.md"), "utf8");
  return tmpl
    .replace(/\{\{TICKET\}\}/g, ticketId)
    .replace(/\{\{DELIBERATION_CAP\}\}/g, String(cfg.per_ticket_deliberation_cap));
}

async function runWorkerAsync(ticketId: string, worktree: string, cfg: ChaosConfig, runId: string): Promise<WorkerResult> {
  const proc = Bun.spawn(
    [
      "claude",
      "-p",
      workerPrompt(ticketId, cfg),
      "--model",
      cfg.model,
      "--effort",
      cfg.effort,
      "--max-budget-usd",
      String(cfg.max_budget_usd_per_ticket),
      "--permission-mode",
      "acceptEdits",
      "--output-format",
      "json",
      "--disallowedTools",
      WORKER_DENY.join(" "),
    ],
    {
      cwd: worktree,
      env: {
        ...process.env,
        WEAVE_TICKETS_ROOT: TICKETS_ROOT,
        WEAVE_REPO_ROOT: REPO_ROOT,
        PONYTAIL_DEFAULT_MODE: "full", // build child: ponytail ON
        CHAOS_RUN_ID: runId,
        CHAOS_ACTIVE: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  const blob = (out + err).toLowerCase();
  const rateLimited =
    /rate.?limit|usage limit|429|quota (exceeded|reached)/.test(blob) ||
    /\b5-?hour\b.*\b(limit|reached)\b/.test(blob);
  return { rateLimited, code: proc.exitCode ?? 1 };
}

/** When the backlog runs dry, invent more work. Runs `feature-scout` at the
 *  repo root with ponytail OFF (ideation diverges; minimalism is for build
 *  time) — the creative half of the self-sustaining loop. */
function runFeatureScout(cap: number, runId: string, cfg: ChaosConfig): void {
  sh(
    "claude",
    [
      "-p",
      `/feature-scout ${cap}`,
      "--model",
      cfg.model,
      "--effort",
      cfg.effort,
      "--max-budget-usd",
      String(cfg.max_budget_usd_per_ticket),
      "--permission-mode",
      "acceptEdits",
      "--disallowedTools",
      WORKER_DENY.join(" "),
    ],
    REPO_ROOT, // feature-scout files backlog tickets at root; no worktree needed
    {
      WEAVE_TICKETS_ROOT: TICKETS_ROOT,
      WEAVE_REPO_ROOT: REPO_ROOT,
      PONYTAIL_DEFAULT_MODE: "off", // ideation: ponytail OFF — diverge boldly
      CHAOS_RUN_ID: runId,
      CHAOS_ACTIVE: "1",
    },
  );
}

// ── outcome + landing ───────────────────────────────────────────────────────────

async function stuckReason(ticketId: string): Promise<string> {
  const t = await readTicket(ticketId);
  if (!t) return "";
  const m = t.body.match(/###\s+Stuck Reason[\s\S]*?\n((?:[-*].*\n?)+)/);
  return m ? m[1].split("\n").map((l) => l.replace(/^[-*]\s*/, "").trim()).filter(Boolean)[0] ?? "" : "";
}

/** Inspect the ROOT board to see where the worker left the ticket, then land
 *  the result: commit + push on success, reset on interruption. */
async function settle(
  ticketId: string,
  title: string,
  wt: { path: string; branch: string } | null,
  cfg: ChaosConfig,
): Promise<ProcessedTicket> {
  const full = await readTicket(ticketId);
  const bucket = full?.bucket;
  const base: ProcessedTicket = {
    id: ticketId,
    title,
    outcome: "error",
    decisions: [],
    ended: nowISO(),
    ai_proposed: full?.tags.includes("ai-proposed") ?? false,
  };

  if (bucket === "5-validating") {
    // success — commit the worktree's code to the branch, push, keep branch
    if (wt && !DRY_RUN) {
      git(["add", "-A"], wt.path);
      const c = git(["commit", "-m", `chaos: ${ticketId} ${title}`.slice(0, 100)], wt.path);
      if (c.code === 0 && cfg.push_to_remote && hasRemote()) {
        const p = git(["push", "-u", "origin", wt.branch], wt.path);
        if (p.code !== 0) log(`push failed for ${wt.branch}: ${p.stderr.trim()}`);
      }
    }
    base.outcome = "validating";
    base.branch = wt?.branch;
    base.compare_url = wt ? compareUrl(wt.branch) : undefined;
    return base;
  }

  if (bucket === "2-stuck") {
    base.outcome = "stuck";
    base.skip_reason = (await stuckReason(ticketId)) || "blocked (see Stuck Reason)";
    return base;
  }

  // anything else (still mid-pipeline / error): reset so it can be retried, and
  // record an error outcome.
  base.outcome = "error";
  base.skip_reason = bucket ? `left in ${bucket}` : "ticket vanished";
  if (bucket && bucket !== "0-backlog" && !DRY_RUN) {
    try {
      await moveTicket(ticketId, "0-backlog");
    } catch {
      /* best-effort reset */
    }
  }
  return base;
}

type Settled = { processed: ProcessedTicket; rateLimited: boolean };

/** Run one ticket to completion as a single awaitable unit (worktree → worker →
 *  settle → cleanup), so the loop can keep several in flight at once. In dry-run
 *  it simulates a successful build. */
async function launchWorker(next: Eligible, runId: string, cfg: ChaosConfig): Promise<Settled> {
  const err = (skip_reason: string, rateLimited = false): Settled => ({
    processed: { id: next.id, title: next.title, outcome: "error", decisions: [], skip_reason, ended: nowISO() },
    rateLimited,
  });

  if (DRY_RUN) {
    try {
      await moveTicket(next.id, "5-validating"); // simulate a successful build
    } catch {
      /* fixture may not allow the move */
    }
    return { processed: await settle(next.id, next.title, null, cfg), rateLimited: false };
  }

  const wt = createWorktree(next.id);
  if (!wt) return err("worktree creation failed");

  const res = await runWorkerAsync(next.id, wt.path, cfg, runId);
  if (res.rateLimited) {
    removeWorktree(wt.path);
    return err("interrupted by rate-limit", true);
  }
  const processed = await settle(next.id, next.title, wt, cfg);
  removeWorktree(wt.path); // success keeps the branch; the dir is disposable
  return { processed, rateLimited: false };
}

// ── the loop ─────────────────────────────────────────────────────────────────

async function finalize(run: ChaosRun, status: ChaosRun["status"], reason: string): Promise<void> {
  run.status = status;
  run.stop_reason = reason;
  run.ended = nowISO();
  run.usage_end = readSnapshot();
  run.in_flight = [];
  writeRun(run);
  if (status !== "paused_usage") clearChaosFlag();
  log(`run ${run.id} → ${status}: ${reason}`);
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const resumeId = (() => {
    const i = process.argv.indexOf("--run");
    return i >= 0 ? process.argv[i + 1] : undefined;
  })();

  const run: ChaosRun = (resumeId && readRun(resumeId)) || newRun(cfg);
  run.status = "running";
  writeChaosFlag(run.id);
  writeRun(run);
  log(`run ${run.id} started (dry-run=${DRY_RUN}, cwd-root=${basename(REPO_ROOT)})`);

  const startMs = Date.parse(run.started);
  const attempts = new Map<string, number>();
  const MAX_ATTEMPTS = 2;
  let backoffMin = 20;

  // Adaptive worker pool: ticketId → its running launchWorker promise. The pool
  // size is `desiredConcurrency` (usage-driven); at conc=1 this IS the serial
  // loop. Terminal conditions only fire once the pool has drained, so a running
  // worker is never abandoned.
  const active = new Map<string, Promise<Settled>>();
  const archInFlight = new Set<string>(); // architecture/contract tickets run strictly alone
  let ratePaused = false; // a worker reported a real rate-limit

  const builtCount = () => run.processed.filter((p) => p.outcome === "validating").length;
  const capsHit = () =>
    builtCount() >= cfg.max_tickets || Date.now() - startMs > cfg.max_wall_clock_min * 60_000;

  while (true) {
    const stopping = stopRequested();

    if (active.size === 0) {
      if (stopping) return finalize(run, "halted", ".tickets/STOP present");
      if (builtCount() >= cfg.max_tickets) return finalize(run, "complete", `max_tickets (${cfg.max_tickets}) reached`);
      if (Date.now() - startMs > cfg.max_wall_clock_min * 60_000)
        return finalize(run, "complete", `max_wall_clock (${cfg.max_wall_clock_min}m) reached`);
    }

    const snap = readSnapshot();
    const pause = usagePause(snap, cfg);
    // desired concurrency, clamped to 0 whenever we should stop launching new work
    let conc = desiredConcurrency(snap, cfg);
    if (stopping || capsHit() || ratePaused || pause.paused) conc = 0;

    // Usage pause / backoff — only when idle, so in-flight workers finish first.
    // (Stop/caps are handled by the terminal checks above; reaching here with
    // conc 0 and an empty pool means a genuine usage pause.)
    if (conc === 0 && active.size === 0) {
      const reason = pause.reason || (ratePaused ? "rate-limit hit" : "usage at ceiling");
      log(`paused: ${reason} — backing off ${backoffMin}m`);
      run.status = "paused_usage";
      writeRun(run);
      await sleep(backoffMin * 60_000);
      backoffMin = Math.min(backoffMin * 2, 300); // cap near the 5h window
      ratePaused = false;
      run.status = "running";
      writeRun(run);
      continue;
    }

    // Top up the pool toward `conc` with distinct, dependency-safe tickets.
    // Architecture/contract tickets run STRICTLY ALONE so two contract-
    // establishers never drift in parallel: don't add anything while one is in
    // flight, and don't start one alongside other running work.
    while (active.size < conc && archInFlight.size === 0) {
      const [next] = await pickBatch(new Set(active.keys()), 1);
      if (!next) break;
      const n = (attempts.get(next.id) ?? 0) + 1;
      attempts.set(next.id, n);
      if (n > MAX_ATTEMPTS) {
        run.processed.push({ id: next.id, title: next.title, outcome: "error", decisions: [], skip_reason: `gave up after ${MAX_ATTEMPTS} attempts`, ended: nowISO() });
        if (!DRY_RUN) { try { await moveTicket(next.id, "2-stuck"); } catch {} }
        writeRun(run);
        continue;
      }
      const isArch = next.tags.includes("architecture");
      if (isArch && active.size > 0) {
        attempts.set(next.id, n - 1); // deferred, not a real attempt — wait for the pool to drain
        break;
      }
      log(`▶ ${next.id}${isArch ? " [architecture — solo]" : ""} (attempt ${n}) — ${next.title}`);
      active.set(next.id, launchWorker(next, run.id, cfg));
      backoffMin = 20; // we're moving again
      if (isArch) {
        archInFlight.add(next.id);
        break; // nothing else runs alongside an architecture ticket
      }
    }
    run.in_flight = [...active.keys()];
    writeRun(run);

    // Nothing running and nothing launchable → backlog dry.
    if (active.size === 0) {
      if (cfg.generate_when_dry && run.generated_features < cfg.max_generated_features && !DRY_RUN && conc > 0) {
        const remaining = cfg.max_generated_features - run.generated_features;
        const before = (await listBucket("0-backlog")).length;
        log(`backlog dry — feature-scout inventing up to ${remaining} (ponytail OFF)`);
        runFeatureScout(remaining, run.id, cfg);
        const added = Math.max(0, (await listBucket("0-backlog")).length - before);
        if (added === 0) return finalize(run, "complete", "backlog drained — feature-scout saturated (nothing new)");
        run.generated_features += added;
        writeRun(run);
        log(`feature-scout filed ${added} new ticket(s)`);
        continue;
      }
      const why =
        cfg.generate_when_dry && run.generated_features >= cfg.max_generated_features
          ? `backlog drained — max_generated_features (${cfg.max_generated_features}) reached`
          : "backlog drained (no eligible tickets)";
      return finalize(run, "complete", why);
    }

    // Wait for the next worker to finish, record it, and loop to top up.
    const settled = await Promise.race(active.values());
    active.delete(settled.processed.id);
    archInFlight.delete(settled.processed.id);
    if (settled.rateLimited) {
      const a = attempts.get(settled.processed.id) ?? 1;
      attempts.set(settled.processed.id, a - 1); // a rate-limit doesn't count against the ticket
      ratePaused = true;
      log(`${settled.processed.id} hit a rate-limit — draining in-flight, then backing off`);
    } else {
      run.processed.push(settled.processed);
      log(`✔ ${settled.processed.id} → ${settled.processed.outcome}${settled.processed.branch ? ` (${settled.processed.branch})` : ""}`);
    }
    run.in_flight = [...active.keys()];
    writeRun(run);
  }
}

await main();
