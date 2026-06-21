#!/usr/bin/env bash
# weave setup — vendor the local ticket dashboard + Claude Code skills into a
# target repo, scaffold the board, build the codebase graphs, and (after asking)
# run a deep bug-scan that seeds the backlog with real findings from your code.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PORT=5174
PORT_SET=0
DO_SCAN=1
ASSUME_YES=0
DO_START=0
DO_GITPERMS=0
TARGET=""

usage() {
  cat <<'EOF'
weave setup — install the weave ticket board + skills into a repo.

usage: bash setup.sh [TARGET_REPO] [options]

  TARGET_REPO   path to the repo to weave-enable (default: current directory)

options:
  --scan        run the deep bug-scan without prompting (non-interactive use)
  --no-scan     skip the bug-scan entirely, no prompt
                (default: ASK whether to run the deep bug-scan)
  --start       start the dashboard when setup finishes
  --port N      dashboard port (default: 5174)
  --git-perms   merge weave's git allowlist (commit/push/branch/worktree) into
                .claude/settings.json — off by default so setup never silently
                widens your permissions
  -h, --help    show this help
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --no-scan)   DO_SCAN=0 ;;
    --scan)      ASSUME_YES=1 ;;
    --start)     DO_START=1 ;;
    --git-perms) DO_GITPERMS=1 ;;
    --port)    PORT="${2:?--port needs a value}"; PORT_SET=1; shift ;;
    -h|--help) usage; exit 0 ;;
    -*)        echo "unknown option: $1" >&2; usage; exit 2 ;;
    *)         if [ -z "$TARGET" ]; then TARGET="$1"; else echo "unexpected arg: $1" >&2; exit 2; fi ;;
  esac
  shift
done

TARGET="${TARGET:-$PWD}"
TARGET="$(cd "$TARGET" 2>/dev/null && pwd || true)"
[ -n "$TARGET" ] || { echo "✗ target repo not found" >&2; exit 1; }

# ── preflight ────────────────────────────────────────────────────────────────
command -v bun >/dev/null 2>&1 || { echo "✗ bun is required — install from https://bun.sh" >&2; exit 1; }
command -v git >/dev/null 2>&1 || echo "⚠ git not found — weave works without it, but version control is recommended"
HAVE_CLAUDE=0; command -v claude >/dev/null 2>&1 && HAVE_CLAUDE=1

if [ "$TARGET" = "$SCRIPT_DIR" ]; then
  echo "✗ target is the weave repo itself — pass the path to the repo you want to weave-enable" >&2
  exit 1
fi

echo "→ weave setup"
echo "    weave:  $SCRIPT_DIR"
echo "    target: $TARGET"
echo "    port:   $PORT"

# ── 1. vendor the dashboard app ──────────────────────────────────────────────
echo "→ vendoring dashboard into $TARGET/.weave"
mkdir -p "$TARGET/.weave"
rsync -a --exclude 'cache' --exclude 'node_modules' "$SCRIPT_DIR/app/.weave/" "$TARGET/.weave/"

# ── 2. install skills + hooks, merge settings (upgrade-safe) ─────────────────
#    install-payload.ts records every file weave writes in .weave/install-manifest.json,
#    so a re-run can tell its own stale copy from YOUR customization: new files install,
#    untouched ones update, customized ones are KEPT (weave's copy staged as *.weave-incoming).
#    No blind overwrite, no reliance on you having committed .claude/ first.
echo "→ installing skills + hooks + commands into $TARGET/.claude (upgrade-safe)"
mkdir -p "$TARGET/.claude/skills" "$TARGET/.claude/hooks" "$TARGET/.claude/commands"
bun "$SCRIPT_DIR/scripts/install-payload.ts" "$SCRIPT_DIR" "$TARGET"
PERMS_FLAG=""
[ "$DO_GITPERMS" = 1 ] && PERMS_FLAG="--git-perms"
bun "$SCRIPT_DIR/scripts/merge-settings.ts" "$SCRIPT_DIR/settings.template.json" "$TARGET/.claude/settings.json" $PERMS_FLAG

# ── 3. scaffold the .tickets board ───────────────────────────────────────────
echo "→ scaffolding .tickets board (9 buckets + ADRs)"
for b in scratch 0-backlog 1-staging 2-stuck 3-building 4-testing 5-validating 6-complete 7-archive ADRs chaos-runs; do
  mkdir -p "$TARGET/.tickets/$b"
  [ -e "$TARGET/.tickets/$b/.gitkeep" ] || : > "$TARGET/.tickets/$b/.gitkeep"
done

# ── 4. config + starter CLAUDE.md ────────────────────────────────────────────
if [ ! -e "$TARGET/weave.config.json" ]; then
  printf '{\n  "repoRoot": ".",\n  "ticketsRoot": ".tickets",\n  "port": %s\n}\n' "$PORT" > "$TARGET/weave.config.json"
  echo "→ wrote weave.config.json"
