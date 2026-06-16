import { join } from "node:path";
import { readdir, readFile, stat } from "node:fs/promises";
import { parse } from "../frontmatter.ts";
import { SKILLS_ROOT } from "../../weave.config.ts";

export type SkillKind = "orchestrator" | "audit" | "action" | "generator" | "utility" | "specialized" | "workflow" | "leaf";

export type SkillNode = {
  data: {
    id: string;
    label: string;
    kind: SkillKind;
    description?: string;
    whenToUse?: string;
    path: string;
    orphan?: boolean;
  };
};

export type SkillEdgeKind = "parent" | "handoff";

export type SkillEdge = {
  data: {
    id: string;
    source: string;
    target: string;
    kind: "connects_to";
    edgeKind: SkillEdgeKind;
  };
};

const EDGE_KIND_PREFIXES = new Set<SkillEdgeKind>(["parent", "handoff"]);

function parseConnectsToEntry(raw: string): { target: string; edgeKind: SkillEdgeKind } {
  // Items can be either bare slug (legacy = handoff) or `kind:slug`.
  // Slug is kebab-case (no colons), so a single `:` cleanly separates.
  const idx = raw.indexOf(":");
  if (idx === -1) return { target: raw, edgeKind: "handoff" };
  const maybeKind = raw.slice(0, idx).trim();
  const maybeTarget = raw.slice(idx + 1).trim();
  if (EDGE_KIND_PREFIXES.has(maybeKind as SkillEdgeKind)) {
    return { target: maybeTarget, edgeKind: maybeKind as SkillEdgeKind };
  }
  // Unknown prefix → treat the whole string as a slug.
  return { target: raw, edgeKind: "handoff" };
}

export type SkillGraph = {
  nodes: SkillNode[];
  edges: SkillEdge[];
  meta: {
    built: string;
    counts: {
      skills: number;
      orchestrators: number;
      leaves: number;
      edges: number;
      orphans: number;
      parentEdges: number;
      handoffEdges: number;
    };
    warnings: Array<{ kind: string; detail: string }>;
  };
};

// SKILLS_ROOT comes from weave.config.ts so it honors WEAVE_REPO_ROOT / weave.config.json.

const VALID_KINDS = new Set<SkillKind>([
  "orchestrator", "audit", "action", "generator", "utility", "specialized", "workflow", "leaf",
]);

