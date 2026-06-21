// chaos mode — merge reconciler (the validating → complete → main loop).
//
// Chaos leaves each ticket in `5-validating/` on a pushed `chaos/TKT-NNN`
// branch. APPROVAL = a human moving the ticket to `6-complete/`. Landing
// approved branches on main is a DETERMINISTIC, IDEMPOTENT reconciler — not a
// Claude "hook": Claude hooks fire on Claude's tool calls, so they can't see a
// dashboard drag. So this lives in shared code invoked from every place a move
// can happen — the `/chaos-land` command, the `ticket-manager` move-ticket
// post-step, and the dashboard server's move-to-complete handler.
//
// Work set = tickets in `6-complete/`/`7-archive/` with `chaos_branch` set and
// no `merged` stamp. Being state-based, it inherently "only merges what moved".
//
// Safety: only `chaos/*` branches are ever merged; merges run in a DEDICATED
// worktree on the target branch so they never disturb the dashboard's working
// tree; conflicts are aborted + flagged (`merge_conflict: true`), never guessed.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

import { REPO_ROOT } from "../weave.config.ts";
import { listBucket, readTicket, today, writeTicket, type Bucket } from "./tickets.ts";
import { loadConfig, mergeWorktreePath, type ChaosConfig } from "./chaos.ts";

type Sh = { code: number; stdout: string; stderr: string };

