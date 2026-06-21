// weave's own xterm.js client for ttyd sessions.
//
// We replace ttyd's bundled web client with this one for a single reason: ttyd's
// client offers no way to remap keys, and the browser's xterm.js sends a plain
// carriage return for Shift+Enter (indistinguishable from Enter) and nothing
// usable for Cmd+Backspace. Native terminals (iTerm2, Ghostty, …) send distinct
// sequences for those; a browser terminal does not. So Claude Code's
// `shift+enter → newline` binding can never fire here, and there's no "delete to
// line start" on Cmd+Backspace. Owning the client lets us translate both at the
// keyboard layer, before bytes reach the pty — see installKeyHandler().
//
// This speaks ttyd's WebSocket protocol directly (validated against ttyd 1.7.7):
//   • subprotocol: "tty"
//   • first client frame (handshake): JSON {AuthToken, columns, rows} (no prefix)
//   • client → server: INPUT = '0' + utf8 ;  RESIZE = '1' + JSON{columns,rows}
//   • server → client: OUTPUT = '0' ; SET_WINDOW_TITLE = '1' ; SET_PREFERENCES = '2'
// AuthToken is empty: weave starts ttyd without --credential, so it's ignored
// (and fetching ttyd's /token cross-origin would be blocked by CORS anyway).
//
// Session persistence, liveness, and status are unaffected — those live in
// lib/terminals.ts (ttyd + tmux) and lib/terminal-status.ts (tmux capture-pane),
// both independent of whichever web client is attached.

const INPUT = 0x30; // '0'
const RECONNECT_MS = 1000;

const params = new URLSearchParams(location.search);
const port = params.get("port");
const host = location.hostname || "127.0.0.1";

const enc = new TextEncoder();
const dec = new TextDecoder();

// ── color scheme ──────────────────────────────────────────────────────────
// The palette is one of the named schemes in terminal-schemes.js (GitHub Dark,
// Catppuccin, Dracula, Nord, Solarized), chosen in the dashboard toolbar and
// stored in localStorage under WEAVE_TERM_SCHEME_KEY. Each scheme is a complete,
// fixed look — surface AND all 16 ANSI colors — and does NOT follow the
// dashboard's light/dark toggle (so, unlike before, we don't read `weave-theme`
// here). The parent writes the choice and the same-origin `storage` event below
// recolors us live, no reload.
const SCHEME_KEY = window.WEAVE_TERM_SCHEME_KEY;

function activeSchemeTheme() {
    let id = null;
    try {
        id = localStorage.getItem(SCHEME_KEY);
    } catch {
        /* localStorage unavailable — weaveTermScheme falls back to default */
    }
    return window.WEAVE_TERM_SCHEMES[window.weaveTermScheme(id)].theme;
}

const term = new Terminal({
    fontSize: 14,
    fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, "Cascadia Code", "Roboto Mono", monospace',
    cursorBlink: true,
    // Option-as-Meta so Alt/Option chords (word motion, Option+Enter) behave like
    // a configured native terminal — a bonus alongside the explicit remaps below.
    macOptionIsMeta: true,
    scrollback: 10000,
    theme: activeSchemeTheme(),
});

// Apply the active scheme to the live terminal AND to the page background. The
// #term padding (terminal-xterm.html) reveals the page behind the canvas, so
// matching documentElement's background to the scheme avoids a mismatched
// border. The HTML's inline bootstrap sets this for first paint; this keeps it
// in sync after a live scheme change.
function applyScheme() {
    const theme = activeSchemeTheme();
    term.options.theme = theme;
    document.documentElement.style.background = theme.background;
}

const fit = new FitAddon.FitAddon();
term.loadAddon(fit);

const mount = document.getElementById("term");
term.open(mount);
applyScheme();
safeFit();

// ── ttyd socket ─────────────────────────────────────────────────────────────

let ws = null;
let reconnectTimer = null;
let disposed = false;

function wsUrl() {
    return `ws://${host}:${port}/ws`;
}

function safeFit() {
    // fit() reads the container box; while the iframe is hidden (display:none)
    // it's 0×0 and proposeDimensions() returns undefined, so this is a safe
    // no-op until the tab is shown and the ResizeObserver re-fits.
    try {
        if (mount.clientWidth > 0 && mount.clientHeight > 0) fit.fit();
    } catch {
        /* ignore transient layout errors */
    }
}

// Send raw bytes to the pty as a ttyd INPUT frame.
function sendInput(data) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const payload = enc.encode(data);
    const msg = new Uint8Array(payload.length + 1);
    msg[0] = INPUT;
    msg.set(payload, 1);
    ws.send(msg);
}

function sendResize() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(enc.encode("1" + JSON.stringify({ columns: term.cols, rows: term.rows })));
}

function applyPrefs(body) {
    // ttyd forwards its `-t key=value` client options here as JSON. They map to
    // xterm ITerminalOptions; apply only the display keys we set ourselves so an
    // unknown key can't throw.
    try {
        const prefs = JSON.parse(dec.decode(body));
        if (typeof prefs.fontSize === "number") term.options.fontSize = prefs.fontSize;
        if (typeof prefs.fontFamily === "string") term.options.fontFamily = prefs.fontFamily;
        safeFit();
    } catch {
        /* non-JSON or unexpected shape — ignore */
    }
}

function scheduleReconnect() {
    if (disposed || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
    }, RECONNECT_MS);
}

