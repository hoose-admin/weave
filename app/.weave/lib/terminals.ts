// Terminal session lifecycle for the dashboard's "terminal" tab.
//
// Each session is a single `ttyd` process bound to 127.0.0.1 on its own port,
// running `tmux new -A -s weave-term-<id>` so the shell — and anything running
// in it, e.g. `claude` — survives client disconnects, page refreshes, and even
// a dashboard restart. The browser embeds ttyd's own xterm.js page in an
// <iframe>; we never proxy terminal I/O ourselves.
//
// Disk is the source of truth: one JSON record per session under
// .weave/cache/terminals/. In-memory proc handles are best-effort only — a
// `bun --hot` reload drops them while the OS processes keep running, so every
// operation re-derives liveness from the pid + `tmux has-session`.
//
// Mirrors the file-backed pattern used for agentic stacks (cache/stacks/).

import { join, isAbsolute, basename } from "node:path";
import { readdir, readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { REPO_ROOT, PORT } from "../weave.config.ts";
import { allocPort, portFree, waitForPortOccupied } from "./ports.ts";

const CACHE_DIR = join(import.meta.dir, "..", "cache", "terminals");
// Per-terminal "live" status files written by the weave_terminal_live.ts hook (state,
// summary, pending notification). A subdir of CACHE_DIR so its `<id>.json` files
// never collide with the session records readAllRecords() scans there.
const LIVE_DIR = join(CACHE_DIR, "live");
const HOST = "127.0.0.1";
const PORT_BASE = 7700;
const PORT_MAX = 7799;

export type TermSession = {
  id: string;
  title: string;
  // User-set tab name (via the rename UI). When present it wins over the
  // auto last-command / dir-basename display title. Absent → auto title.
  customTitle?: string;
  cwd: string;
  port: number;
  pid: number;
  tmux: string;
  createdAt: string;
  // Manual vertical position in the tab list, set by drag-to-reorder. Unset
  // sorts after ordered tabs, by createdAt (so a fresh tab lands at the bottom).
  order?: number;
};

// The last-command shell hook, sourced once into each session's shell so it
// records every command line to <id>.cmd (read by readLastCommand for the tab title).
const CMD_HOOK_PATH = join(import.meta.dir, "weave-cmd-hook.sh");

// ── Record IO ─────────────────────────────────────────────────────────────

function recPath(id: string): string {
  return join(CACHE_DIR, `${id}.json`);
}

async function writeRecord(r: TermSession): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(recPath(r.id), JSON.stringify(r, null, 2), "utf8");
}

async function readRecord(id: string): Promise<TermSession | null> {
  try {
    return JSON.parse(await readFile(recPath(id), "utf8")) as TermSession;
  } catch {
    return null;
  }
}

async function removeRecord(id: string): Promise<void> {
  try {
    await unlink(recPath(id));
  } catch {
    /* already gone */
  }
}

