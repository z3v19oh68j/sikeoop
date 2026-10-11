import type { CcAttack, CcChainDetail, CcClaim, CcResult } from "./types";

// Chain-Centric's four zones, recomputed from its output. Its own map is only rendered text
// (session.py _render_divergence_map, lines 713-828); this follows the same rules so the panel
// shows what the text would say, but as data. Pure: used by the main process and the renderer.

/** Its tiers: unscrutinized → 未审查区, ironclad / consensus → 共识区, contested → 争议区, weak → 崩塌区. */
export type ResearchTier = "unscrutinized" | "ironclad" | "consensus" | "contested" | "weak";
export type ResearchZone = "unscrutinized" | "consensus" | "contested" | "collapsed";

export const ZONE_OF: Record<ResearchTier, ResearchZone> = {
  unscrutinized: "unscrutinized",
  ironclad: "consensus",
  consensus: "consensus",
  contested: "contested",
  weak: "collapsed",
};

export interface ResearchClaimView {
  claim: CcClaim;
  tier: ResearchTier;
  zone: ResearchZone;
  /** Active chains / all chains of the claim (1 when it has none), as in session.py. */
  survivalRate: number;
  trust: number;
  chains: CcChainDetail[];
  /** Attacks whose target chain belongs to this claim. */
  attacks: CcAttack[];
}

export interface ResearchZones {
  claims: ResearchClaimView[];
  /** Claims by zone, in the output's order. Claims without a description are left out of the
   * unscrutinized, consensus and collapsed zones, as the original map does. */
  zones: Record<ResearchZone, ResearchClaimView[]>;
  /** Broken chains: shown in the collapsed zone next to weak claims. */
  brokenChains: CcChainDetail[];
}

export function tierOf(alpha: number, attacks: number, survivalRate: number): ResearchTier {
  if (attacks === 0) return "unscrutinized";
  if (alpha > 0.7 && attacks >= 5 && survivalRate > 0.5) return "ironclad";
  if (alpha > 0.7 && attacks < 5 && survivalRate > 0.5) return "consensus";
  if (alpha > 0.3) return "contested";
  return "weak";
}

/** "<agent>/<chain_id>/step<n>" → chain_id. */
export function targetChain(target: string): string {
  const parts = target.split("/");
  return parts.length >= 3 ? parts.slice(1, -1).join("/") : parts[1] ?? "";
}

export function researchZones(result: Pick<CcResult, "claims" | "chain_details" | "attacks">): ResearchZones {
  const chainsOf = new Map<string, CcChainDetail[]>();
  for (const c of result.chain_details) {
    const list = chainsOf.get(c.claim_id) ?? [];
    list.push(c);
    chainsOf.set(c.claim_id, list);
  }
  const claimOfChain = new Map(result.chain_details.map((c) => [c.chain_id, c.claim_id]));
  const attacksOf = new Map<string, CcAttack[]>();
  for (const a of result.attacks) {
    const claimId = claimOfChain.get(targetChain(a.target));
    if (!claimId) continue;
    const list = attacksOf.get(claimId) ?? [];
    list.push(a);
    attacksOf.set(claimId, list);
  }

  const claims = result.claims.map((claim): ResearchClaimView => {
    const chains = chainsOf.get(claim.claim_id) ?? [];
    const survivalRate = chains.length ? chains.filter((c) => c.status === "active").length / chains.length : 1;
    const trust = (claim.alpha * (1 + survivalRate)) / 2 * (1 - Math.exp(-1.5 * claim.attacks));
    const tier = tierOf(claim.alpha, claim.attacks, survivalRate);
    return { claim, tier, zone: ZONE_OF[tier], survivalRate, trust, chains, attacks: attacksOf.get(claim.claim_id) ?? [] };
  });

  const zones: Record<ResearchZone, ResearchClaimView[]> = { unscrutinized: [], consensus: [], contested: [], collapsed: [] };
  for (const v of claims) {
    if (!v.claim.description.trim() && v.zone !== "contested") continue;
    zones[v.zone].push(v);
  }
  return { claims, zones, brokenChains: result.chain_details.filter((c) => c.status === "broken") };
}