function truncate(s: string | undefined, n: number): string | undefined {
  if (!s) return undefined;
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

export async function buildSkillGraph(): Promise<SkillGraph> {
  let entries;
  try {
    entries = await readdir(SKILLS_ROOT, { withFileTypes: true });
  } catch {
    return { nodes: [], edges: [], meta: { built: new Date().toISOString(), counts: { skills: 0, orchestrators: 0, leaves: 0, edges: 0, orphans: 0, parentEdges: 0, handoffEdges: 0 }, warnings: [] } };
  }
  const slugs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();

  type Parsed = {
    slug: string;
    description?: string;
    whenToUse?: string;
    connectsTo: Array<{ target: string; edgeKind: SkillEdgeKind }>;
    kind?: SkillKind;
    hasWhenToUse: boolean;
    hasConnectsTo: boolean;
  };

  const parsed: Parsed[] = [];
  const warnings: Array<{ kind: string; detail: string }> = [];

  for (const slug of slugs) {
    const file = join(SKILLS_ROOT, slug, "SKILL.md");
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch {
      continue;
    }
    const { frontmatter } = parse(raw);
    const fm = frontmatter as Record<string, unknown>;

    const description = typeof fm.description === "string" ? fm.description : undefined;
    const whenToUse = typeof fm.when_to_use === "string" ? fm.when_to_use : undefined;
    const rawConnects = fm.connects_to;
    const connectsTo = Array.isArray(rawConnects) ? rawConnects.map(String).map(parseConnectsToEntry) : [];
    const rawKind = typeof fm.kind === "string" ? fm.kind : undefined;
    const kind = rawKind && VALID_KINDS.has(rawKind as SkillKind) ? (rawKind as SkillKind) : undefined;

    parsed.push({
      slug,
      description,
      whenToUse,
      connectsTo,
      kind,
      hasWhenToUse: typeof fm.when_to_use === "string" && fm.when_to_use !== "",
      hasConnectsTo: rawConnects !== undefined,
    });

    if (!parsed[parsed.length - 1].hasWhenToUse) {
      warnings.push({ kind: "missing-when-to-use", detail: slug });
    }
    if (!parsed[parsed.length - 1].hasConnectsTo) {
      warnings.push({ kind: "missing-connects-to", detail: slug });
    }
  }

  const knownSlugs = new Set(parsed.map((p) => p.slug));
  const outDegree = new Map<string, number>();
  const inDegree = new Map<string, number>();
  for (const p of parsed) {
    outDegree.set(p.slug, 0);
    inDegree.set(p.slug, 0);
  }
  const validEdges: Array<{ source: string; target: string; edgeKind: SkillEdgeKind }> = [];
  const parentCount = new Map<string, number>();
  for (const p of parsed) {
    for (const { target, edgeKind } of p.connectsTo) {
      if (!knownSlugs.has(target)) {
        warnings.push({ kind: "broken-connect", detail: `${p.slug} → ${target}` });
        continue;
      }
      validEdges.push({ source: p.slug, target, edgeKind });
      outDegree.set(p.slug, (outDegree.get(p.slug) ?? 0) + 1);
      inDegree.set(target, (inDegree.get(target) ?? 0) + 1);
      if (edgeKind === "parent") {
        parentCount.set(target, (parentCount.get(target) ?? 0) + 1);
      }
    }
  }
  // Multi-parent is a smell — exactly one parent edge per target is the convention.
  for (const [target, n] of parentCount.entries()) {
    if (n > 1) warnings.push({ kind: "multi-parent", detail: `${target} has ${n} parent edges` });
  }

  const nodes: SkillNode[] = parsed.map((p) => {
    const out = outDegree.get(p.slug) ?? 0;
    const inc = inDegree.get(p.slug) ?? 0;
    const inferred: SkillKind = p.kind ?? (out >= 2 && inc === 0 ? "orchestrator" : "leaf");
    const orphan = out === 0 && inc === 0;
    return {
      data: {
        id: p.slug,
        label: p.slug,
        kind: inferred,
        description: truncate(p.description, 600),
        whenToUse: truncate(p.whenToUse, 400),
        path: `.claude/skills/${p.slug}/SKILL.md`,
        ...(orphan ? { orphan: true } : {}),
      },
    };
  });

  const edges: SkillEdge[] = validEdges.map((e, i) => ({
    data: { id: `e${i}`, source: e.source, target: e.target, kind: "connects_to", edgeKind: e.edgeKind },
  }));

  const orchestrators = nodes.filter((n) => n.data.kind === "orchestrator").length;
  const leaves = nodes.length - orchestrators;
  const orphans = nodes.filter((n) => n.data.orphan).length;

  return {
    nodes,
    edges,
    meta: {
      built: new Date().toISOString(),
      counts: {
        skills: nodes.length,
        orchestrators,
        leaves,
        edges: edges.length,
        orphans,
        parentEdges: edges.filter((e) => e.data.edgeKind === "parent").length,
        handoffEdges: edges.filter((e) => e.data.edgeKind === "handoff").length,
      },
      warnings,
    },
  };
}

// Source-file glob for cache-freshness check. Exported so the server can
// stat the newest SKILL.md without re-parsing.
export async function skillSourceMtimes(): Promise<number> {
  let entries;
  try {
    entries = await readdir(SKILLS_ROOT, { withFileTypes: true });
  } catch {
    return 0;
  }
  let newest = 0;
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    try {
      const s = await stat(join(SKILLS_ROOT, e.name, "SKILL.md"));
      if (s.mtimeMs > newest) newest = s.mtimeMs;
    } catch {
      // skip
    }
  }
  return newest;
}
