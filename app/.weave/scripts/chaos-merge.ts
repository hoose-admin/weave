// chaos mode — merge reconciler CLI.
//
//   bun scripts/chaos-merge.ts pending     # list approved-but-unmerged chaos tickets
//   bun scripts/chaos-merge.ts reconcile   # merge them all into the target branch
//
// Invoked by the `/chaos-land` command, the ticket-manager move-ticket
// post-step, and (programmatically) the dashboard server. Exit 3 signals
// unresolved merge conflicts.

import { pendingMerges, reconcile } from "../lib/chaos-merge.ts";

const cmd = process.argv[2] ?? "reconcile";

if (cmd === "pending") {
  const p = await pendingMerges();
  if (p.length === 0) process.stdout.write("(no pending merges)\n");
  else for (const m of p) process.stdout.write(`${m.id}\t${m.branch}\n`);
} else if (cmd === "reconcile") {
  const r = await reconcile();
  process.stdout.write(`target:    ${r.target}\n`);
  process.stdout.write(`merged:    ${r.merged.map((m) => `${m.id}(${m.commit})`).join(", ") || "none"}\n`);
  process.stdout.write(`conflicts: ${r.conflicts.map((m) => m.id).join(", ") || "none"}\n`);
  process.stdout.write(`skipped:   ${r.skipped.map((m) => `${m.id} (${m.detail})`).join(", ") || "none"}\n`);
  if (r.note) process.stdout.write(`note:      ${r.note}\n`);
  if (r.conflicts.length > 0) process.exit(3);
} else {
  process.stderr.write("usage: bun scripts/chaos-merge.ts [reconcile|pending]\n");
  process.exit(2);
}
