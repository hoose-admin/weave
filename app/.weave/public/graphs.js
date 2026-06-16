// Cytoscape graph viewer for tickets / repo-map / skills / ai / adrs.

if (window.cytoscape && window.cytoscapeDagre) cytoscape.use(cytoscapeDagre);

const $ = (s) => document.querySelector(s);
let cy = null;

function currentKind() {
  const m = location.pathname.match(/^\/graphs\/(tickets|repo-map|skills|ai)/);
  return m ? m[1] : "repo-map";
}

// Cytoscape doesn't read CSS custom properties, so we maintain a JS
// palette per theme and pick at render time. Keep light values in sync
// with styles.css :root; dark values in sync with :root[data-theme="dark"].
const C_LIGHT = {
  ink: "#15130f",
  muted: "#5d574d",
  paper: "#faf8f3",
  border: "#e0dcd2",
  blue: "#1e66f5",
  green: "#40a02b",
  peach: "#fe640b",
  mauve: "#8839ef",
  teal: "#179299",
  red: "#fa7373",
  yellow: "#df8e1d",
  // Bucket fills + borders.
  bucketScratchFill: "#ede7d6", bucketScratchBorder: "#b8b1a0",
  bucketBacklogFill: "#36322a", bucketBacklogBorder: "#2f2b24",
  bucketStagingFill: "#e07474", bucketStagingBorder: "#b85555",
  bucketStuckFill: "#8a6a8a",   bucketStuckBorder: "#6b4f6b",
  bucketBuildingFill: "#ee9a44", bucketBuildingBorder: "#c47a25",
  bucketTestingFill: "#eaae3e",  bucketTestingBorder: "#b3892b",
  bucketValidatingFill: "#e6c238", bucketValidatingBorder: "#a99023",
  bucketCompleteFill: "#6fb058",   bucketCompleteBorder: "#4a8038",
  bucketArchiveFill: "#4a6e40",    bucketArchiveBorder: "#4a6e40",
  // Node-kind pastel fills (re-used from --swatch-* tokens for parity).
  apiFill: "#e6d6fb", analyticsFill: "#dde6fb",
  bqFill: "#fde0cf",  sqlFill: "#fdf0c8",
  specializedFill: "#dceedb",
  actionFill: "#fbdada", utilityFill: "#d4ebec",
  // ADR status palette — mirrors --adr-* CSS tokens (TKT-208 + TKT-216).
  // Categorical; do NOT reuse --bucket-* / bucket*Fill.
  adrProposed:   "#d4a64a", adrProposedFill:   "#f8e8c0",
  adrAccepted:   "#4caf6f", adrAcceptedFill:   "#d6f0df",
  adrRejected:   "#c9534a", adrRejectedFill:   "#f4d0cd",
  adrSuperseded: "#8a8a8a", adrSupersededFill: "#dcdcdc",
  adrDeprecated: "#8a8a8a", adrDeprecatedFill: "#dcdcdc",
  draftBorder:   "#9aa0a6", draftFill:         "#f1f3f4",
  matFill:       "#dde6fb",
  // AI ecosystem palette (ADR-004) — one color per primitive cluster.
  // Light variants; dark mirrors below. Borders are saturated; fills are
  // soft pastels so compound clusters read as a single hue.
  aiSkillFill:       "#e6d6fb", aiSkillBorder:       "#8839ef",
  aiAgentFill:       "#dde6fb", aiAgentBorder:       "#1e66f5",
  aiCommandFill:     "#d4ebec", aiCommandBorder:     "#179299",
  aiHookFill:        "#fbdada", aiHookBorder:        "#fa7373",
  aiMcpFill:         "#fde0cf", aiMcpBorder:         "#fe640b",
  aiStyleFill:       "#fdf0c8", aiStyleBorder:       "#df8e1d",
  aiPluginFill:      "#dceedb", aiPluginBorder:      "#40a02b",
  aiSettingsFill:    "#ede7d6", aiSettingsBorder:    "#5d574d",
  aiMiscFill:        "#e8e2d4", aiMiscBorder:        "#7a7268",
  aiToolFill:        "#faf8f3", aiToolBorder:        "#15130f",
  aiClusterFill:     "#f4efe2", aiClusterBorder:     "#c8c0ad",
};
const C_DARK = {
  ink: "#ece7da",
  muted: "#9a9285",
  paper: "#211e1a",
  border: "#3a3530",
  blue: "#74c7ec",
  green: "#a6e3a1",
  peach: "#fab387",
  mauve: "#cba6f7",
  teal: "#94e2d5",
  red: "#f38ba8",
  yellow: "#f9e2af",
  bucketScratchFill: "#5a5240",  bucketScratchBorder: "#8a8170",
  bucketBacklogFill: "#6b6557",  bucketBacklogBorder: "#968f80",
  bucketStagingFill: "#c95d5d",  bucketStagingBorder: "#e07474",
  bucketStuckFill: "#8a6a8a",    bucketStuckBorder: "#b094b0",
  bucketBuildingFill: "#d18636", bucketBuildingBorder: "#e0a05a",
  bucketTestingFill: "#d1992c",  bucketTestingBorder: "#e0b748",
  bucketValidatingFill: "#d1ad2c", bucketValidatingBorder: "#e0c948",
  bucketCompleteFill: "#5da046", bucketCompleteBorder: "#7fc66a",
  bucketArchiveFill: "#3f5e36",  bucketArchiveBorder: "#5b8a52",
  apiFill: "#3b2d56", analyticsFill: "#2a3a5c",
  bqFill: "#4a2e1a",  sqlFill: "#4a3a1a",
  specializedFill: "#2a4226",
  actionFill: "#4a2828", utilityFill: "#1f3a3c",
  // ADR status palette — dark variants.
  adrProposed:   "#d4a64a", adrProposedFill:   "#4a3a1a",
  adrAccepted:   "#4caf6f", adrAcceptedFill:   "#1d3a25",
  adrRejected:   "#c9534a", adrRejectedFill:   "#3f1f1c",
  adrSuperseded: "#8a8a8a", adrSupersededFill: "#33312d",
  adrDeprecated: "#8a8a8a", adrDeprecatedFill: "#33312d",
  draftBorder:   "#7a7a7a", draftFill:         "#2c2926",
  matFill:       "#2a3a5c",
  // AI ecosystem palette — dark variants (ADR-004).
  aiSkillFill:       "#3b2d56", aiSkillBorder:       "#cba6f7",
  aiAgentFill:       "#2a3a5c", aiAgentBorder:       "#74c7ec",
  aiCommandFill:     "#1f3a3c", aiCommandBorder:     "#94e2d5",
  aiHookFill:        "#4a2828", aiHookBorder:        "#f38ba8",
  aiMcpFill:         "#4a2e1a", aiMcpBorder:         "#fab387",
  aiStyleFill:       "#4a3a1a", aiStyleBorder:       "#f9e2af",
  aiPluginFill:      "#2a4226", aiPluginBorder:      "#a6e3a1",
  aiSettingsFill:    "#33312d", aiSettingsBorder:    "#9a9285",
  aiMiscFill:        "#2e2b27", aiMiscBorder:        "#8a8170",
  aiToolFill:        "#211e1a", aiToolBorder:        "#ece7da",
  aiClusterFill:     "#28251f", aiClusterBorder:     "#4a443c",
};
function activePalette() {
  const attr = document.documentElement.dataset.theme;
  if (attr === "dark") return C_DARK;
  if (attr === "light") return C_LIGHT;
  // No explicit choice — follow OS.
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? C_DARK
    : C_LIGHT;
}

