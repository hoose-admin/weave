// Terminal session lifecycle for the dashboard's "terminal" tab.
//
// Each session is a single `ttyd` process bound to 127.0.0.1 on its own port,
// running `dtach -a <socket>` — a byte-passthrough attach to a detached `dtach`
// master that holds the shell's pty. The master (created with `dtach -n`) is a
// daemon that outlives ttyd, the browser, and even a dashboard restart, so the
// shell — and anything running in it, e.g. `claude` — survives disconnects.
//
// WHY dtach and not tmux: tmux is a second terminal emulator — it PARSES the
// app's output into its own grid and RE-EMITS fresh escapes to the browser.
// That re-emit is incomplete for scroll/line-delete (it sends the post-scroll
// diff without the scroll), which desynced xterm.js — the "ghost line after a
// delete", the blank bands, and the resize corruption were all one bug. dtach
// does NOT parse or re-emit; the browser receives vim's ORIGINAL escape
// sequences, which xterm.js renders correctly. Removing tmux from the render
// path deleted that entire bug class (and the terminfo / resync / canvas
// scaffolding that used to paper over it).
//
// Disk is the source of truth: one JSON record per session under
// .weave/cache/terminals/. In-memory proc handles are best-effort only — a
// `bun --hot` reload drops them while the OS processes keep running, so every
// operation re-derives liveness from the pid + the dtach socket.
//
// Mirrors the file-backed pattern used for agentic stacks (cache/stacks/).

