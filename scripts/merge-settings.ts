// Idempotently merge weave's hook entries (settings.template.json) into a
// target `.claude/settings.json`, creating it if absent and never duplicating
// an entry that's already there.
//
//   bun merge-settings.ts <template.json> <target-settings.json>

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const [tplPath, tgtPath] = process.argv.slice(2);
if (!tplPath || !tgtPath) {
  console.error("usage: bun merge-settings.ts <template.json> <target.json>");
  process.exit(2);
}

const tpl = JSON.parse(readFileSync(tplPath, "utf8"));
const tgt: Record<string, any> = existsSync(tgtPath)
  ? JSON.parse(readFileSync(tgtPath, "utf8"))
  : {};

const sig = (h: unknown) => JSON.stringify(h);

tgt.hooks ??= {};
for (const [event, entries] of Object.entries(tpl.hooks ?? {})) {
  tgt.hooks[event] ??= [];
  const seen = new Set((tgt.hooks[event] as unknown[]).map(sig));
  for (const entry of entries as unknown[]) {
    if (!seen.has(sig(entry))) tgt.hooks[event].push(entry);
  }
}
if (tpl.$schema && !tgt.$schema) tgt.$schema = tpl.$schema;

writeFileSync(tgtPath, JSON.stringify(tgt, null, 2) + "\n");
console.log(`merged weave hooks into ${tgtPath}`);
