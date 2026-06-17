// Terminal tab — control bar + session list (left panel) + embedded terminal
// <iframe> (right). Each iframe loads weave's own xterm.js client
// (terminal-xterm.html), which speaks ttyd's protocol to the session's port —
// owning the client is what lets us remap Shift+Enter / Cmd+Backspace. Session
// lifecycle is server-side (lib/terminals.ts); live status + summaries come from
// lib/terminal-status.ts. This module drives the UI and polls /api/terminals
// every 2.5s to refresh the status dot + summary.
//
// Iframes are mounted once per session and kept in the DOM (hidden when
// inactive) so switching is instant and never tears down a live connection.

const CWD_KEY = "weave.terminal-cwd";
const COLLAPSED_KEY = "weave.terminal-sidebar-collapsed";
const POLL_MS = 2500;
const CLOSE_AT = 0.94; // close progress (0=top/open … 1=bottom/close) at/above which slide-to-close fires

const mainEl = document.querySelector("main.terminal-page");
const listEl = document.getElementById("term-list");
const stageEl = document.getElementById("term-stage");
const emptyEl = document.getElementById("term-empty");
const newBtn = document.getElementById("term-new");
const cwdForm = document.getElementById("term-cwd-form");
const cwdInput = document.getElementById("term-cwd");
const savedTag = document.getElementById("term-cwd-saved");
const errEl = document.getElementById("term-bar-error");
const collapseBtn = document.getElementById("term-collapse");

/** @type {Map<string, HTMLIFrameElement>} id -> iframe */
const frames = new Map();
let activeId = null;
let savedTimer = null;
let currentIdsKey = "";
const prevStatus = new Map(); // id -> last raw status reported by the server
const doneIds = new Set(); // background terminals that finished, awaiting a look
const lastSummary = new Map(); // id -> last non-null summary (shown on the "done" badge)
const dismissedNotif = new Map(); // id -> notification.id the user has dismissed
let lastSessions = []; // most recent /api/terminals payload (so switching tabs can re-render the notif)

const idsKey = (sessions) => sessions.map((s) => s.id).join(",");

// Hydrate the saved default working directory into the bar.
try {
    cwdInput.value = localStorage.getItem(CWD_KEY) || "";
} catch {
    /* localStorage unavailable — fall back to empty (=> ~) */
}

// ── status / summary helpers ────────────────────────────────────────────────

function dotClass(s) {
    return "term-status-dot is-" + (s.display || s.status || "idle");
}

// Sub-line shows what the session is up to. A live summary (working, waiting, or
// an idle-but-open Claude Code session) wins; on a just-finished "done" tab with
// no live summary we fall back to the last one we saw; a plain shell shows cwd.
function subInfo(s) {
    if (s.summary) return { text: s.summary, isSummary: true };
    if ((s.display || s.status) === "done") {
        const last = lastSummary.get(s.id);
        if (last) return { text: last, isSummary: true };
    }
    return { text: s.cwd, isSummary: false };
}

function applyDead(nameEl, s) {
    let dead = nameEl.querySelector(".term-item-dead");
    if (s.alive === false && !dead) {
        dead = document.createElement("span");
        dead.className = "term-item-dead";
        dead.title = "ttyd not running — reconnecting on open";
        dead.textContent = "⚠";
        nameEl.appendChild(dead);
    } else if (s.alive !== false && dead) {
        dead.remove();
    }
}

// Derive the "done — needs attention" badge. A background tab (not the one
// you're viewing) that just went from working/attention to idle is marked done,
// and stays done until you click into it. Pure client state — the server only
// reports working/attention/idle. Sets s.display, used by dotClass/subInfo.
function reconcileDone(sessions) {
    const live = new Set(sessions.map((s) => s.id));
    for (const id of [...prevStatus.keys()]) if (!live.has(id)) prevStatus.delete(id);
    for (const id of [...doneIds]) if (!live.has(id)) doneIds.delete(id);
    for (const id of [...lastSummary.keys()]) if (!live.has(id)) lastSummary.delete(id);
    for (const id of [...dismissedNotif.keys()]) if (!live.has(id)) dismissedNotif.delete(id);

    for (const s of sessions) {
        const raw = s.status || "idle";
        const prev = prevStatus.get(s.id);
        if (s.summary) lastSummary.set(s.id, s.summary);
        if (s.id === activeId) {
            doneIds.delete(s.id); // you're looking at it — never "needs attention"
        } else if (raw === "idle") {
            if (prev === "working" || prev === "attention") doneIds.add(s.id); // just finished
        } else {
            doneIds.delete(s.id); // working/attention again — the live state wins
        }
        prevStatus.set(s.id, raw);
        s.display = doneIds.has(s.id) ? "done" : raw;
    }
}