function makeStyle() {
  const C = activePalette();
  return [
  {
    selector: "node",
    style: {
      label: "data(label)",
      color: C.ink,
      "font-family": "JetBrains Mono, ui-monospace, monospace",
      "font-size": 9,
      "background-color": C.paper,
      "border-width": 1.2,
      "border-color": C.muted,
      width: 22,
      height: 22,
      "text-wrap": "wrap",
      "text-max-width": 160,
      "text-valign": "bottom",
      "text-margin-y": 4,
    },
  },

  // ── Tickets view ──────────────────────────────────────────────────────
  // Pastel lifecycle palette — must match .weave/public/styles.css
  // --bucket-* custom properties (see TKT-151). Fills are the soft
  // pastels; borders are a slightly darker shade so the node reads as
  // one color rather than the old saturated accent ring.
  {
    selector: 'node[bucket="scratch"]',
    style: { "background-color": C.bucketScratchFill, "border-color": C.bucketScratchBorder },
  },
  {
    selector: 'node[bucket="0-backlog"]',
    style: { "background-color": C.bucketBacklogFill, "border-color": C.bucketBacklogBorder },
  },
  {
    selector: 'node[bucket="1-staging"]',
    style: { "background-color": C.bucketStagingFill, "border-color": C.bucketStagingBorder },
  },
  {
    selector: 'node[bucket="2-stuck"]',
    style: { "background-color": C.bucketStuckFill, "border-color": C.bucketStuckBorder },
  },
  {
    selector: 'node[bucket="3-building"]',
    style: { "background-color": C.bucketBuildingFill, "border-color": C.bucketBuildingBorder },
  },
  {
    selector: 'node[bucket="4-testing"]',
    style: { "background-color": C.bucketTestingFill, "border-color": C.bucketTestingBorder },
  },
  {
    selector: 'node[bucket="5-validating"]',
    style: { "background-color": C.bucketValidatingFill, "border-color": C.bucketValidatingBorder },
  },
  {
    selector: 'node[bucket="6-complete"]',
    style: { "background-color": C.bucketCompleteFill, "border-color": C.bucketCompleteBorder },
  },
  {
    selector: 'node[bucket="7-archive"]',
    style: { "background-color": C.bucketArchiveFill, "border-color": C.bucketArchiveBorder },
  },
  {
    selector: 'node[priority="High"]',
    style: { width: 30, height: 30, "border-width": 1.8 },
  },

  // ── Edges ─────────────────────────────────────────────────────────────
  {
    selector: "edge",
    style: {
      width: 1,
      "line-color": C.muted,
      "target-arrow-color": C.muted,
      opacity: 0.55,
      "target-arrow-shape": "triangle",
      "curve-style": "bezier",
      "arrow-scale": 0.8,
    },
  },
  // Tickets edges.
  {
    selector: 'edge[kind="depends_on"]',
    style: {
      "line-color": C.blue,
      "target-arrow-color": C.blue,
      opacity: 0.85,
    },
  },
  {
    selector: 'edge[kind="blocks"]',
    style: { "line-color": C.red, "target-arrow-color": C.red, opacity: 0.85 },
  },
  { selector: 'edge[kind="related"]', style: { "line-style": "dashed" } },

  // ── Skills view ───────────────────────────────────────────────────────
  {
    selector: 'node[kind="orchestrator"]',
    style: {
      width: 36,
      height: 36,
      "border-width": 1.8,
      "border-color": C.mauve,
      "background-color": C.apiFill,
      "font-size": 10,
      "font-weight": 500,
    },
  },
  {
    selector: 'node[kind="audit"]',
    style: { "border-color": C.peach, "background-color": C.bqFill },
  },
  {
    selector: 'node[kind="action"]',
    style: { "border-color": C.red, "background-color": C.actionFill },
  },
  {
    selector: 'node[kind="generator"]',
    style: { "border-color": C.blue, "background-color": C.analyticsFill },
  },
  {
    selector: 'node[kind="utility"]',
    style: { "border-color": C.teal, "background-color": C.utilityFill },
  },
  {
    selector: 'node[kind="specialized"]',
    style: { "border-color": C.green, "background-color": C.specializedFill },
  },
  {
    selector: 'node[kind="workflow"]',
    style: { "border-color": C.peach, "background-color": C.actionFill },
  },
  {
    selector: 'node[kind="leaf"]',
    style: { "border-color": C.muted, "background-color": C.paper },
  },
  {
    selector: "node[?orphan]",
    style: { "border-style": "dashed", "border-color": C.muted, opacity: 0.7 },
  },
  // Skills edges — three flavors per the parent/handoff/cite taxonomy. The
  // schema embeds the flavor in `edgeKind` (set by .weave/lib/graphs/skills.ts);
  // legacy edges with no edgeKind fall through to the muted default below.
  {
    selector: 'edge[kind="connects_to"][edgeKind="parent"]',
    style: {
      "line-color": C.mauve,
      "target-arrow-color": C.mauve,
      "line-style": "solid",
      opacity: 0.95,
      width: 2.2,
    },
  },
  {
    selector: 'edge[kind="connects_to"][edgeKind="handoff"]',
    style: {
      "line-color": C.muted,
      "target-arrow-color": C.muted,
      "line-style": "dashed",
      opacity: 0.55,
      width: 1.2,
    },
  },
  // Legacy fallback (any connects_to edge without an edgeKind attribute).
  {
    selector: 'edge[kind="connects_to"][!edgeKind]',
    style: {
      "line-color": C.mauve,
      "target-arrow-color": C.mauve,
      opacity: 0.75,
      width: 1.2,
    },
  },

  // ── ADR view ─────────────────────────────────────────────────────────
  // Node kinds: adr (status-colored), draft-ticket (dashed border —
  // proposed, not yet minted), materialized-ticket (filled like a real
  // ticket, cross-links into /graphs/tickets).
  {
    selector: 'node[kind="adr"]',
    style: {
      width: 44,
      height: 44,
      "border-width": 2.2,
      "border-color": C.muted,
      "background-color": C.paper,
      "font-size": 11,
      "font-weight": 600,
      shape: "round-rectangle",
    },
  },
  {
    selector: 'node[kind="adr"][status="proposed"]',
    style: { "border-color": C.adrProposed, "background-color": C.adrProposedFill },
  },
  {
    selector: 'node[kind="adr"][status="accepted"]',
    style: { "border-color": C.adrAccepted, "background-color": C.adrAcceptedFill },
  },
  {
    selector: 'node[kind="adr"][status="rejected"]',
    style: { "border-color": C.adrRejected, "background-color": C.adrRejectedFill },
  },
  {
    selector: 'node[kind="adr"][status="superseded"]',
    style: { "border-color": C.adrSuperseded, "background-color": C.adrSupersededFill, opacity: 0.7 },
  },
  {
    selector: 'node[kind="adr"][status="deprecated"]',
    style: { "border-color": C.adrDeprecated, "background-color": C.adrDeprecatedFill, opacity: 0.6, "border-style": "dashed" },
  },
  {
    selector: 'node[kind="draft-ticket"]',
    style: {
      width: 30,
      height: 30,
      "border-width": 1.6,
      "border-style": "dashed",
      "border-color": C.draftBorder,
      "background-color": C.draftFill,
      "font-size": 9,
      opacity: 0.85,
      shape: "round-rectangle",
    },
  },
  {
    selector: 'node[kind="materialized-ticket"]',
    style: {
      width: 32,
      height: 32,
      "border-width": 1.4,
      "border-color": C.blue,
      "background-color": C.matFill,
      "font-size": 9,
      shape: "round-rectangle",
    },
  },
  // ADR edge kinds. Five total; visually distinct per ADR-001 D4.
  {
    selector: 'edge[kind="proposes"]',
    style: {
      "line-color": C.muted,
      "target-arrow-color": C.muted,
      "line-style": "dashed",
      opacity: 0.6,
      width: 1.2,
    },
  },
  {
    selector: 'edge[kind="implements_adr"]',
    style: {
      "line-color": C.adrAccepted,
      "target-arrow-color": C.adrAccepted,
      opacity: 0.75,
      width: 1.4,
    },
  },
  {
    selector: 'edge[kind="materialized_from"]',
    style: {
      "line-color": C.blue,
      "target-arrow-color": C.blue,
      "line-style": "dotted",
      opacity: 0.5,
      width: 1.1,
    },
  },
  {
    selector: 'edge[kind="supersedes"]',
    style: {
      "line-color": C.adrRejected,
      "target-arrow-color": C.adrRejected,
      opacity: 0.85,
      width: 2,
    },
  },
  // depends_on edge style already declared in the tickets block above;
  // reuses cleanly for DRAFT → DRAFT / DRAFT → TKT in the ADR graph.

  // ── AI ecosystem view (ADR-004) ──────────────────────────────────────
  // Flat node set — no compound parent grouping. Color + shape per
  // `kind` carry the cluster semantics.
  { selector: 'node[kind="skill"]',                style: { "background-color": C.aiSkillFill,    "border-color": C.aiSkillBorder,    "border-width": 1.2 } },
  { selector: 'node[kind="agent"]',                style: { "background-color": C.aiAgentFill,    "border-color": C.aiAgentBorder,    "border-width": 1.2 } },
  { selector: 'node[kind="agent-builtin"]',        style: { "background-color": C.aiAgentFill,    "border-color": C.aiAgentBorder,    "border-width": 1.2, "border-style": "dashed", opacity: 0.85 } },
  { selector: 'node[kind="slash-command"]',        style: { "background-color": C.aiCommandFill,  "border-color": C.aiCommandBorder,  "border-width": 1.2 } },
  { selector: 'node[kind="hook"]',                 style: { "background-color": C.aiHookFill,     "border-color": C.aiHookBorder,     "border-width": 1.2, shape: "diamond", width: 18, height: 18 } },
  { selector: 'node[kind="hook-event"]',           style: { "background-color": C.aiHookFill,     "border-color": C.aiHookBorder,     "border-width": 1, "border-style": "dotted", opacity: 0.75, shape: "round-tag" } },
  { selector: 'node[kind="mcp-server"]',           style: { "background-color": C.aiMcpFill,      "border-color": C.aiMcpBorder,      "border-width": 1.4, shape: "barrel" } },
  // Scope-precedence visual cues (ADR-004 / CCO-inspired). SHADOWED: dimmed
  // dashed border. CONFLICT: red ring + bumped border weight.
  { selector: 'node[precedence="SHADOWED"]',       style: { "border-style": "dashed", opacity: 0.55 } },
  { selector: 'node[precedence="CONFLICT"]',       style: { "border-color": C.red, "border-width": 2.4 } },
  { selector: 'node[kind="mcp-tool"]',             style: { "background-color": C.aiMcpFill,      "border-color": C.aiMcpBorder,      "border-width": 1, shape: "ellipse", width: 16, height: 16 } },
  { selector: 'node[kind="mcp-prompt"]',           style: { "background-color": C.aiMcpFill,      "border-color": C.aiMcpBorder,      "border-width": 1, shape: "triangle" } },
  { selector: 'node[kind="mcp-resource"]',         style: { "background-color": C.aiMcpFill,      "border-color": C.aiMcpBorder,      "border-width": 1, shape: "rhomboid" } },
  { selector: 'node[kind="output-style"]',         style: { "background-color": C.aiStyleFill,    "border-color": C.aiStyleBorder,    "border-width": 1.2 } },
  { selector: 'node[kind="output-style-builtin"]', style: { "background-color": C.aiStyleFill,    "border-color": C.aiStyleBorder,    "border-width": 1, "border-style": "dashed", opacity: 0.85 } },
  { selector: 'node[kind="plugin"]',               style: { "background-color": C.aiPluginFill,   "border-color": C.aiPluginBorder,   "border-width": 1.2 } },
  { selector: 'node[kind="marketplace"]',          style: { "background-color": C.aiPluginFill,   "border-color": C.aiPluginBorder,   "border-width": 1.6, shape: "round-rectangle", width: 30, height: 24 } },
  { selector: 'node[kind="settings-file"]',        style: { "background-color": C.aiSettingsFill, "border-color": C.aiSettingsBorder, "border-width": 1.2, shape: "round-rectangle" } },
  { selector: 'node[kind="claude-md"]',            style: { "background-color": C.aiSettingsFill, "border-color": C.aiSettingsBorder, "border-width": 1, shape: "round-rectangle", "border-style": "dashed" } },
  { selector: 'node[kind="status-line"]',          style: { "background-color": C.aiMiscFill,     "border-color": C.aiMiscBorder,     "border-width": 1.2, shape: "tag" } },
  { selector: 'node[kind="lsp-server"]',           style: { "background-color": C.aiMiscFill,     "border-color": C.aiMiscBorder,     "border-width": 1.2, shape: "round-rectangle" } },
  { selector: 'node[kind="tool-builtin"]',         style: { "background-color": C.aiToolFill,     "border-color": C.aiToolBorder,     "border-width": 1, shape: "round-rectangle", width: 24, height: 16 } },
  { selector: 'node[kind="tool-mcp"]',             style: { "background-color": C.aiToolFill,     "border-color": C.aiMcpBorder,      "border-width": 1, shape: "round-rectangle", width: 24, height: 16 } },

  // AI ecosystem edge kinds — nine total. Color follows the SOURCE cluster
  // intent (gates=hook=red, scopes=agent=blue, invokes=blue solid,
  // provides=mcp=peach, bundles=plugin=green, lists=plugin=green,
  // configures=settings=muted, references=muted, overrides=mauve).
  { selector: 'edge[kind="gates"]',      style: { "line-color": C.aiHookBorder,     "target-arrow-color": C.aiHookBorder,     opacity: 0.8,  width: 1.6, "line-style": "dashed" } },
  { selector: 'edge[kind="scopes"]',     style: { "line-color": C.aiAgentBorder,    "target-arrow-color": C.aiAgentBorder,    opacity: 0.7,  width: 1.3, "line-style": "dashed" } },
  { selector: 'edge[kind="invokes"]',    style: { "line-color": C.aiAgentBorder,    "target-arrow-color": C.aiAgentBorder,    opacity: 0.85, width: 1.6 } },
  { selector: 'edge[kind="provides"]',   style: { "line-color": C.aiMcpBorder,      "target-arrow-color": C.aiMcpBorder,      opacity: 0.75, width: 1.3 } },
  { selector: 'edge[kind="bundles"]',    style: { "line-color": C.aiPluginBorder,   "target-arrow-color": C.aiPluginBorder,   opacity: 0.8,  width: 1.4 } },
  { selector: 'edge[kind="lists"]',      style: { "line-color": C.aiPluginBorder,   "target-arrow-color": C.aiPluginBorder,   opacity: 0.55, width: 1.1, "line-style": "dotted" } },
  { selector: 'edge[kind="configures"]', style: { "line-color": C.aiSettingsBorder, "target-arrow-color": C.aiSettingsBorder, opacity: 0.6,  width: 1.1, "line-style": "dashed" } },
  { selector: 'edge[kind="references"]', style: { "line-color": C.muted,            "target-arrow-color": C.muted,            opacity: 0.45, width: 1,   "line-style": "dotted" } },
  { selector: 'edge[kind="overrides"]',  style: { "line-color": C.mauve,            "target-arrow-color": C.mauve,            opacity: 0.7,  width: 1.4, "line-style": "dashed" } },

  // ── Repo-map view ─────────────────────────────────────────────────────
  // Generic code-structure graph: directory + file nodes, contains/imports
  // edges. Flat (no compound parents) so the default dagre layout is happy.
  {
    selector: 'node[kind="dir"]',
    style: {
      shape: "round-rectangle",
      "background-color": C.aiClusterFill,
      "border-color": C.muted,
      "border-width": 1.4,
      width: "label",
      height: 20,
      padding: 6,
      "font-size": 10,
      "font-weight": 600,
      color: C.ink,
      "text-valign": "center",
      "text-halign": "center",
      "text-margin-y": 0,
    },
  },
  {
    selector: 'node[kind="file"]',
    style: { "background-color": C.paper, "border-color": C.muted, width: 18, height: 18 },
  },
  { selector: 'node[kind="file"][lang="ts"]', style: { "border-color": C.blue,   "background-color": C.analyticsFill } },
  { selector: 'node[kind="file"][lang="js"]', style: { "border-color": C.yellow, "background-color": C.sqlFill } },
  { selector: 'node[kind="file"][lang="py"]', style: { "border-color": C.green,  "background-color": C.specializedFill } },
  { selector: 'node[kind="file"][lang="go"]', style: { "border-color": C.teal,   "background-color": C.utilityFill } },
  { selector: 'node[kind="file"][lang="rs"]', style: { "border-color": C.peach,  "background-color": C.bqFill } },
  { selector: 'node[kind="file"][lang="rb"]', style: { "border-color": C.red,    "background-color": C.actionFill } },
  { selector: 'node[kind="file"][?entry]',    style: { shape: "star", width: 28, height: 28, "border-color": C.mauve, "border-width": 1.8 } },
  { selector: 'edge[kind="contains"]', style: { "line-color": C.border, "target-arrow-color": C.border, "line-style": "dotted", opacity: 0.35, width: 1, "target-arrow-shape": "none" } },
  { selector: 'edge[kind="imports"]',  style: { "line-color": C.blue,   "target-arrow-color": C.blue,   opacity: 0.6,  width: 1.1 } },

  // ── Faded (dimmed) state — used by focus / text filter ───────────────
  { selector: ".faded", style: { opacity: 0.08, "text-opacity": 0.1 } },
  { selector: "edge.faded", style: { opacity: 0.04 } },
  {
    selector: ".highlight",
    style: { "border-width": 2, "border-color": C.ink },
  },
  ];
}