function git(args: string[], cwd = REPO_ROOT): Sh {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function hasRemote(): boolean {
  return git(["remote", "get-url", "origin"]).code === 0;
}

/** The branch approved work merges into: config override, else the remote's
 *  default branch, else main/master. */
function mergeTarget(cfg: ChaosConfig): string {
  if (cfg.merge_target) return cfg.merge_target;
  const sym = git(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (sym.code === 0 && sym.stdout.trim()) return sym.stdout.trim().replace(/^origin\//, "");
  for (const b of ["main", "master"]) {
    if (git(["rev-parse", "--verify", "--quiet", b]).code === 0) return b;
  }
  return "main";
}

export type PendingMerge = { id: string; branch: string; depends_on: string[] };

const MERGE_BUCKETS: Bucket[] = ["6-complete", "7-archive"];

/** Approved (complete/archived) chaos tickets not yet merged. */
export async function pendingMerges(): Promise<PendingMerge[]> {
  const out: PendingMerge[] = [];
  for (const bucket of MERGE_BUCKETS) {
    for (const t of await listBucket(bucket)) {
      const full = await readTicket(t.id);
      if (!full) continue;
      const branch = typeof full.frontmatter.chaos_branch === "string" ? full.frontmatter.chaos_branch : "";
      if (!branch || !branch.startsWith("chaos/")) continue; // only ever chaos/* branches
      if (full.frontmatter.merged) continue;
      out.push({ id: t.id, branch, depends_on: t.depends_on });
    }
  }
  return out;
}

/** Merge prerequisites before dependents (deps usually merged already; this
 *  just keeps a same-batch dependent from landing first). */
function topoOrder(pend: PendingMerge[]): PendingMerge[] {
  const ids = new Set(pend.map((p) => p.id));
  const done = new Set<string>();
  const remaining = [...pend];
  const out: PendingMerge[] = [];
  let progress = true;
  while (remaining.length && progress) {
    progress = false;
    for (let i = 0; i < remaining.length; ) {
      const p = remaining[i];
      const blocked = p.depends_on.some((d) => ids.has(d) && !done.has(d));
      if (!blocked) {
        out.push(p);
        done.add(p.id);
        remaining.splice(i, 1);
        progress = true;
      } else i++;
    }
  }
  return out.concat(remaining); // any cycle: append in place
}

export type MergeStatus = "merged" | "conflict" | "skipped" | "error";
export type MergeResult = { id: string; branch: string; status: MergeStatus; detail?: string; commit?: string };

async function stamp(id: string, fields: Record<string, string>, drop: string[] = []): Promise<void> {
  const full = await readTicket(id);
  if (!full) return;
  for (const [k, v] of Object.entries(fields)) full.frontmatter[k] = v;
  for (const k of drop) delete full.frontmatter[k];
  await writeTicket(id, full.frontmatter, full.body);
}

function mergeOne(pm: PendingMerge, wt: string): MergeResult {
  if (git(["rev-parse", "--verify", "--quiet", pm.branch]).code !== 0) {
    return { id: pm.id, branch: pm.branch, status: "skipped", detail: "branch not found" };
  }
  const m = git(["merge", "--no-ff", "-m", `chaos: land ${pm.id} (${pm.branch})`, pm.branch], wt);
  if (m.code !== 0) {
    git(["merge", "--abort"], wt);
    return { id: pm.id, branch: pm.branch, status: "conflict", detail: "merge conflict — needs manual resolution" };
  }
  const sha = git(["rev-parse", "HEAD"], wt).stdout.trim().slice(0, 12);
  return { id: pm.id, branch: pm.branch, status: "merged", commit: sha };
}

export type ReconcileReport = {
  target: string;
  merged: MergeResult[];
  conflicts: MergeResult[];
  skipped: MergeResult[];
  errors: MergeResult[];
  note?: string;
};

/** Merge every approved-but-unmerged chaos branch into the target, in a
 *  dedicated worktree. Idempotent: a second call with nothing pending is a
 *  no-op. Conflicts are flagged on the ticket and left for a human. */
export async function reconcile(): Promise<ReconcileReport> {
  const cfg = loadConfig();
  const target = mergeTarget(cfg);
  const base: ReconcileReport = { target, merged: [], conflicts: [], skipped: [], errors: [] };

  const pend = topoOrder(await pendingMerges());
  if (pend.length === 0) return { ...base, note: "nothing to merge" };

  const remote = hasRemote();
  const rootBranch = git(["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();

  // DETACHED worktree at the target commit — works even when `target` is
  // checked out at the repo root (the common "land while sitting on main"
  // case). We merge here, then advance the real branch separately.
  const wt = mergeWorktreePath();
  if (existsSync(wt)) git(["worktree", "remove", "--force", wt]);
  const add = git(["worktree", "add", "--detach", wt, target]);
  if (add.code !== 0) return { ...base, note: `could not create merge worktree at ${target}: ${add.stderr.trim()}` };

  const results: MergeResult[] = [];
  for (const pm of pend) {
    const r = mergeOne(pm, wt);
    results.push(r);
    if (r.status === "merged") await stamp(r.id, { merged: today(), merge_commit: r.commit ?? "" }, ["merge_conflict"]);
    else if (r.status === "conflict") await stamp(r.id, { merge_conflict: "true" });
  }

  let note: string | undefined;
  if (results.some((r) => r.status === "merged")) {
    const newHead = git(["rev-parse", "HEAD"], wt).stdout.trim();
    if (remote && cfg.push_to_remote) {
      const p = git(["push", "origin", `HEAD:${target}`], wt);
      if (p.code !== 0) note = `merged but push to origin/${target} failed: ${p.stderr.trim()}`;
    }
    // advance the local target branch
    if (rootBranch === target) {
      // root is sitting on the target — fast-forward its checkout to the merge
      const ff = git(["merge", "--ff-only", newHead]);
      if (ff.code !== 0) note = (note ? note + "; " : "") + `local ${target} not fast-forwarded (working tree busy) — \`git pull\` to update`;
    } else {
      git(["branch", "-f", target, newHead]); // target not checked out → safe ref advance
    }
    if (cfg.delete_branch_after_merge) {
      for (const r of results) if (r.status === "merged") git(["branch", "-D", r.branch]);
    }
  }
  git(["worktree", "remove", "--force", wt]);

  return {
    target,
    merged: results.filter((r) => r.status === "merged"),
    conflicts: results.filter((r) => r.status === "conflict"),
    skipped: results.filter((r) => r.status === "skipped"),
    errors: results.filter((r) => r.status === "error"),
    note,
  };
}