// ── iframes ─────────────────────────────────────────────────────────────────

function ensureFrame(s) {
    let f = frames.get(s.id);
    if (!f) {
        f = document.createElement("iframe");
        f.className = "term-frame";
        // weave's own client (not ttyd's bundled page) so we can remap keys;
        // it's same-origin and connects a WebSocket to this session's ttyd port.
        f.src = `/terminal-xterm.html?port=${encodeURIComponent(s.port)}`;
        f.title = s.title;
        f.hidden = true;
        stageEl.appendChild(f);
        frames.set(s.id, f);
    }
    return f;
}

function activate(id) {
    if (!frames.has(id)) return;
    activeId = id;
    // Viewing a "done" tab clears its badge immediately (done implies idle).
    if (doneIds.delete(id)) {
        const li = listEl.querySelector(`.term-item[data-id="${id}"]`);
        const dot = li && li.querySelector(".term-status-dot");
        if (dot) dot.className = "term-status-dot is-idle";
    }
    for (const [fid, f] of frames) f.hidden = fid !== id;
    for (const li of listEl.children) {
        li.classList.toggle("active", li.dataset.id === id);
    }
    if (emptyEl) emptyEl.hidden = frames.size > 0;
    renderNotif(lastSessions); // switching tabs swaps which terminal's notif shows
}

// ── notification overlay ──────────────────────────────────────────────────────

// A non-modal card pinned to the upper-right of the stage, showing what the
// ACTIVE terminal's Claude is waiting on (a permission or idle prompt, surfaced
// by the terminal_live.ts hook). The LAYER is pointer-events:none so clicks and
// keystrokes pass straight through to the ttyd iframe — only the card itself is
// interactive — so you can answer the prompt by typing in the terminal with the
// card still up. It stays until dismissed; dismissal is keyed on
// (terminal, notification.id), so the SAME prompt won't reappear but a NEW one will.
let notifEl = null;
function ensureNotifLayer() {
    if (notifEl) return notifEl;
    notifEl = document.createElement("div");
    notifEl.className = "term-notif-layer";
    notifEl.hidden = true;
    stageEl.appendChild(notifEl);
    return notifEl;
}

function hideNotif(layer) {
    layer.hidden = true;
    layer.replaceChildren();
    layer.dataset.nid = "";
}

function renderNotif(sessions) {
    const layer = ensureNotifLayer();
    const s = sessions.find((x) => x.id === activeId);
    const n = s && s.notification;
    if (!n || dismissedNotif.get(activeId) === n.id) {
        hideNotif(layer);
        return;
    }
    if (layer.dataset.nid === n.id && !layer.hidden) return; // already showing this one

    const card = document.createElement("div");
    card.className = "term-notif-card";

    const msg = document.createElement("p");
    msg.className = "term-notif-msg";
    msg.textContent = n.message || "Claude is waiting for your input";

    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "term-notif-dismiss";
    dismiss.title = "dismiss";
    dismiss.setAttribute("aria-label", "dismiss notification");
    dismiss.textContent = "×";
    dismiss.addEventListener("click", () => {
        dismissedNotif.set(activeId, n.id);
        hideNotif(layer);
    });

    card.append(msg, dismiss);
    layer.replaceChildren(card);
    layer.dataset.nid = n.id;
    layer.hidden = false;
}

// ── rendering ───────────────────────────────────────────────────────────────

