// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { researchZones, targetChain, tierOf } from "../../src/shared/research.ts";
import type { CcResult } from "../../src/shared/types.ts";

test("tiers follow session.py _render_divergence_map", () => {
  assert.equal(tierOf(0.9, 0, 1), "unscrutinized");
  assert.equal(tierOf(0.9, 6, 1), "ironclad");
  assert.equal(tierOf(0.9, 3, 0.6), "consensus");
  assert.equal(tierOf(0.9, 3, 0.5), "contested");
  assert.equal(tierOf(0.5, 9, 1), "contested");
  assert.equal(tierOf(0.2, 9, 1), "weak");
});

test("attack targets name their chain", () => {
  assert.equal(targetChain("agent_1/ch_3/step2"), "ch_3");
  assert.equal(targetChain("agent_1/a/b/step0"), "a/b");
});

test("claims land in zones with survival, trust and their attacks", () => {
  const steps = [{ step_id: "s1", assertion: "x", evidence: [], depends_on: [] }];
  const r: Pick<CcResult, "claims" | "chain_details" | "attacks"> = {
    claims: [
      { claim_id: "A", description: "amyloid", alpha: 0.9, U: 1, state: "TRUE_CONSENSUS", chains: 2, attacks: 6, evidence_count: 4 },
      { claim_id: "B", description: "microglia", alpha: 0.5, U: 2, state: "RICH_DISAGREEMENT", chains: 1, attacks: 2, evidence_count: 2 },
      { claim_id: "C", description: "untouched", alpha: 0.8, U: 0, state: "EVIDENCE_STARVED", chains: 1, attacks: 0, evidence_count: 1 },
      { claim_id: "D", description: "", alpha: 0.1, U: 0, state: "", chains: 1, attacks: 1, evidence_count: 0 },
    ],
    chain_details: [
      { chain_id: "c1", agent: "agent_0", version: 1, claim_id: "A", status: "active", steps },
      { chain_id: "c2", agent: "agent_1", version: 1, claim_id: "A", status: "broken", steps },
      { chain_id: "c3", agent: "agent_2", version: 1, claim_id: "B", status: "active", steps },
    ],
    attacks: [
      { attack_id: "x1", attacker: "agent_1", target: "agent_0/c1/step1", claim_preview: "weak" },
      { attack_id: "x2", attacker: "agent_0", target: "agent_2/c3/step1", claim_preview: "hmm" },
    ],
  };
  const z = researchZones(r);
  const a = z.claims.find((c) => c.claim.claim_id === "A")!;
  assert.equal(a.survivalRate, 0.5);
  assert.equal(a.tier, "contested"); // survival 0.5 is not > 0.5
  assert.equal(a.attacks.length, 1);
  assert.ok(Math.abs(a.trust - 0.9 * 1.5 / 2 * (1 - Math.exp(-9))) < 1e-9);
  assert.deepEqual(z.zones.unscrutinized.map((v) => v.claim.claim_id), ["C"]);
  assert.deepEqual(z.zones.contested.map((v) => v.claim.claim_id), ["A", "B"]);
  // D is weak but has no description: left out like the original map.
  assert.deepEqual(z.zones.collapsed.map((v) => v.claim.claim_id), []);
  assert.deepEqual(z.brokenChains.map((c) => c.chain_id), ["c2"]);
});
