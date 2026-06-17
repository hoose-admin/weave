// Fallback live-status detection for terminal tabs.
//
// The dashboard's primary source of "what is this session doing" is the
// weave_terminal_live.ts hook (state + summary written to cache/terminals/live/). This
// module is the FALLBACK for terminals with no hook data — a plain shell, or a
// `claude` started before the hook env was set. weave knows each session's tmux
// name, so it reads the screen with `tmux capture-pane` and infers a coarse
// state (working / attention / idle) with a local heuristic. No data leaves the
// machine and there is no API call.
//
// State detection is tuned to Claude Code's current TUI; the marker lists below
// are the single place to adjust if that UI changes.

export type TermState = "working" | "attention" | "idle";

// ── Pane capture ────────────────────────────────────────────────────────────

// Capture the VISIBLE pane only (no scrollback). The current state lives on the
// screen — Claude's "esc to interrupt" / permission prompt are shown while
// active and gone once done — so visible-only avoids stale history (e.g. an
// answered prompt still in scrollback) reading as a live state.
export async function capturePane(session: string): Promise<string> {
  try {
    const p = Bun.spawn(["tmux", "capture-pane", "-p", "-t", session], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(p.stdout).text();
    await p.exited;
    return text;
  } catch {
    return "";
  }
}

// ── State heuristic ─────────────────────────────────────────────────────────

// "working": Claude is actively generating. Two TUI generations need covering:
//   • Older builds show an "esc to interrupt" hint for the whole turn.
//   • v2.x shows an animated status line — a spinner glyph + gerund + ellipsis,
//     e.g. "· Orbiting…" / "✢ Cooking…" (both the glyph and the verb cycle).
// The ellipsis is the load-bearing signal: it is present only while a turn is in
// flight. We still must NOT key off the glyph or verb alone — Claude leaves
// those in *completed* summary lines ("✻ Cooked for 26s", "✻ Churned for 1m
// 43s") — but those read "<glyph> <verb> for <duration>" with no trailing
// ellipsis, so requiring the "…" cleanly separates an in-flight turn from a
// finished one (verified frame-by-frame against a real v2.1.173 session).
const WORKING_MARKERS: RegExp[] = [
  /esc to interrupt/i,
  /[·✢✳✶✻✺✹✸✷✽❋＊*]\s+\p{L}+…/u,
];

// "attention": Claude is waiting on the user — a permission/confirmation prompt.
// Checked before "working" so a pending prompt always wins.
const ATTENTION_MARKERS: RegExp[] = [
  /Do you want to (?:proceed|continue|create|make|run)/i,
  /❯\s*1\.\s/, // ❯ 1.  (selected option in Claude's choice box)
  /\b1\.\s*Yes\b/i,
  /\(y\/n\)/i,
  /\[y\/N\]/i,
  /\bAllow\b.*\bto\b/i,
  /Waiting for your (?:input|response|confirmation)/i,
];

export function inferState(text: string): TermState {
  if (!text.trim()) return "idle";
  const tail = text.split("\n").slice(-40).join("\n");
  for (const re of ATTENTION_MARKERS) if (re.test(tail)) return "attention";
  for (const re of WORKING_MARKERS) if (re.test(tail)) return "working";
  return "idle";
}

// "Is Claude Code on screen at all?" — independent of working/idle. Used to
// decide whether to surface a "what's it working on" summary even when the
// session is idle (Claude finished a turn but its conversation is still up).
// Markers are persistent bits of Claude Code's chrome that survive between
// turns, not turn-specific text. The most reliable is the permission-mode
// footer ("⏵⏵ <mode> mode on (shift+tab to cycle)"), pinned to the bottom of
// the input area in every steady state; "esc to interrupt" covers active turns.
const CLAUDE_MARKERS: RegExp[] = [
  /shift\+tab to cycle/i, // permission-mode footer — present whenever idle/ready
  /esc to interrupt/i, // active turn
  /⏵⏵/, // the mode-footer chevrons
  /\? for shortcuts/i, // input footer (other versions/states)
  /Claude Code v\d/i, // startup banner header
  /Context left until auto-compact/i,
];

export function hasClaude(text: string): boolean {
  if (!text.trim()) return false;
  const tail = text.split("\n").slice(-40).join("\n");
  return CLAUDE_MARKERS.some((re) => re.test(tail));
}