function renderList(sessions) {
    listEl.replaceChildren();
    for (const s of sessions) {
        ensureFrame(s); // pre-mount so connections persist while switching

        const li = document.createElement("li");
        li.className = "term-item";
        li.dataset.id = s.id;
        if (s.id === activeId) li.classList.add("active");

        const label = document.createElement("button");
        label.type = "button";
        label.className = "term-item-label";
        label.title = s.title; // identifies the tab when collapsed to a numbered square

        const name = document.createElement("span");
        name.className = "term-item-name";

        const dot = document.createElement("span");
        dot.className = dotClass(s);

        const title = document.createElement("span");
        title.className = "term-item-title";
        title.textContent = s.title;

        name.append(dot, title);
        applyDead(name, s);

        const sub = document.createElement("span");
        sub.className = "term-item-cwd";
        const { text, isSummary } = subInfo(s);
        sub.textContent = text;
        sub.title = text;
        if (isSummary) sub.classList.add("is-summary");

        label.append(name, sub);
        label.addEventListener("click", () => activate(s.id));

        // Slide-to-close: a custom vertical slider (a track div + a thumb div, no
        // native <input> or vendor pseudo-elements). Drag the thumb to the bottom
        // and the tab + terminal close — sliding all the way down IS the
        // confirmation, so no prompt. role="slider" + the keyboard wiring in
        // wireCloseSlider() keep it operable without a mouse and exposed to AT.
        const closer = document.createElement("div");
        closer.className = "term-item-close";
        closer.tabIndex = 0;
        closer.title = "slide down to close";
        closer.setAttribute("role", "slider");
        closer.setAttribute("aria-orientation", "vertical");
        closer.setAttribute("aria-label", `slide down to close ${s.title}`);
        closer.setAttribute("aria-valuemin", "0");
        closer.setAttribute("aria-valuemax", "100");
        closer.setAttribute("aria-valuenow", "0");
        const thumb = document.createElement("div");
        thumb.className = "term-item-close-thumb";
        closer.appendChild(thumb);
        wireCloseSlider(closer, s.id);

        li.append(label, closer);
        listEl.appendChild(li);
    }

    // Drop iframes whose session no longer exists.
    const live = new Set(sessions.map((s) => s.id));
    for (const [id, f] of frames) {
        if (!live.has(id)) {
            f.remove();
            frames.delete(id);
            if (activeId === id) activeId = null;
        }
    }
    currentIdsKey = idsKey(sessions);
    if (emptyEl) emptyEl.hidden = frames.size > 0;
}

// Update dot + summary on existing items in place — no DOM teardown, so the
// active selection, focus, and live iframes are untouched.
function patchStatus(sessions) {
    for (const s of sessions) {
        const li = listEl.querySelector(`.term-item[data-id="${s.id}"]`);
        if (!li) continue;
        const dot = li.querySelector(".term-status-dot");
        if (dot) dot.className = dotClass(s);
        const name = li.querySelector(".term-item-name");
        if (name) applyDead(name, s);
        const sub = li.querySelector(".term-item-cwd");
        if (sub) {
            const { text, isSummary } = subInfo(s);
            sub.textContent = text;
            sub.title = text;
            sub.classList.toggle("is-summary", isSummary);
        }
    }
}

async function fetchSessions() {
    const r = await fetch("/api/terminals");
    return await r.json();
}

async function load() {
    let sessions = [];
    try {
        sessions = await fetchSessions();
    } catch {
        sessions = [];
    }
    reconcileDone(sessions);
    renderList(sessions);
    if (sessions.length && (!activeId || !frames.has(activeId))) {
        activate(sessions[0].id);
    }
    lastSessions = sessions;
    renderNotif(sessions);
}

// Poll: patch in place when the session set is unchanged; re-render only when
// terminals were added/removed.
async function refresh() {
    let sessions;
    try {
        sessions = await fetchSessions();
    } catch {
        return;
    }
    reconcileDone(sessions);
    if (idsKey(sessions) !== currentIdsKey) {
        renderList(sessions);
        if (sessions.length && (!activeId || !frames.has(activeId))) activate(sessions[0].id);
    } else {
        patchStatus(sessions);
    }
    lastSessions = sessions;
    renderNotif(sessions);
}

// ── actions ─────────────────────────────────────────────────────────────────

function showError(msg) {
    if (!errEl) return;
    errEl.textContent = msg;
    errEl.hidden = false;
}
function clearError() {
    if (errEl) errEl.hidden = true;
}

function flashSaved() {
    if (!savedTag) return;
    savedTag.hidden = false;
    if (savedTimer) clearTimeout(savedTimer);
    savedTimer = setTimeout(() => {
        savedTag.hidden = true;
    }, 1500);
}