async function readAllRecords(): Promise<TermSession[]> {
  let files: string[];
  try {
    files = await readdir(CACHE_DIR);
  } catch {
    return [];
  }
  const out: TermSession[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(await readFile(join(CACHE_DIR, f), "utf8")) as TermSession);
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

// ── Liveness ──────────────────────────────────────────────────────────────

function pidAlive(pid: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM => the process exists but isn't ours; still "alive".
    return (e as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

function safeKill(pid: number): void {
  try {
    process.kill(pid);
  } catch {
    /* already dead */
  }
}

async function tmuxHasSession(name: string): Promise<boolean> {
  if (!Bun.which("tmux")) return false;
  try {
    const p = Bun.spawn(["tmux", "has-session", "-t", name], { stdout: "ignore", stderr: "ignore" });
    return (await p.exited) === 0;
  } catch {
    return false;
  }
}

// ── Ports ─────────────────────────────────────────────────────────────────
// portFree / allocPort / waitForPortOccupied live in ./ports.ts (shared with
// the smoke harness); the terminal allocator passes its own 7700–7799 range.

// ── Spawning ──────────────────────────────────────────────────────────────

// The port the dashboard actually bound to. server.ts sets WEAVE_PORT after its
// bind loop, which may have WALKED past a busy base PORT (e.g. a weave from another
// repo). Seed it into each terminal so an in-session `claude` — and the `/fork`
// script — reach THIS dashboard, not a same-config instance on the base port.
// Falls back to the configured PORT (e.g. the reconcile path at module load, before
// the server has bound).
function dashboardPort(): string {
  return process.env.WEAVE_PORT || String(PORT);
}

// ── ttyd client TERM (scroll-render workaround) ──────────────────────────────
// tmux 3.7a has a timing-sensitive bug on its optimized scroll-region output
// path: under ttyd's pty drain cadence, a rapid burst of full-screen-app scrolls
// (vim Ctrl-D/Ctrl-U, `less`, …) leaves the browser terminal with stale blank
// bands that never self-heal — tmux believes the client is current (verified:
// #{client_written} == bytes received, #{client_discarded} == 0, yet most rows
// were never sent; the same burst to a plain pty client arrives complete, and
// `tmux refresh-client` repaints every hole). Unsetting the scroll-region caps
// (csr/indn/rin) for ttyd's clients forces tmux onto its plain line-redraw
// path, which is correct under the same burst — at the cost of more redraw
// bytes on a localhost pipe (~5×, negligible).
//
// Scoping: `terminal-overrides` is a SERVER option, and weave must not degrade
// the user's other tmux clients (iTerm etc. advertise xterm-256color). So ttyd
// clients advertise TERM=tmux-256color instead — a standard terminfo entry
// that, on this server, only weave's browser terminals use — and the override
// is APPENDED (-a) keyed to exactly that TERM, preserving anything the user
// set. Systems whose terminfo lacks tmux-256color fall back to xterm-256color:
// terminal works, workaround inactive.
const TTYD_TERM_OVERRIDE = "tmux-256color:csr@:indn@:rin@";
let ttydTermCache: string | null = null;
function ttydTerm(): string {
  if (ttydTermCache) return ttydTermCache;
  let ok = false;
  try {
    ok = Bun.spawnSync(["infocmp", "tmux-256color"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
  } catch {
    /* infocmp missing — fall back */
  }
  ttydTermCache = ok ? "tmux-256color" : "xterm-256color";
  return ttydTermCache;
}

function ttydArgs(tmuxName: string, port: number, cwd: string, title: string, id: string): string[] {
  return [
    "ttyd",
    "-p", String(port),
    "-i", HOST,            // localhost-only — ttyd defaults to 0.0.0.0
    "-W",                  // writable / interactive
    "-T", ttydTerm(),      // distinct TERM so the scroll workaround targets only us
    "-t", "fontSize=14",
    "-t", `titleFixed=${title}`,
    "-t", "disableLeaveAlert=true",
    // tmux gives the session persistence: attach if it exists, else create it
    // in `cwd`. Launches $SHELL (zsh on macOS). `-e` seeds the session env so the
    // pane's shell — and the `claude`/hooks it runs — can find this terminal's
    // live file (only applied when this `new` actually CREATES the session; when
    // it attaches to the eager-created one the env is already there).
    "tmux", "new", "-A", "-s", tmuxName, "-c", cwd,
    "-e", `WEAVE_TERM_ID=${id}`, "-e", `WEAVE_LIVE_DIR=${LIVE_DIR}`,
    "-e", `WEAVE_PORT=${dashboardPort()}`,
  ];
}

function spawnTtyd(tmuxName: string, port: number, cwd: string, title: string, id: string) {
  const proc = Bun.spawn(ttydArgs(tmuxName, port, cwd, title, id), {
    cwd: REPO_ROOT,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    env: process.env,
  });
  proc.unref(); // don't let the child keep the dashboard's event loop alive
  return proc;
}

// weave's status-bar palette, lifted from the dashboard's dark-theme tokens in
// public/styles.css (--border / --muted / --blue / --bg). tmux's status line is
// set once on the server and can't follow the browser's light/dark toggle, so we
// pick one warm-dark band with a blue accent that reads cleanly on both the dark
// (#0d1117) and light (#ffffff) terminal backgrounds rather than tracking theme.
const STATUS_BG = "#3a3530"; // warm dark surface (dark --border)
const STATUS_FG = "#9a9285"; // muted text (dark --muted)
const STATUS_ACCENT = "#74c7ec"; // weave blue (dark --blue)

// Apply weave's per-session tmux options. Scoped to THIS session (no `-g`), so
// it never touches the user's global ~/.tmux.conf or their other tmux sessions,
// and — since session options live in the tmux server — it persists across ttyd
// respawns and dashboard restarts.
//
// `mouse on`: without it, a full-screen TUI sits on tmux's alternate screen,
// where the mouse wheel is translated into ↑/↓ keypresses rather than scrolling
// anything. Claude Code reads those as prompt-history navigation, so the wheel
// appears to "scroll your prompts." With mouse on, the wheel scrolls tmux's
// scrollback (copy-mode) — i.e. the window — as expected.
//
// `status-*`: recolor tmux's default (green) status line into weave's palette.
// We also replace the noisy `weave-term-<id>` session label on the left with the
// pane's cwd basename, show the running program per window, and a clock — all in
// the muted/accent tones above.
async function applySessionOptions(tmuxName: string): Promise<void> {
  if (!Bun.which("tmux")) return;
  const setOpt = (name: string, value: string) =>
    Bun.spawn(["tmux", "set-option", "-t", tmuxName, name, value], {
      stdout: "ignore",
      stderr: "ignore",
    }).exited;
  try {
    await setOpt("mouse", "on");
    // Scroll-region workaround (rationale at ttydTerm above). Server-scoped by
    // necessity (terminal-overrides has no session scope) but keyed to the TERM
    // only weave's ttyd clients advertise, and APPENDED so user-set overrides
    // survive. Idempotent: skipped once the entry is present. Re-asserted here
    // (create + reconcile) because the tmux server may be freshly started.
    if (ttydTerm() === "tmux-256color") {
      const show = Bun.spawn(["tmux", "show-options", "-sv", "terminal-overrides"], {
        stdout: "pipe",
        stderr: "ignore",
      });
      const cur = await new Response(show.stdout).text();
      await show.exited;
      if (!cur.includes("tmux-256color:csr@")) {
        await Bun.spawn(["tmux", "set-option", "-sa", "terminal-overrides", TTYD_TERM_OVERRIDE], {
          stdout: "ignore",
          stderr: "ignore",
        }).exited;
      }
    }
    await setOpt("status-style", `bg=${STATUS_BG},fg=${STATUS_FG}`);
    await setOpt("status-left", `#[fg=${STATUS_ACCENT},bold] #{b:pane_current_path} #[fg=${STATUS_FG}]│`);
    await setOpt("status-left-length", "40");
    await setOpt("window-status-current-format", `#[fg=${STATUS_ACCENT},bold] #W `);
    await setOpt("window-status-format", `#[fg=${STATUS_FG}] #W `);
    await setOpt("status-right", `#[fg=${STATUS_FG}] %H:%M `);
    await setOpt("status-right-length", "40");
  } catch {
    /* best-effort — the terminal still works without it */
  }
}

// Tell the weave_terminal_live.ts hook which weave terminal it's running in, and where
// to write the live status file. Set in the tmux *session environment* (not just
// the dashboard's process env): it lives in the tmux server, so every program
// launched in the session — the shell, `claude`, and the hooks `claude` spawns —
// inherits it, and it survives ttyd respawns and dashboard restarts. Set right
// after session creation, before any `claude` starts, so the first turn sees it.
// Absent these vars the hook is inert, so a non-weave terminal writes nothing.
async function applySessionEnv(tmuxName: string, id: string): Promise<void> {
  if (!Bun.which("tmux")) return;
  const set = (k: string, v: string) =>
    Bun.spawn(["tmux", "set-environment", "-t", tmuxName, k, v], {
      stdout: "ignore",
      stderr: "ignore",
    }).exited;
  try {
    await set("WEAVE_TERM_ID", id);
    await set("WEAVE_LIVE_DIR", LIVE_DIR);
    await set("WEAVE_PORT", dashboardPort());
  } catch {
    /* best-effort — status degrades to the pane-scrape fallback */
  }
}

// Type a command line into the session's interactive shell (as if the user typed
// it, then Enter). Used to auto-launch e.g. `claude --resume … --fork-session` in
// a freshly created terminal. It runs in the shell the eager `tmux new-session`
// already started — so PATH/rc and the seeded WEAVE_* env are intact, and the
// pane survives the command exiting (unlike passing a shell-command to `tmux
// new-session`). Best-effort: the terminal still opens if this fails.
async function sendKeys(tmuxName: string, line: string): Promise<void> {
  if (!Bun.which("tmux")) return;
  const run = (args: string[]) =>
    Bun.spawn(["tmux", "send-keys", "-t", tmuxName, ...args], {
      stdout: "ignore",
      stderr: "ignore",
    }).exited;
  try {
    // `-l --` sends the text LITERALLY: no key-name lookup, no backslash
    // processing — so a quoted prompt with quotes/backslashes reaches the shell
    // byte-for-byte. A separate Enter (a real key, so no `-l`) then runs it.
    await run(["-l", "--", line]);
    await run(["Enter"]);
  } catch {
    /* best-effort — the terminal opens; the user can type the command by hand */
  }
}

// Source the last-command hook into the session's interactive shell, then clear
// the screen so the pane opens clean. Sourced AFTER the WEAVE_* session env is set
// (so the hook sees WEAVE_TERM_ID/DIR) and BEFORE any startup command (so that
// command becomes the first captured "last command"). Only on create — like the
// startup command, re-sourcing in reconcile() would disrupt a running session.
async function sourceCmdHook(tmuxName: string): Promise<void> {
  if (!Bun.which("tmux") || !existsSync(CMD_HOOK_PATH)) return;
  const quoted = `'${CMD_HOOK_PATH.replace(/'/g, `'\\''`)}'`;
  await sendKeys(tmuxName, `source ${quoted}`);
  try {
    // C-l redraws the pane with just the fresh prompt at top, hiding the setup line.
    await Bun.spawn(["tmux", "send-keys", "-t", tmuxName, "C-l"], {
      stdout: "ignore",
      stderr: "ignore",
    }).exited;
  } catch {
    /* best-effort — the source line just stays visible at the top */
  }
}

// ── Live status (hook-written) ──────────────────────────────────────────────

export type TermLive = {
  state?: "working" | "attention" | "idle";
  summary?: string | null;
  notification?: { type: string; message: string; id: string; at: string } | null;
  // The Claude session id running in this terminal (recorded by the
  // weave_terminal_live.ts hook). Lets the dashboard fork it from the outside.
  sessionId?: string | null;
};

// Read the live status the weave_terminal_live.ts hook keeps for a session, or null
// when there's no Claude/hook activity (the server then falls back to scraping).
export async function readLive(id: string): Promise<TermLive | null> {
  try {
    return JSON.parse(await readFile(join(LIVE_DIR, `${id}.json`), "utf8")) as TermLive;
  } catch {
    return null;
  }
}

async function removeLive(id: string): Promise<void> {
  for (const f of [`${id}.json`, `${id}.cmd`]) {
    try {
      await unlink(join(LIVE_DIR, f));
    } catch {
      /* already gone / never existed */
    }
  }
}

// The last command run in this terminal, written by weave-cmd-hook.sh's preexec
// hook. Whitespace-collapsed and length-capped for a tab label; null if the shell
// hasn't run a command yet (or isn't a weave-hooked shell).
export async function readLastCommand(id: string): Promise<string | null> {
  try {
    const s = (await readFile(join(LIVE_DIR, `${id}.cmd`), "utf8")).replace(/\s+/g, " ").trim();
    return s ? s.slice(0, 80) : null;
  } catch {
    return null;
  }
}

function resolveCwd(input?: string): string {
  const home = homedir();
  let c = (input ?? "").trim();
  if (!c) return home; // empty default → home (~)
  if (c === "~") c = home;
  else if (c.startsWith("~/")) c = join(home, c.slice(2));
  if (!isAbsolute(c)) c = join(home, c);
  if (!existsSync(c)) throw new Error(`directory not found: ${c}`);
  if (!statSync(c).isDirectory()) throw new Error(`not a directory: ${c}`);
  return c;
}

// ── Public API ────────────────────────────────────────────────────────────

export async function listSessions(): Promise<Array<TermSession & { alive: boolean }>> {
  const recs = await readAllRecords();
  const out: Array<TermSession & { alive: boolean }> = [];
  for (const r of recs) {
    // A session is live while its ttyd process runs. Only prune when BOTH ttyd
    // and its tmux session are gone (truly closed) — and never kill a live
    // process from a read. A dead ttyd whose tmux survived is kept as
    // alive:false; startup reconcile respawns ttyd for it.
    if (pidAlive(r.pid)) { out.push({ ...r, alive: true }); continue; }
    if (await tmuxHasSession(r.tmux)) { out.push({ ...r, alive: false }); continue; }
    await removeRecord(r.id);
    await removeLive(r.id);
  }
  out.sort((a, b) => {
    const ao = a.order ?? Number.MAX_SAFE_INTEGER;
    const bo = b.order ?? Number.MAX_SAFE_INTEGER;
    return ao - bo || a.createdAt.localeCompare(b.createdAt);
  });
  return out;
}

export async function createSession(opts: { cwd?: string; title?: string; command?: string } = {}): Promise<TermSession> {
  if (!Bun.which("ttyd")) throw new Error("ttyd not found — install it with: brew install ttyd");
  if (!Bun.which("tmux")) throw new Error("tmux not found — install it with: brew install tmux");

  const cwd = resolveCwd(opts.cwd);
  const used = new Set((await readAllRecords()).map((r) => r.port));
  const port = await allocPort(used, { start: PORT_BASE, end: PORT_MAX });
  if (port == null) throw new Error(`no free port available in ${PORT_BASE}-${PORT_MAX}`);

  const id = `term-${Date.now().toString(36)}`;
  const tmux = `weave-${id}`;
  const title = (opts.title && opts.title.trim().slice(0, 60)) || basename(cwd) || "terminal";

  // Create the tmux session eagerly (detached) so it exists — and persists —
  // from the moment of creation, not just once a browser attaches (ttyd would
  // otherwise spawn it lazily on the first WebSocket connect). ttyd's
  // `tmux new -A` then simply attaches to it.
  try {
    await Bun.spawn(
      ["tmux", "new-session", "-d", "-s", tmux, "-c", cwd,
       "-e", `WEAVE_TERM_ID=${id}`, "-e", `WEAVE_LIVE_DIR=${LIVE_DIR}`,
       "-e", `WEAVE_PORT=${dashboardPort()}`],
      { stdout: "ignore", stderr: "ignore" },
    ).exited;
  } catch {
    /* fall back to ttyd's `new -A`, which creates it on attach */
  }

  const proc = spawnTtyd(tmux, port, cwd, title, id);
  if (!(await waitForPortOccupied(port, 2500))) {
    try { proc.kill(); } catch { /* noop */ }
    throw new Error("ttyd failed to start (port never opened) — check that ttyd and tmux are installed");
  }
  await applySessionOptions(tmux); // the session now exists — make the wheel scroll
  await applySessionEnv(tmux, id); // let the hook find this terminal's live file
  await sourceCmdHook(tmux); // record each command for the tab's last-command label
  // Auto-run a startup command (e.g. a forked `claude --resume … --fork-session`)
  // in the session's shell. ONLY here — never in reconcile(), which respawns ttyd
  // against a session whose command is already running (re-sending would double it).
  if (opts.command && opts.command.trim()) await sendKeys(tmux, opts.command.trim());

  const rec: TermSession = {
    id, title, cwd, port,
    pid: proc.pid ?? 0,
    tmux,
    createdAt: new Date().toISOString(),
  };
  await writeRecord(rec);
  return rec;
}

export async function killSession(id: string): Promise<{ ok: true }> {
  const r = await readRecord(id);
  if (!r) return { ok: true };
  if (pidAlive(r.pid)) safeKill(r.pid);
  if (Bun.which("tmux")) {
    try {
      await Bun.spawn(["tmux", "kill-session", "-t", r.tmux], { stdout: "ignore", stderr: "ignore" }).exited;
    } catch {
      /* session may already be gone */
    }
  }
  await removeRecord(id);
  await removeLive(id);
  return { ok: true };
}

// Set (or clear, with an empty string) the user-chosen tab name. A custom name
// overrides the auto last-command / dir-basename title in the dashboard.
export async function renameSession(id: string, title: string): Promise<TermSession | null> {
  const r = await readRecord(id);
  if (!r) return null;
  const t = title.trim().slice(0, 60);
  if (t) r.customTitle = t;
  else delete r.customTitle;
  await writeRecord(r);
  return r;
}

// Persist the tab list's vertical order. `ids` is the new top-to-bottom order
// from the dashboard's drag-reorder; each listed session's `order` is set to its
// index. Records not in `ids` (or already at that index) are left untouched, so
// only what actually moved is rewritten.
export async function reorderSessions(ids: string[]): Promise<void> {
  const pos = new Map(ids.map((id, i) => [id, i]));
  for (const r of await readAllRecords()) {
    const p = pos.get(r.id);
    if (p == null || r.order === p) continue;
    r.order = p;
    await writeRecord(r);
  }
}

// Run at module load (and on every `bun --hot` reload). When ttyd processes
// survived the reload their pids are still alive, so this is a no-op for them.
// After a full dashboard restart, ttyd may have died while the tmux server
// (a detached daemon) kept the shell alive — respawn ttyd against the surviving
// tmux session so the terminal reconnects on next list/iframe load.
async function reconcile(): Promise<void> {
  if (!Bun.which("tmux")) return;
  for (const r of await readAllRecords()) {
    if (pidAlive(r.pid)) continue; // ttyd survived the restart — nothing to do
    // ttyd is dead. If its tmux session is still alive (a detached daemon that
    // outlived the dashboard), respawn ttyd against it; otherwise the terminal
    // is truly gone, so drop the record.
    if (!(await tmuxHasSession(r.tmux))) { await removeRecord(r.id); continue; }
    if (!Bun.which("ttyd")) continue;
    try {
      const used = new Set((await readAllRecords()).map((x) => x.port).filter((p) => p !== r.port));
      const port = (await portFree(r.port)) ? r.port : await allocPort(used, { start: PORT_BASE, end: PORT_MAX });
      if (port == null) continue;
      const proc = spawnTtyd(r.tmux, port, r.cwd, r.title, r.id);
      if (!(await waitForPortOccupied(port, 2500))) { try { proc.kill(); } catch { /* noop */ } continue; }
      await applySessionOptions(r.tmux); // upgrade pre-existing sessions on restart
      await applySessionEnv(r.tmux, r.id); // re-assert the hook's env after a restart
      await writeRecord({ ...r, port, pid: proc.pid ?? 0 });
    } catch {
      /* leave the record; listSessions will report it not-alive */
    }
  }
}

reconcile().catch(() => { /* best-effort */ });