// Re-render the active cytoscape on theme change. We re-apply the style
// array in place rather than destroy+rebuild so the user's current focus
// state / layout position aren't lost.
window.addEventListener("weave:theme-changed", () => {
  if (cy) cy.style(makeStyle());
});

function layoutOpts(name) {
  if (name === "dagre")
    return {
      name: "dagre",
      rankDir: "LR", // left-to-right ⇒ fe-route | be-route | table columns
      nodeSep: 14,
      edgeSep: 6,
      rankSep: 110,
      fit: true,
      padding: 24,
    };
  if (name === "cose")
    return {
      name: "cose",
      animate: false,
      randomize: true,
      fit: true,
      padding: 24,
      idealEdgeLength: 110,
      nodeRepulsion: () => 9000,
      nodeOverlap: 16,
      gravity: 0.25,
      componentSpacing: 70,
      numIter: 2500,
    };
  if (name === "breadthfirst")
    return {
      name: "breadthfirst",
      directed: true,
      padding: 24,
      spacingFactor: 0.9,
    };
  if (name === "circle") return { name: "circle", padding: 24 };
  return { name: "grid", padding: 24 };
}

// All graph kinds default to dagre — clean rank layout. The AI graph
// is flat (no compound `parent` grouping) so dagre handles it the same
// way it handles the skills graph.
function defaultLayout(_kind) {
  return "dagre";
}