elif [ "$PORT_SET" = 1 ]; then
  echo "⚠ weave.config.json already exists — leaving it untouched; edit its \"port\" by hand to make --port $PORT stick for 'bun run start'"
fi
if [ ! -e "$TARGET/CLAUDE.md" ]; then
  cp "$SCRIPT_DIR/CLAUDE.template.md" "$TARGET/CLAUDE.md"
  echo "→ wrote CLAUDE.md (starter — customize it for your project)"
else
  echo "⚠ CLAUDE.md already exists — review $SCRIPT_DIR/CLAUDE.template.md for weave conventions to fold in"
fi

# ── 5. build the dashboard graphs (deterministic — no Claude Code needed) ─────
echo "→ building dashboard graphs"
( cd "$TARGET/.weave" && bun run build:graphs ) \
  || echo "⚠ graph build hit an error — the dashboard will build graphs on demand instead"

# ── 6. first-run bug-scan (seeds the backlog with REAL findings from your code) ──
#    The deep, multi-agent scan. OPTIONAL but recommended; it can take several
#    minutes and a meaningful number of Claude tokens — so we ASK first (unless
#    --scan / --no-scan force it) rather than silently running or skipping it.
#    (dataflow + schemas graphs are deterministic — already built in step 5.)
run_bug_scan() {
  echo "  → seeding the backlog: /bug-scan (deep multi-agent scan)…"
  if ( cd "$TARGET" && claude -p "/bug-scan" --permission-mode acceptEdits ); then
    echo "  ✓ bug-scan done — open the board to see the findings"
  else
    echo "  ⚠ headless /bug-scan didn't fully complete — run it interactively: open Claude Code in the repo and run /bug-scan"
  fi
}
if [ "$HAVE_CLAUDE" = 1 ] && [ "$DO_SCAN" = 1 ]; then
  cat <<'EOF'

──────────────────────────────────────────────────────────────────────
  Optional: seed your board with a DEEP BUG-SCAN
  weave can fan a multi-agent scan across your code, adversarially verify
  each finding, and file the real bugs as backlog tickets — so the board
  starts with genuine findings, not demo data.
    • Optional, but recommended for a useful first board.
    • Multi-agent: can take several minutes and uses Claude tokens.
    • Always available later in Claude Code:   /bug-scan
──────────────────────────────────────────────────────────────────────
EOF
  if [ "$ASSUME_YES" = 1 ]; then
    echo "  (--scan given — running without prompting)"
    run_bug_scan
  elif [ -t 0 ]; then
    printf "  Run the deep bug-scan now? [y/N] "
    _ans=""; read -r _ans || true
    case "$_ans" in
      [yY]|[yY][eE][sS]) run_bug_scan ;;
      *) echo "  ↳ skipped — run it anytime in Claude Code:  /bug-scan" ;;
    esac
  else
    echo "  (non-interactive shell — not prompting. Re-run with --scan, or use /bug-scan in Claude Code.)"
  fi
elif [ "$DO_SCAN" = 0 ]; then
  echo "→ bug-scan skipped (--no-scan). Run it anytime in Claude Code:  /bug-scan"
else
  echo "→ Claude Code not found — skipping bug-scan. Install Claude Code, then run /bug-scan in the repo to seed the backlog."
fi

# ── done ─────────────────────────────────────────────────────────────────────
cat <<EOF

✓ weave installed into $TARGET

  start the board:  cd "$TARGET/.weave" && bun run start
  then open:        http://127.0.0.1:$PORT

  parallel claude sessions (so concurrent terminals can't clobber each other):
    source "$TARGET/.weave/wt.sh"   # add this line to ~/.zshrc to keep it
    wt <name>                       # isolated worktree on branch wt/<name>, then claude
    wt ls / wt rm <name>            # list / remove worktrees
EOF
if [ "$DO_GITPERMS" = 1 ]; then
  echo "  (weave granted claude git push/branch/commit/worktree perms — see .claude/settings.json.)"
else
  echo "  (git perms NOT granted — re-run with --git-perms to let wt sessions push unprompted.)"
fi

cat <<'EOF'

  chaos mode — fully-autonomous ticket execution (Claude Max only):
    /chaos          arm a run (requires an explicit "arm chaos" confirm; --git-perms lets it push branches)
    /chaos status   inspect the active run    ·    /chaos stop   halt it
    /chaos-land     merge approved (6-complete) chaos branches to main
  The usage throttle reads your statusline — /chaos offers to wire the snapshot tee (reversible).
EOF
# (bug-scan prompt + messaging handled in step 6 above)

if [ "$DO_START" = 1 ]; then
  echo "→ starting dashboard…"
  exec bash -c "cd '$TARGET/.weave' && PORT='$PORT' bun run start"
fi