import { join, isAbsolute, basename } from "node:path";
import { readdir, readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { existsSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { REPO_ROOT, PORT } from "../weave.config.ts";
import { allocPort, portFree, waitForPortOccupied } from "./ports.ts";

const CACHE_DIR = join(import.meta.dir, "..", "cache", "terminals");
// Per-terminal "live" status files written by the weave_terminal_live.ts hook (state,
// summary, pending notification). A subdir of CACHE_DIR so its `<id>.json` files
// never collide with the session records readAllRecords() scans there.
const LIVE_DIR = join(CACHE_DIR, "live");
// dtach master sockets, one per session (path carries the id, kept short for the
// ~104-char AF_UNIX limit). A subdir so it never collides with `<id>.json` records.
const SOCK_DIR = join(CACHE_DIR, "sockets");
const HOST = "127.0.0.1";
const PORT_BASE = 7700;
const PORT_MAX = 7799;
// The browser terminal is xterm.js, so the shell's TERM is plain xterm-256color —
// the app emits xterm escapes that xterm.js renders directly (no tmux in between,
// so no re-emit and no scroll-region terminfo workaround needed).
const TERM = "xterm-256color";

export type TermSession = {
  id: string;
  title: string;
  // User-set tab name (via the rename UI). When present it wins over the
  // auto last-command / dir-basename display title. Absent → auto title.
  customTitle?: string;
  cwd: string;
  port: number;
  pid: number;
  // The dtach master socket for this session. Liveness of the persistent shell
  // is "this socket exists" (dtach removes it when the master exits).
  socket: string;
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

// The persistent shell lives in the dtach master, which holds `socket` open and
// unlinks it on exit — so "socket exists" is the liveness test (the dtach analog
// of `tmux has-session`). A SIGKILLed master can leave a stale socket; the
// respawn path notices when a fresh ttyd can't drive it and prunes the record.
function dtachHasSession(socket: string | undefined): boolean {
  return !!socket && existsSync(socket);
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

function socketPath(id: string): string {
  return join(SOCK_DIR, `${id}.sock`);
}

// The user's interactive shell (zsh on macOS). Run bare: under dtach's pty it is
// interactive, so it loads the user's rc — same as the old `tmux new` default.
function loginShell(): string {
  return process.env.SHELL || "/bin/zsh";
}

// Create the detached dtach master (daemon) that owns the shell's pty. `-n`
// forks the master and the launcher exits, so we track the session by its socket
// (not a pid). The shell inherits this env — the WEAVE_* vars the live-status
// hook needs, and TERM=xterm-256color so the app emits xterm escapes for the
// browser. Returns once the socket is up.
async function spawnMaster(socket: string, cwd: string, id: string): Promise<boolean> {
  await mkdir(SOCK_DIR, { recursive: true });
  try { unlinkSync(socket); } catch { /* no stale socket */ }
  try {
    const launcher = Bun.spawn(["dtach", "-n", socket, loginShell()], {
      cwd,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      env: {
        ...process.env,
        TERM,
        WEAVE_TERM_ID: id,
        WEAVE_LIVE_DIR: LIVE_DIR,
        WEAVE_PORT: dashboardPort(),
      },
    });
    // Don't await the launcher's exit — the socket appearing IS the readiness
    // signal, and the launcher's lifetime is irrelevant to us.
    launcher.unref();
  } catch {
    return false;
  }
  // The master forks asynchronously; wait briefly for the socket to appear.
  for (let i = 0; i < 40; i++) {
    if (existsSync(socket)) return true;
    await Bun.sleep(25);
  }
  return existsSync(socket);
}

function ttydArgs(socket: string, port: number, title: string): string[] {
  return [
    "ttyd",
    "-p", String(port),
    "-i", HOST,            // localhost-only — ttyd defaults to 0.0.0.0
    "-W",                  // writable / interactive
    "-T", TERM,            // xterm-compatible client TERM for xterm.js
    "-t", "fontSize=14",
    "-t", `titleFixed=${title}`,
    "-t", "disableLeaveAlert=true",
    // dtach attaches to the persistent master (byte passthrough — no re-emit).
    // -E: pass the ^\ detach char through to the app. -z: leave the suspend key
    // to the app. -r winch: redraw full-screen apps (vim/claude) on re-attach.
    "dtach", "-a", socket, "-E", "-z", "-r", "winch",
  ];
}

function spawnTtyd(socket: string, port: number, title: string) {
  const proc = Bun.spawn(ttydArgs(socket, port, title), {
    cwd: REPO_ROOT,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    env: process.env,
  });
  proc.unref(); // don't let the child keep the dashboard's event loop alive
  return proc;
}

// Kill the dtach master for a session (which ends the shell + anything in it) and
// remove its socket. `pkill -f <socket>` targets the master by its unique socket
// path; any attached clients (ttyd's `dtach -a`) die with it. Best-effort.
async function killMaster(socket: string | undefined): Promise<void> {
  if (!socket) return;
  try {
    await Bun.spawn(["pkill", "-f", socket], { stdout: "ignore", stderr: "ignore" }).exited;
  } catch {
    /* nothing matched */
  }
  try { unlinkSync(socket); } catch { /* master already unlinked it */ }
}

// Inject raw bytes into the session's shell via `dtach -p` (stdin → the master's
// pty), the passthrough analog of `tmux send-keys`. Best-effort.
async function injectBytes(socket: string, data: Uint8Array): Promise<void> {
  if (!existsSync(socket)) return;
  try {
    await Bun.spawn(["dtach", "-p", socket], {
      stdin: data,
      stdout: "ignore",
      stderr: "ignore",
    }).exited;
  } catch {
    /* best-effort — the terminal opens; the user can type by hand */
  }
}

// Type a command line into the session's interactive shell (as if the user typed
// it, then Enter). Used to auto-launch e.g. `claude --resume … --fork-session` in
// a freshly created terminal. The trailing newline runs it. Bytes buffer in the
// pty until the shell reaches its prompt, so this is safe to call right after
// the master starts. Best-effort: the terminal still opens if this fails.
async function sendKeys(socket: string, line: string): Promise<void> {
  await injectBytes(socket, new TextEncoder().encode(line.endsWith("\n") ? line : line + "\n"));
}

// Source the last-command hook into the session's interactive shell, then clear
// the screen (Ctrl-L) so the pane opens clean. Injected right after the master
// starts and BEFORE any startup command (so that command becomes the first
// captured "last command"). Only on create.
async function sourceCmdHook(socket: string): Promise<void> {
  if (!existsSync(CMD_HOOK_PATH)) return;
  const quoted = `'${CMD_HOOK_PATH.replace(/'/g, `'\\''`)}'`;
  await sendKeys(socket, `source ${quoted}`);
  // Ctrl-L (0x0c) redraws the pane with just the fresh prompt, hiding the source line.
  await injectBytes(socket, new Uint8Array([0x0c]));
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
// when there's no Claude/hook activity.
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
    // Legacy tmux-era record (no socket): retire it from the dashboard. The old
    // tmux session, if any, is left alone — recover it with `tmux attach`.
    if (!r.socket) { await removeRecord(r.id); continue; }
    // A session is live while its ttyd process runs. Only prune when BOTH ttyd
    // and its dtach master are gone (truly closed) — and never kill a live
    // process from a read. A dead ttyd whose master survived is kept as
    // alive:false; startup reconcile respawns ttyd for it.
    if (pidAlive(r.pid)) { out.push({ ...r, alive: true }); continue; }
    if (dtachHasSession(r.socket)) { out.push({ ...r, alive: false }); continue; }
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
  if (!Bun.which("dtach")) throw new Error("dtach not found — install it with: brew install dtach");

  const cwd = resolveCwd(opts.cwd);
  const used = new Set((await readAllRecords()).map((r) => r.port));
  const port = await allocPort(used, { start: PORT_BASE, end: PORT_MAX });
  if (port == null) throw new Error(`no free port available in ${PORT_BASE}-${PORT_MAX}`);

  const id = `term-${Date.now().toString(36)}`;
  const socket = socketPath(id);
  const title = (opts.title && opts.title.trim().slice(0, 60)) || basename(cwd) || "terminal";

  // Create the detached master eagerly so the shell — and its persistence —
  // exists from the moment of creation, before any browser attaches. The hook
  // and startup command are then injected into it (buffered until the shell's
  // first prompt); ttyd simply attaches.
  if (!(await spawnMaster(socket, cwd, id))) {
    throw new Error("dtach failed to create the session (socket never appeared)");
  }
  await sourceCmdHook(socket); // record each command for the tab's last-command label
  // Auto-run a startup command (e.g. a forked `claude --resume … --fork-session`).
  if (opts.command && opts.command.trim()) await sendKeys(socket, opts.command.trim());

  const proc = spawnTtyd(socket, port, title);
  if (!(await waitForPortOccupied(port, 2500))) {
    try { proc.kill(); } catch { /* noop */ }
    await killMaster(socket);
    throw new Error("ttyd failed to start (port never opened) — check that ttyd and dtach are installed");
  }

  const rec: TermSession = {
    id, title, cwd, port,
    pid: proc.pid ?? 0,
    socket,
    createdAt: new Date().toISOString(),
  };
  await writeRecord(rec);
  return rec;
}

export async function killSession(id: string): Promise<{ ok: true }> {
  const r = await readRecord(id);
  if (!r) return { ok: true };
  if (pidAlive(r.pid)) safeKill(r.pid); // ttyd
  await killMaster(r.socket); // the dtach master + shell
  await removeRecord(id);
  await removeLive(id);
  return { ok: true };
}

// The kill switch (the repurposed redraw button). Tears down EVERY weave terminal
// — reaps each ttyd and each dtach master — then clears all session records +
// live files for a clean slate. Unlike the old `tmux kill-server`, this touches
// ONLY weave's own sessions, never the user's other shells. Returns how many
// weave terminals were cleared. (Per-session healing lives in reconcile().)
export async function killAllSessions(): Promise<{ ok: boolean; killed: number }> {
  const recs = await readAllRecords();
  for (const r of recs) {
    if (pidAlive(r.pid)) safeKill(r.pid);
    await killMaster(r.socket);
    await removeRecord(r.id);
    await removeLive(r.id);
  }
  return { ok: true, killed: recs.length };
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

// Kill any live ttyd for this session and start a fresh one attached to the
// surviving dtach master, reusing the old port when it's free. Returns the
// updated record, or null when the master is gone (record dropped) or ttyd
// failed. Used by reconcile() to replace a dead ttyd WITHOUT touching the master,
// so the shell and any running `claude` are preserved.
async function respawnTtyd(r: TermSession): Promise<TermSession | null> {
  if (pidAlive(r.pid)) safeKill(r.pid);
  if (!dtachHasSession(r.socket)) { await removeRecord(r.id); return null; }
  if (!Bun.which("ttyd")) return null;
  const used = new Set((await readAllRecords()).map((x) => x.port).filter((p) => p !== r.port));
  const port = (await portFree(r.port)) ? r.port : await allocPort(used, { start: PORT_BASE, end: PORT_MAX });
  if (port == null) return null;
  const proc = spawnTtyd(r.socket, port, r.title);
  if (!(await waitForPortOccupied(port, 2500))) { try { proc.kill(); } catch { /* noop */ } return null; }
  const updated: TermSession = { ...r, port, pid: proc.pid ?? 0 };
  await writeRecord(updated);
  return updated;
}

// Run at module load (and on every `bun --hot` reload). When ttyd processes
// survived the reload their pids are still alive, so this is a no-op for them.
// After a full dashboard restart, ttyd may have died while the dtach master
// (a daemon) kept the shell alive — respawn ttyd against the surviving master so
// the terminal reconnects on next list/iframe load. Legacy tmux-era records (no
// socket) are dropped from the dashboard.
async function reconcile(): Promise<void> {
  if (!Bun.which("dtach")) return;
  for (const r of await readAllRecords()) {
    if (!r.socket) { await removeRecord(r.id); continue; } // legacy tmux record
    if (pidAlive(r.pid)) continue; // ttyd alive — nothing to do
    if (!dtachHasSession(r.socket)) { await removeRecord(r.id); await removeLive(r.id); continue; }
    try {
      await respawnTtyd(r);
    } catch {
      /* leave the record; listSessions will report it not-alive */
    }
  }
}

reconcile().catch(() => { /* best-effort */ });