function runLayout() {
  if (!cy) return;
  cy.layout(layoutOpts($("#layout").value)).run();
}

// ── Manual node-position persistence (localStorage, per-graph-kind) ─────────
// Dagre recomputes every load, throwing away any manual drag. We snapshot
// node x/y on drag-release into localStorage and re-apply on load so a
// hand-arranged graph survives a refresh.
function positionsEnabled(_kind) {
  return true;
}
function posKey(kind) {
  return `weave:positions:${kind}`;
}
function loadPositions(kind) {
  try {
    const raw = localStorage.getItem(posKey(kind));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function saveCurrentPositions(kind) {
  if (!cy) return;
  const map = {};
  cy.nodes().forEach((n) => {
    const p = n.position();
    map[n.id()] = { x: p.x, y: p.y };
  });
  try {
    localStorage.setItem(posKey(kind), JSON.stringify(map));
  } catch {
    /* quota / private mode — silently skip */
  }
}
// Re-apply saved positions on top of whatever the layout produced. Nodes with
// no saved entry (added since last save) keep their fresh layout position.
function applySavedPositions(kind) {
  const saved = loadPositions(kind);
  if (!saved) return;
  let applied = 0;
  cy.batch(() => {
    cy.nodes().forEach((n) => {
      const p = saved[n.id()];
      if (p && typeof p.x === "number" && typeof p.y === "number") {
        n.position(p);
        applied++;
      }
    });
  });
  if (applied) cy.fit(undefined, 24);
}

async function load(rebuild = false) {
  const kind = currentKind();
  $("#info").textContent = "loading…";
  const url = `/api/graphs/${kind}${rebuild ? "?rebuild=1" : ""}`;
  const data = await fetch(url).then((r) => r.json());
  if (cy) cy.destroy();
  cy = cytoscape({
    container: $("#cy"),
    elements: [...(data.nodes ?? []), ...(data.edges ?? [])],
    style: makeStyle(),
    layout: layoutOpts($("#layout").value),
    wheelSensitivity: 0.2,
  });
  cy.on("tap", "node", (e) => {
    const id = e.target.data("id");
    if (id.startsWith("TKT-")) {
      location.href = `/ticket/${id}`;
      return;
    }
    focusLineage(e.target);
  });
  cy.on("tap", (e) => {
    if (e.target === cy) {
      clearFocus();
    }
  });
  // Grabbing a node (mouse-down to drag) should dismiss the hover card so it
  // doesn't sit stuck over the graph while you reposition. positionTooltip
  // no-ops while hidden, so it stays gone for the whole drag.
  cy.on("grab", "node", hideSkillTooltip);
  if (kind === "skills") {
    cy.on("mouseover", "node", (e) => showSkillTooltip(e.target, e.originalEvent));
    cy.on("mousemove", "node", (e) => positionTooltip(e.originalEvent));
    cy.on("mouseout", "node", hideSkillTooltip);
  }
  if (kind === "ai") {
    cy.on("mouseover", "node", (e) => showAiTooltip(e.target, e.originalEvent));
    cy.on("mousemove", "node", (e) => positionTooltip(e.originalEvent));
    cy.on("mouseout", "node", hideSkillTooltip);
  }
  if (kind === "tickets") {
    cy.on("mouseover", "node", (e) => showTicketTooltip(e.target, e.originalEvent));
    cy.on("mousemove", "node", (e) => positionTooltip(e.originalEvent));
    cy.on("mouseout", "node", hideSkillTooltip);
  }
  const line = infoLine(kind, data);
  // The AI graph embeds a clickable warn pill (`<span class="warn-pill">`)
  // so we render as HTML there. Other graphs stay textContent for safety.
  if (kind === "ai") $("#info").innerHTML = line;
  else $("#info").textContent = line;
  $("#info").dataset.fullLine = line;
  applyTextFilter();
  applyEdgeMode();
  // applyEdgeMode runs the final layout, so re-apply saved positions last
  // (they must win over the auto-layout) and start tracking drags.
  if (positionsEnabled(kind)) {
    applySavedPositions(kind);
    cy.on("free", "node", () => saveCurrentPositions(kind));
  }
}

// ── Focus mode ────────────────────────────────────────────────────────────
// Click a node ⇒ keep its full upstream + downstream lineage visible, dim
// everything else. Click background to restore.
function focusLineage(node) {
  if (!cy) return;
  const lineage = node.predecessors().union(node.successors()).union(node);
  cy.elements().addClass("faded");
  lineage.removeClass("faded");
  node.addClass("highlight");
  $("#info").dataset.focus = node.data("label");
  $("#info").textContent =
    `focus: ${node.data("label")} · ${lineage.nodes().length - 1} connected`;
}
function clearFocus() {
  if (!cy) return;
  cy.elements().removeClass("faded").removeClass("highlight");
  delete $("#info").dataset.focus;
  applyTextFilter(); // text filter, if active, re-applies
  // Restore the original info line.
  const kind = currentKind();
  $("#info").textContent = $("#info").dataset.fullLine ?? "";
}

// ── Text filter ───────────────────────────────────────────────────────────
function applyTextFilter() {
  if (!cy) return;
  const q = $("#filter").value.trim().toLowerCase();
  if (!q) {
    cy.elements().removeClass("faded");
    return;
  }
  // On the AI ecosystem graph the filter matches BOTH label and kind so
  // typing "hook" / "mcp" / "skill" isolates a primitive cluster. ADR-004
  // Pass 4. Other graphs keep label-only behavior to avoid surprises.
  const matchesKind = currentKind() === "ai";
  const matches = cy.nodes().filter((n) => {
    if ((n.data("label") ?? "").toLowerCase().includes(q)) return true;
    if (matchesKind && (n.data("kind") ?? "").toLowerCase().includes(q)) return true;
    return false;
  });
  const keep = matches.union(matches.connectedEdges());
  cy.elements().addClass("faded");
  keep.removeClass("faded");
}

// ── Skill hover tooltip ───────────────────────────────────────────────────
let tooltipEl = null;
function getSkillTooltip() {
  if (tooltipEl) return tooltipEl;
  tooltipEl = document.createElement("div");
  tooltipEl.className = "weave-tt";
  tooltipEl.hidden = true;
  document.body.appendChild(tooltipEl);
  return tooltipEl;
}
function escHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}
function showSkillTooltip(node, evt) {
  const d = node.data();
  if (!d.description && !d.whenToUse) return;
  const tt = getSkillTooltip();
  const whenHtml = d.whenToUse
    ? `<div class="weave-tt-next"><span class="weave-tt-next-label">When:</span> <span class="weave-tt-next-text">${escHtml(d.whenToUse)}</span></div>`
    : "";
  tt.innerHTML = `
    <div class="weave-tt-title">${escHtml(d.label)}</div>
    <div class="weave-tt-meta">
      <span class="weave-tt-muted">${escHtml(d.kind ?? "")}</span>
    </div>
    ${d.description ? `<div class="weave-tt-next" style="border-top:none;padding-top:4px;margin-top:4px">${escHtml(d.description)}</div>` : ""}
    ${whenHtml}`;
  tt.hidden = false;
  positionTooltip(evt);
}
function positionTooltip(evt) {
  if (!tooltipEl || tooltipEl.hidden || !evt) return;
  const pad = 14;
  const rect = tooltipEl.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let x = evt.clientX + pad;
  let y = evt.clientY + pad;
  if (x + rect.width + 8 > vw) x = evt.clientX - rect.width - pad;
  if (y + rect.height + 8 > vh) y = evt.clientY - rect.height - pad;
  tooltipEl.style.left = `${Math.max(8, x)}px`;
  tooltipEl.style.top = `${Math.max(8, y)}px`;
}
function hideSkillTooltip() {
  if (tooltipEl) tooltipEl.hidden = true;
}

function showTicketTooltip(node, evt) {
  const d = node.data();
  if (!d.title) return;
  const tt = getSkillTooltip();
  const metaBits = [d.bucket, d.priority, d.domain].filter(Boolean).map(escHtml).join(" · ");
  tt.innerHTML = `
    <div class="weave-tt-title">${escHtml(d.id)}</div>
    <div class="weave-tt-next" style="border-top:none;padding-top:4px;margin-top:4px">${escHtml(d.title)}</div>
    ${metaBits ? `<div class="weave-tt-meta"><span class="weave-tt-muted">${metaBits}</span></div>` : ""}`;
  tt.hidden = false;
  positionTooltip(evt);
}

// ── AI ecosystem hover tooltip (ADR-004) ──────────────────────────────────
// Per-kind one-liner explaining what each node IS, in case the node has no
// frontmatter description to fall back on (built-in tools, hook events,
// etc.). Reuses the .weave-tt DOM element + CSS from the skills tooltip.
const AI_KIND_EXPLAINER = {
  "skill":                "Claude Code skill — invoked via /name or auto-discovered by description",
  "agent":                "Custom subagent — runs in its own context window with restricted tools",
  "agent-builtin":        "Built-in Claude Code subagent",
  "slash-command":        "Slash command (legacy commands/ dir; merged into skills as of v2.1.73)",
  "hook":                 "Configured lifecycle hook — fires on the matched event",
  "hook-event":           "Claude Code lifecycle event — hooks register against these",
  "mcp-server":           "MCP server providing tools / prompts / resources",
  "mcp-tool":             "Tool exposed by an MCP server",
  "mcp-prompt":           "Prompt exposed by an MCP server (surfaces as /mcp__server__prompt)",
  "mcp-resource":         "Resource exposed by an MCP server (@server:protocol://...)",
  "output-style":         "Custom output style — modifies the system prompt role/tone",
  "output-style-builtin": "Built-in output style",
  "plugin":               "Installed plugin — may bundle skills, agents, hooks, MCP, LSP, output styles",
  "marketplace":          "Plugin marketplace — source for installable plugins",
  "settings-file":        "Settings file — configures hooks, MCP allow/deny, outputStyle, statusLine",
  "claude-md":            "CLAUDE.md memory file — instructions loaded at session start",
  "status-line":          "Status line script invoked from settings.json:statusLine",
  "lsp-server":           "Language Server — plugin-bundled, gives Claude real-time diagnostics",
  "tool-builtin":         "Built-in Claude Code tool — exposed to the model",
  "tool-mcp":             "Tool exposed via MCP",
};
const AI_SCOPE_LABEL = {
  "user":          "~/.claude (user)",
  "project":       ".claude (project)",
  "project-local": ".claude/settings.local.json (project, gitignored)",
  "plugin":        "shipped by a plugin",
  "builtin":       "built into Claude Code",
  "managed":       "managed by enterprise policy",
};
function showAiTooltip(node, evt) {
  const d = node.data();
  const tt = getSkillTooltip();
  const explainer = AI_KIND_EXPLAINER[d.kind] ?? d.kind ?? "";
  const scopeLabel = d.scope ? (AI_SCOPE_LABEL[d.scope] ?? d.scope) : null;
  // Description from frontmatter (skills, agents, output styles) — fall
  // back to the per-kind explainer when nothing user-facing was parsed.
  const descSource = d.description || explainer;
  const scopeHtml = scopeLabel
    ? `<span class="weave-tt-sep">·</span><span class="weave-tt-muted">${escHtml(scopeLabel)}</span>`
    : "";
  const pathHtml = d.path
    ? `<div class="weave-tt-next"><span class="weave-tt-next-label">path:</span> <span class="weave-tt-next-text"><code>${escHtml(d.path)}</code></span></div>`
    : "";
  // Precedence badge (TKT-237) when scope-overlap puts this node on the
  // losing side.
  const precHtml = d.precedence && d.precedence !== "WINNING"
    ? `<div class="weave-tt-next"><span class="weave-tt-next-label">precedence:</span> <span class="weave-tt-next-text">${escHtml(d.precedence)}</span></div>`
    : "";
  tt.innerHTML = `
    <div class="weave-tt-title">${escHtml(d.label)}</div>
    <div class="weave-tt-meta">
      <span class="weave-tt-muted">${escHtml(d.kind ?? "")}</span>
      ${scopeHtml}
    </div>
    <div class="weave-tt-next" style="border-top:none;padding-top:4px;margin-top:4px">${escHtml(descSource)}</div>
    ${pathHtml}
    ${precHtml}`;
  tt.hidden = false;
  positionTooltip(evt);
}

function infoLine(kind, data) {
  const n = (data.nodes ?? []).length;
  const e = (data.edges ?? []).length;
  const built = data.meta?.built?.slice(0, 16).replace("T", " ") ?? "?";
  if (kind === "repo-map") {
    const c = data.meta?.counts ?? {};
    const w = data.meta?.warnings?.length ?? 0;
    const langs = Object.keys(c)
      .filter((k) => !["dirs", "files", "totalFiles", "imports"].includes(k))
      .map((k) => `${c[k]} ${k}`)
      .join(" · ");
    return `${c.totalFiles ?? n} files · ${c.dirs ?? 0} dirs · ${c.imports ?? 0} imports${langs ? " · " + langs : ""}${w ? ` · ${w} warn` : ""} · ${built}`;
  }
  if (kind === "skills") {
    const c = data.meta?.counts ?? {};
    const w = data.meta?.warnings?.length ?? 0;
    const edgeBreakdown = `${c.parentEdges ?? 0}p/${c.handoffEdges ?? 0}h`;
    return `${c.skills ?? 0} skills · ${c.orchestrators ?? 0} orchestrators · ${c.leaves ?? 0} leaves · ${c.edges ?? 0} edges (${edgeBreakdown}) · ${c.orphans ?? 0} orphans · ${w} warn · ${built}`;
  }
  if (kind === "ai") {
    const c = data.meta?.counts ?? {};
    const w = data.meta?.warnings?.length ?? 0;
    // Stash for the click-to-expand handler.
    window.__weaveWarnings = data.meta?.warnings ?? [];
    const warnHtml = w > 0
      ? ` · <span class="warn-pill" title="click for details" style="cursor:pointer;text-decoration:underline dotted">${w} warn</span>`
      : ` · 0 warn`;
    return `${c.skills ?? 0} skills · ${c.agents ?? 0} agents · ${c.hooks ?? 0} hooks · ${c.mcp ?? 0} mcp · ${c.outputStyles ?? 0} styles · ${c.plugins ?? 0} plugins · ${c.tools ?? 0} tools · ${c.edges ?? 0} edges · ${c.orphans ?? 0} orphans${warnHtml} · ${built}`;
  }
  return `${n} nodes · ${e} edges · built ${built}`;
}

$("#layout").addEventListener("change", () => {
  // Re-run layout in place without refetching data.
  runLayout();
});
$("#filter").addEventListener("input", () => {
  clearFocusClasses();
  applyTextFilter();
});
$("#rebuild").addEventListener("click", () => load(true));
$("#reset-layout").addEventListener("click", () => {
  // Drop the saved arrangement for this kind and snap back to auto-layout.
  try {
    localStorage.removeItem(posKey(currentKind()));
  } catch {
    /* ignore */
  }
  runLayout();
  if (cy) cy.fit(undefined, 24);
});

// Click the warning count in the info line to surface the warning list
// (ADR-004 DRAFT-4). Cheaper than a dedicated panel; matches the
// dashboard's existing "info-line is the bar" pattern.
$("#info").addEventListener("click", (e) => {
  const target = e.target;
  if (!(target instanceof Element)) return;
  if (!target.classList.contains("warn-pill")) return;
  const warnings = window.__weaveWarnings ?? [];
  if (warnings.length === 0) return;
  const lines = warnings.map((w) => `${w.kind}: ${w.detail}`).join("\n");
  alert(`${warnings.length} warning(s)\n\n${lines}`);
});

function clearFocusClasses() {
  if (cy) cy.elements().removeClass("highlight");
}

// Pre-select the default layout in the dropdown so a fresh page load
// uses the kind-appropriate layout (ai → cose; everything else → dagre).
// load() reads $("#layout").value, so this must be set BEFORE load fires.
$("#layout").value = defaultLayout(currentKind());

// Reveal the legend matching the current kind; hide the others.
for (const k of ["tickets", "repo-map", "skills", "ai"]) {
  const el = document.getElementById(`legend-${k}`);
  if (el) el.hidden = k !== currentKind();
}

// AI graph: surface the kind-aware search hint in the filter input
// placeholder so the behavior is discoverable without a separate UI.
if (currentKind() === "ai") {
  const f = $("#filter");
  if (f) f.placeholder = "filter by name or kind (try: hook, mcp, agent)…";
}

// Edge-mode filter only makes sense on /graphs/skills (parent/handoff/cite
// taxonomy). Show the control there, leave it hidden everywhere else.
const edgeModeLabel = document.getElementById("edge-mode-label");
if (edgeModeLabel) edgeModeLabel.hidden = currentKind() !== "skills";

function applyEdgeMode() {
  if (!cy) return;
  const mode = document.getElementById("edge-mode")?.value ?? "all";
  cy.edges('[kind="connects_to"]').forEach((edge) => {
    const k = edge.data("edgeKind") ?? "handoff";
    const visible = mode === "all" || (mode === "parent" && k === "parent");
    edge.style("display", visible ? "element" : "none");
  });
  // Re-run layout so the visible-edges-only view doesn't keep stale positions.
  runLayout();
}
document.getElementById("edge-mode")?.addEventListener("change", applyEdgeMode);

// Mark the active sub-nav entry.
for (const a of document.querySelectorAll("#subnav a")) {
  a.classList.toggle("active", a.dataset.kind === currentKind());
}

// Title bar: name the current view + say what you can do here. The subtitle
// doubles as the click instruction so it's always visible, not buried in the
// collapsed legend.
const GRAPH_TITLES = {
  "repo-map":  ["Repo map", "directories · files · relative-import edges across your codebase · click a node to focus its lineage"],
  tickets:     ["Tickets", "depends_on · blocks · related across the .tickets board · click a node to open it"],
  skills:      ["Skills", "skill orchestration (connects_to / kind) · click a node to focus its lineage"],
  ai:          ["AI ecosystem", "skills · agents · hooks · MCP · tools · click a node to focus its lineage"],
};
{
  const [name, sub] = GRAPH_TITLES[currentKind()] ?? [currentKind(), ""];
  const nameEl = document.getElementById("graph-title-name");
  const subEl = document.getElementById("graph-title-sub");
  if (nameEl) nameEl.textContent = name;
  if (subEl) subEl.textContent = sub;
}

document.title = `weave graphs · ${currentKind()}`;
load(false).catch((e) => {
  $("#info").textContent = "error: " + e.message;
});