function connect() {
    let sock;
    try {
        sock = new WebSocket(wsUrl(), "tty");
    } catch {
        scheduleReconnect();
        return;
    }
    sock.binaryType = "arraybuffer";
    ws = sock;

    sock.onopen = () => {
        safeFit();
        // Handshake: raw JSON, no command prefix.
        sock.send(enc.encode(JSON.stringify({ AuthToken: "", columns: term.cols, rows: term.rows })));
    };
    sock.onmessage = (ev) => {
        const u = new Uint8Array(ev.data);
        if (!u.length) return;
        const cmd = String.fromCharCode(u[0]);
        const body = u.subarray(1);
        if (cmd === "0") term.write(body); // OUTPUT
        else if (cmd === "1") document.title = dec.decode(body); // SET_WINDOW_TITLE
        else if (cmd === "2") applyPrefs(body); // SET_PREFERENCES
    };
    sock.onclose = () => {
        if (ws === sock) ws = null;
        scheduleReconnect(); // ttyd respawn / page wake — tmux keeps the session
    };
    sock.onerror = () => {
        try {
            sock.close();
        } catch {
            /* already closing */
        }
    };
}

// ── clipboard ─────────────────────────────────────────────────────────────────
// xterm renders the terminal to a <canvas>, so a mouse selection is xterm's own
// model painted over that canvas — not real DOM/text selection the OS can see.
// Two consequences this client has to handle: (1) the browser's native Cmd+C has
// nothing to copy (no selected DOM text), and (2) the running TUI's frequent
// repaints (Claude Code's spinner, cursor, status line) clear xterm's selection
// overlay almost as soon as you make it. We stash every non-empty selection here
// so Cmd+C (below) can copy the most recent one even after a repaint wiped the
// on-screen highlight. Paste needs no help: the browser's native paste event
// still reaches xterm's hidden textarea, so Cmd+V works once Cmd+C populates the
// clipboard.
let lastSelection = "";

// ── custom key handling — the reason this client exists ───────────────────────
function installKeyHandler() {
    term.attachCustomKeyEventHandler((e) => {
        if (e.type !== "keydown") return true;

        // Shift+Enter → newline. The terminal would otherwise send a bare CR and
        // Claude (or the shell) would submit. We send LF (0x0A = Ctrl-J), which
        // Claude Code treats as "insert newline" in every terminal, no
        // terminal-specific escape required.
        if (e.key === "Enter" && e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            sendInput("\n");
            return false;
        }

        // Cmd+Backspace → delete to start of line (macOS muscle memory). Sends
        // Ctrl-U (0x15), which Claude Code's input — and zsh's line editor —
        // read as kill-to-line-start.
        if (e.key === "Backspace" && e.metaKey && !e.altKey && !e.ctrlKey) {
            e.preventDefault();
            sendInput("\x15");
            return false;
        }

        // Cmd+Left / Cmd+Right → start / end of line (macOS muscle memory). A
        // browser xterm.js sends nothing for Cmd+Arrow — native terminals are
        // configured to, browsers aren't — so these never reach the pty. We send
        // Ctrl-A (0x01) / Ctrl-E (0x05), the emacs-style motions that Claude
        // Code's input and zsh's (default emacs-mode) line editor both honor.
        if (e.key === "ArrowLeft" && e.metaKey && !e.altKey && !e.ctrlKey) {
            e.preventDefault();
            sendInput("\x01");
            return false;
        }
        if (e.key === "ArrowRight" && e.metaKey && !e.altKey && !e.ctrlKey) {
            e.preventDefault();
            sendInput("\x05");
            return false;
        }

        // Cmd+C → copy the selection. xterm has no native copy (canvas, not DOM
        // text), so we do it: write the live selection, or the last one we saw
        // before a repaint cleared it, to the clipboard. With nothing selected we
        // fall through — Cmd+C has no terminal meaning, and Ctrl+C/SIGINT is ctrl,
        // not meta, so it stays untouched.
        if (e.key === "c" && e.metaKey && !e.altKey && !e.ctrlKey) {
            const sel = term.getSelection() || lastSelection;
            if (sel) {
                e.preventDefault();
                navigator.clipboard?.writeText(sel).catch(() => {
                    /* clipboard blocked (perms / insecure context) — ignore */
                });
                return false;
            }
        }

        return true; // everything else: xterm's normal handling
    });
}

// ── wiring ────────────────────────────────────────────────────────────────

if (!port) {
    term.write("\r\n\x1b[31mweave: missing ?port= for this terminal\x1b[0m\r\n");
} else {
    installKeyHandler();
    term.onData((d) => sendInput(d));
    term.onResize(() => sendResize());

    // Remember the most recent non-empty selection so Cmd+C can copy it even
    // after a TUI repaint clears the on-screen highlight (see installKeyHandler).
    term.onSelectionChange(() => {
        const sel = term.getSelection();
        if (sel) lastSelection = sel;
    });

    new ResizeObserver(() => safeFit()).observe(mount);
    window.addEventListener("resize", safeFit);

    // Live scheme sync: the dashboard's scheme picker writes localStorage from
    // the parent document; the `storage` event fires here (same origin, sibling
    // browsing context) so we recolor without a reload.
    window.addEventListener("storage", (e) => {
        if (e.key === SCHEME_KEY) applyScheme();
    });

    connect();
    term.focus();
}
