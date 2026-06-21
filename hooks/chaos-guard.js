#!/usr/bin/env node
// chaos mode — PreToolUse safety guard.
//
// While a chaos run is active (the `.chaos-active` flag exists), this denies a
// small set of IRREVERSIBLE git-history and data-destruction commands at the
// tool boundary — the failure mode autonomous agents are known for (wiped DBs,
// force-pushed history). It is the repo-wide, defense-in-depth layer beneath
// the per-child `--disallowedTools` the supervisor already passes.
//
// Deliberately NARROW and high-signal: it is a backstop, not a sandbox. It must
// not block legitimate build/test/diff work, so it only denies things that are
// catastrophic and never part of chaos's job (chaos pushes only `chaos/*`
// branches and never merges/force-pushes; the supervisor — not a Claude
// session, so unaffected by this hook — owns all commits/pushes/merges).
//
// Wired as a PreToolUse hook (matcher: Bash). Inert unless chaos is active.

const fs = require("fs");
const os = require("os");
const path = require("path");

function claudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

function chaosActive() {
  return fs.existsSync(path.join(claudeDir(), ".chaos-active"));
}

// [pattern, reason]. Matched against the Bash command string.
const DENY = [
  [/\bgit\s+push\b[^\n]*(--force\b|--force-with-lease\b|(?:^|\s)-f\b)/, "force-push rewrites shared history"],
  [/\bgit\s+push\b[^\n]*\b(origin\s+)?(main|master|HEAD)\b/, "chaos never pushes the default branch — it works on chaos/* branches only"],
  [/\bgit\s+push\b[^\n]*(--delete\b|\s:\S)/, "deleting a remote branch is irreversible"],
  [/\bgit\s+branch\b[^\n]*\s-(D|d)\b/, "deleting a branch is irreversible"],
  [/\bgit\s+reset\b[^\n]*--hard\b/, "git reset --hard discards work irreversibly"],
  [/\bgit\s+(checkout|switch)\b[^\n]*\b(main|master)\b/, "chaos must not switch onto the default branch"],
  [/\b(drop\s+database|dropdb\b|drop\s+table|truncate\s+table)\b/i, "destructive database operation"],
  [/\bterraform\s+destroy\b/i, "terraform destroy tears down infrastructure"],
  [/\bkubectl\s+delete\b/i, "kubectl delete removes live resources"],
];

let raw = "";
try {
  raw = fs.readFileSync(0, "utf8");
} catch {
  process.exit(0); // no input → nothing to guard
}

if (!chaosActive()) process.exit(0);

let data;
try {
  data = JSON.parse(raw);
} catch {
  process.exit(0);
}

const tool = data.tool_name || data.toolName || "";
if (tool !== "Bash") process.exit(0);

const cmd = String(data.tool_input?.command ?? data.toolInput?.command ?? "");
for (const [re, reason] of DENY) {
  if (re.test(cmd)) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: `chaos-guard: blocked — ${reason}. (Chaos works on chaos/* branches and lands in 5-validating; the supervisor handles commits/pushes.)`,
        },
      }),
    );
    process.exit(0);
  }
}

process.exit(0);
