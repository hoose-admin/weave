# CVSS-Anchored Scoring

Maps subskill self-rated severity (P0/P1/P2) to **CVSS v3.1 base score bands** so cross-skill findings are comparable. Full spec: https://www.first.org/cvss/v3-1/specification-document

## Score bands

| Tier | CVSS band | Meaning | Typical action window |
|---|---|---|---|
| **P0** | 7.0–10.0 (High / Critical) | Actively exploitable; immediate risk | within days |
| **P1** | 4.0–6.9 (Medium) | Exploitable under conditions; latent risk | within weeks |
| **P2** | 0.1–3.9 (Low / Info) | Best-practice / defense-in-depth | next sprint or queue |

These bands are the official CVSS v3.1 qualitative ratings (excluding "None" = 0.0). The orchestrator uses them to:

1. Normalize subskill self-ratings (which use the same P0/P1/P2 labels but locally — calibration drifts between skills).
2. Stamp a `severity` field on every emitted finding for cross-skill consistency.
3. Order the merged report (P0 → P1 → P2).

## Stamping rules

For every subskill finding:

1. Preserve the subskill's self-rated `severity` as `source_severity`.
2. If the subskill supplied a `cvss` vector (rare; not yet populated by the 3 subskills): map the base score to the band and stamp that as the canonical `severity`.
3. If no CVSS vector: trust the subskill's self-rating. Subskills are calibrated against their domain-specific severity ceilings in their own `CHECK_CATALOG.md`.
4. NEVER fabricate a CVSS vector. Leave the `cvss` field blank if the subskill didn't supply one.

## Cross-skill calibration check

When two subskills surface the same finding (post-dedup), their `source_severity` should be the same. If not, take the worse (higher severity) — and emit an informational note: "subskill calibration mismatch on `<finding-id>`: backend=P0, gcp=P1 — using P0". The mismatch is itself useful signal; surface it.

## CVSS vector reference (for future enrichment)

When subskills start emitting CVSS vectors directly, the orchestrator can use these to build the base score:

Format: `CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H`

- **AV** (Attack Vector): N=Network, A=Adjacent, L=Local, P=Physical
- **AC** (Attack Complexity): L=Low, H=High
- **PR** (Privileges Required): N=None, L=Low, H=High
- **UI** (User Interaction): N=None, R=Required
- **S** (Scope): U=Unchanged, C=Changed
- **C/I/A** (Confidentiality/Integrity/Availability): N=None, L=Low, H=High

Worked example — a Firestore `subscriptionActive` privesc:
- Vector: `CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H` → base score 8.8 (High → **P0**)
- Justification: network-attackable, low complexity (any authed user can self-elevate), low privs required (must be authed), no user interaction, unchanged scope, all CIA impacts high (paid features become free)

Calculator: https://www.first.org/cvss/calculator/3.1

## What this file does NOT do

- Compute CVSS scores. Subskills supply them or the orchestrator leaves the field blank.
- Override subskill self-ratings without justification. The mismatch surfaces; the user decides.
- Score findings outside this project's threat model (the calibration is project-specific, not generic enterprise).
