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

// ── theme ─────────────────────────────────────────────────────────────────
// Palette tracks the dashboard's dark/light. The 16 ANSI colors keep xterm's
// defaults (legible on both); we only override the surface + cursor + selection.
function xtermTheme() {
    const dark = document.documentElement.dataset.theme === "dark";
    return dark
        ? {
              background: "#0d1117",
              foreground: "#c9d1d9",
              cursor: "#c9d1d9",
              cursorAccent: "#0d1117",
              selectionBackground: "rgba(56,139,253,0.4)",
          }
        : {
              background: "#ffffff",
              foreground: "#1f2328",
              cursor: "#1f2328",
              cursorAccent: "#ffffff",
              selectionBackground: "rgba(84,174,255,0.4)",
          };
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
    theme: xtermTheme(),
});

const fit = new FitAddon.FitAddon();
term.loadAddon(fit);

const mount = document.getElementById("term");
term.open(mount);
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

    new ResizeObserver(() => safeFit()).observe(mount);
    window.addEventListener("resize", safeFit);

    // Live theme sync: the dashboard's theme toggle writes localStorage from the
    // parent document; the `storage` event fires here (same origin) so we recolor
    // without a reload.
    window.addEventListener("storage", (e) => {
        if (e.key !== "weave-theme") return;
        const v = e.newValue === "dark" || e.newValue === "light" ? e.newValue : "";
        if (v) document.documentElement.dataset.theme = v;
        term.options.theme = xtermTheme();
    });

    connect();
    term.focus();
}