async function createSession(cwd) {
    clearError();
    let data;
    try {
        const r = await fetch("/api/terminals", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ cwd: cwd || undefined }),
        });
        data = await r.json();
        if (!r.ok) throw new Error(data && data.error ? data.error : "failed to create terminal");
    } catch (e) {
        showError(e.message || String(e));
        return;
    }
    await load();
    activate(data.id);
}

async function closeSession(id) {
    try {
        await fetch(`/api/terminals/${id}`, { method: "DELETE" });
    } catch {
        /* still drop it locally */
    }
    const f = frames.get(id);
    if (f) {
        f.remove();
        frames.delete(id);
    }
    if (activeId === id) activeId = null;
    await load();
    if (!activeId && frames.size) activate(frames.keys().next().value);
}

// Wire one tab's slide-to-close slider. Progress `f` runs 0 (top, open) → 1
// (bottom, close); CSS positions the thumb from the `--f` custom property.
// Reaching CLOSE_AT closes the session (once). Operable by pointer drag and by
// keyboard: ↓/→ and End slide toward close, ↑/←/Home back toward open.
function wireCloseSlider(el, id) {
    let f = 0;
    let closing = false;
    const clamp = (n) => (n < 0 ? 0 : n > 1 ? 1 : n);
    const setF = (next) => {
        f = clamp(next);
        el.style.setProperty("--f", String(f));
        el.setAttribute("aria-valuenow", String(Math.round(f * 100)));
        if (f >= CLOSE_AT && !closing) {
            closing = true; // fire once — closeSession re-renders and drops this node
            closeSession(id);
        }
    };
    // Relative drag: progress moves by how far the pointer travels from where it
    // was pressed, not by absolute position — so a plain click does nothing and
    // only a deliberate downward slide closes. A full capsule-length drag = 0→1.
    let startY = 0;
    let startF = 0;
    el.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        e.preventDefault();
        el.setPointerCapture(e.pointerId);
        el.classList.add("is-dragging"); // disables the thumb's snap transition
        startY = e.clientY;
        startF = f;
    });
    el.addEventListener("pointermove", (e) => {
        if (!el.hasPointerCapture(e.pointerId)) return;
        const h = el.getBoundingClientRect().height;
        setF(startF + (e.clientY - startY) / h);
    });
    const release = () => {
        if (!el.classList.contains("is-dragging")) return;
        el.classList.remove("is-dragging");
        if (!closing) setF(0); // released short of the bottom — snap back to open
    };
    el.addEventListener("pointerup", release);
    el.addEventListener("pointercancel", release);
    el.addEventListener("click", (e) => e.stopPropagation());

    el.addEventListener("keydown", (e) => {
        const STEP = 0.2;
        switch (e.key) {
            case "ArrowDown":
            case "ArrowRight": setF(f + STEP); break;
            case "ArrowUp":
            case "ArrowLeft": setF(f - STEP); break;
            case "Home": setF(0); break;
            case "End": setF(1); break;
            default: return;
        }
        e.preventDefault();
        e.stopPropagation();
    });
}

// ── sidebar drawer ────────────────────────────────────────────────────────────

// Collapse the left panel to a thin rail (the chevron stays put to reopen).
// State persists across reloads; the button's label/title reflect the action
// it will perform next.
function setCollapsed(collapsed) {
    mainEl.classList.toggle("sidebar-collapsed", collapsed);
    if (collapseBtn) {
        const label = collapsed ? "Expand sidebar" : "Collapse sidebar";
        collapseBtn.title = label;
        collapseBtn.setAttribute("aria-label", label);
        collapseBtn.setAttribute("aria-expanded", String(!collapsed));
    }
    try {
        localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
    } catch {
        /* persistence best-effort */
    }
}

try {
    if (localStorage.getItem(COLLAPSED_KEY) === "1") setCollapsed(true);
} catch {
    /* localStorage unavailable — start expanded */
}

if (collapseBtn) {
    collapseBtn.addEventListener("click", () =>
        setCollapsed(!mainEl.classList.contains("sidebar-collapsed")),
    );
}

newBtn.addEventListener("click", () => createSession(cwdInput.value.trim()));

cwdForm.addEventListener("submit", (e) => {
    e.preventDefault();
    clearError();
    try {
        localStorage.setItem(CWD_KEY, cwdInput.value.trim());
    } catch {
        /* persistence best-effort */
    }
    flashSaved();
});

load();
setInterval(refresh, POLL_MS);
