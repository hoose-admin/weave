---
allowed-tools: Bash(bun .weave/scripts/chaos-merge.ts:*), Bash(git status:*), Bash(git log:*), Bash(mv:*), Read, Edit, Glob, Grep, LS
description: Approve & land chaos work — move validating tickets to complete, then merge their chaos/* branches to main
---

Land approved chaos work. Two steps:

1. **Bulk-approve: move tickets from `5-validating/` to `6-complete/`.**
   - If `$ARGUMENTS` names specific tickets, move only those.
   - Otherwise move **all** of `.tickets/5-validating/` → `.tickets/6-complete/` (the user is approving the whole review queue). For each: `mv` the file and set `status: "Complete"` + `completed:` today's date in the frontmatter (the `move-ticket` op already does this — use it).

2. **Merge the approved branches:** run

   ```bash
   bun .weave/scripts/chaos-merge.ts reconcile
   ```

   It merges every approved `chaos/*` branch into the default branch inside a dedicated worktree (so the dashboard's working tree is untouched), stamps `merged:` + `merge_commit:` on each ticket, pushes, and flags any conflict with `merge_conflict: true` (exit code 3) for you to resolve by hand.

Report what merged, what conflicted (resolve manually: `git checkout <target> && git merge chaos/TKT-NNN`), and what was skipped. **Never** force-merge or blind-resolve a conflict. Only `chaos/*` branches are ever touched.
