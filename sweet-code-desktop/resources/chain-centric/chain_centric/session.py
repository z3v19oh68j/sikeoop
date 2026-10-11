"""
Chain-Centric Session — Orchestrates the three independent layers (SS3.2).

Evidence Layer -> Content Layer -> Coordination Layer
"""

from __future__ import annotations

import json, time, sys

from .config import Config
from .layers.evidence_layer import EvidenceLayer
from .layers.content_layer import (
    ContentLayer, ActionType, ChainStatus, AttackStatus, AgentOutput,
    call_agent, parse_json_output, SYSTEM_PROMPT, CHAIN_TEMPLATE, ATTACK_TEMPLATE,
    parse_agent_output, validate_output,
)
from .layers.coordination_layer import (
    Claim, ChainState,
    compute_alpha, compute_U, compute_focus,
    compute_H_evidence, compute_S_attack, compute_H_part,
    compute_H_chain, compute_T_max, compute_H_remaining, compute_ApEn,
    compute_S_novel,
    classify_chainstate, check_termination,
    HsymObserver,
)


class Session:
    """Orchestrates Evidence, Content, and Coordination layers per SS3.2."""

    def __init__(self, config: Config, question: str):
        self.cfg = config
        self.question = question
        self.sc = config.session

        # --- Three independent layers ---
        self.evidence = EvidenceLayer(config.evidence_llm or config.agents[0])
        self.content = ContentLayer(config.agents)
        # Coordination is stateless -- computed fresh each round

        # --- State ---
        self.round = 0
        self.claims: dict[str, Claim] = {}
        self.entropy_history: list[dict] = []
        self.global_seq: list[int] = []
        self.termination_cons = 0
        self.terminated = False
        self.termination_reason = ""
        self.focus_claims: list[Claim] = []
        self.focus_data: list[dict] = []
        self.token_est = {"input": 0, "output": 0, "calls": 0}
        self.fast_consensus_flagged = False
        self._semantic_snapshot_taken = False  # §6.3.8: capture when content first stabilizes
        self._prev_focus_ids: set[str] = set()
        self._search_gap_detected = False
        from .layers.coordination_layer import EloSystem
        self.elo = EloSystem()

        # §6.8 H_sym observer — per-session instance, no global state
        self._hsym_observer = HsymObserver()

        # §6.8 H_sym convergence state
        self._hsym_dist: dict[str, float] = {}  # p_i: symbol→probability
        self._hsym_history: list[float] = []     # H_sym per round
        self._hsym_consecutive: int = 0          # consecutive rounds without new symbols
        self._hsym_last_symbol: str = ""         # symbol string from previous round
        self._hsym_new_symbols_5r: list[int] = []  # new-symbol count per round (5r window)
        self._hsym_max_dist_size: int = 50       # cap dict growth for long sessions
        self._hsym_min_symbols: int = 0          # set adaptively after observation window locks

        # Initialize evidence (Round 0)
        task_info = self.evidence.initialize(question)
        # §4.4: Perspective seeds are optional. Default: empty (no seeds).
        # Heterogeneous models provide sufficient diversity without them.
        self.perspectives = [''] * len(self.content.agent_names)

    # ============================================================
    # Main Loop (SS3.2)
    # ============================================================

    def run(self, checkpoint_path: str = "") -> dict:
        print(f"\n{'='*60}")
        print(f"Chain-Centric Session")
        print(f"Q: {self.question[:100]}")
        print(f"Task: {self.evidence.task_info.get('task_type','?')}")
        print(f"Agents: {len(self.content.agent_names)} | "
              f"Models: {[c.provider for c in self.content.agents]}")
        print(f"Evidence: {len(self.evidence.pool.items)} items")
        print(f"{'='*60}\n")

        while not self.terminated and (
            self.sc.max_rounds is None or self.round < self.sc.max_rounds
        ):
            self._run_round()
            # Auto-save every round so data survives crashes
            if checkpoint_path and self.round > 0:
                import json, os
                partial = self._build_summary()
                partial["chain_statuses"] = self.get_chain_status_report()
                os.makedirs(os.path.dirname(checkpoint_path) or '.', exist_ok=True)
                with open(checkpoint_path, 'w') as f:
                    json.dump(partial, f, indent=2, default=str, ensure_ascii=False)

        return self._build_summary()

    def _run_round(self):
        print(f"\n-- Round {self.round} --")

        # Step 1: Evidence search — demand-driven (§5): only when focus changes,
        # gaps detected, or dynamic triggers fire. NOT every round.
        if self.round > 0 and self._should_search():
            self.evidence._token_tracker = self.token_est
            focus_for_search = [
                {"claim_id": c.claim_id, "state": c.state.value,
                 "description": c.description}
                for c in self.focus_claims
            ]
            attack_previews = [
                {"attack_id": a.attack_id, "attacker": a.attacker,
                 "target_step": a.target_step_id, "claim_preview": a.claim[:150]}
                for a in list(self.content.attacks.values())[-10:]
            ]
            n = self.evidence.search_for_focus(
                focus_for_search, attack_previews, self.round)
            self._search_gap_detected = (n == 0)
            print(f"  [Evidence] {'+'+str(n) if n else 'no'} new evidence "
                  f"(pool: {len(self.evidence.pool.items)})")
        elif self.round > 0:
            print(f"  [Evidence] skipped — no trigger (focus unchanged, no gaps)")

        # Steps 2-5: Compose echoes, call agents concurrently (§24), parse, validate
        def echo_fn(name):
            idx = self.content.agent_names.index(name)
            perspective = self.perspectives[idx] if self.round == 0 else ""
            review = self.content.get_review_targets(name)
            # Threats: attacks against this agent's chains
            threats = []
            for attack in self.content.attacks.values():
                if attack.target_agent == name and attack.status == AttackStatus.PENDING:
                    threats.append({
                        "chain_id": attack.target_chain_id,
                        "step_id": attack.target_step_id,
                        "attacker": attack.attacker,
                        "claim": attack.claim[:250],
                    })
            return self.evidence.compose_echo(
                name, self.question, self.focus_data,
                self._recent_activity(), perspective, self.round, review,
                threats=threats if threats else None)

        self.content.token_tracker = self.token_est
        outputs = self.content.collect_round(echo_fn, self.round,
                                             self.evidence.pool.refs)

        # Step 5.5: Process evidence requests — search executor verifies before adding
        for out in outputs:
            if out.evidence_request:
                query = out.evidence_request[:200]
                print(f"  [EvidenceReq] {out.agent} requests: {query[:100]}")
                n = self.evidence.search_for_focus(
                    [{"claim_id": "agent_request", "state": "RICH_DISAGREEMENT",
                      "description": query}],
                    [], self.round)
                if n:
                    print(f"  [EvidenceReq] +{n} verified items from request")

        # Step 6: Apply to shared ledger
        self.content.apply_to_ledger(outputs, self.round)
        self.global_seq.append(
            1 if any(o.action != ActionType.PASS for o in outputs) else 0)

        # Step 6.5: Attack resolution + pruning
        self._resolve_attacks()
        self._auto_resolve_attacks()
        self._prune_stale_chains()
        self._update_elo()

        # Step 7: Coordination layer recomputes
        if self.content.chains or self.content.attacks:
            self._coordinate()

        # Step 7.5: Fast consensus detection (§7)
        if self._detect_fast_consensus():
            self.fast_consensus_flagged = True
            print("  [FastConsensus] Adversarial prompt triggered for next round")

        # Step 8: Check termination
        if self.round >= self.sc.min_rounds_before_termination:
            self._check_termination()

        self.round += 1

    def _detect_shallow_consensus(self) -> bool:
        """Detect when all claims agree on 'what' but not 'how'.

        If all TRUE_CONSENSUS claims lack mechanism keywords, the
        discussion is shallow — trigger deeper evidence search.
        """
        mechanism_keywords = ['because', 'due to', 'mechanism', 'internal',
                             'limit', 'threshold', 'exceed', 'overflow',
                             'queue', 'lock', 'contention', 'partition']
        true_claims = [c for c in self.claims.values()
                      if getattr(c, 'state', None) == ChainState.TRUE_CONSENSUS]
        if len(true_claims) < 2:
            return False
        shallow_count = sum(1 for c in true_claims
                          if not any(kw in c.description.lower()
                                    for kw in mechanism_keywords))
        if shallow_count == len(true_claims) and len(true_claims) >= 2:
            print(f"  [ShallowConsensus] {shallow_count}/{len(true_claims)} "
                  f"claims lack mechanism. Triggering deep search.")
            return True
        return False

    def _prune_stale_chains(self):
        """§26: Auto-archive chains inactive for >10 rounds."""
        for chain in list(self.content.chains.values()):
            if (chain.status == ChainStatus.ACTIVE and
                self.round - chain.last_modified > 10 and
                chain.attacks_received == 0):
                chain.status = ChainStatus.ARCHIVED

    def _auto_resolve_attacks(self):
        """§5: Auto-resolve attacks. After 5 rounds without revision,
        attack is SUSTAINED and target chain is BROKEN.
        Chains that stay active despite attacks → attacks_survived++."""
        # First, count surviving attacks on active chains
        for chain in self.content.chains.values():
            if chain.status == ChainStatus.ACTIVE and chain.attacks_received > 0:
                chain.attacks_survived = chain.attacks_received

        for attack in list(self.content.attacks.values()):
            if attack.status != AttackStatus.PENDING:
                continue
            if self.round - attack.round > 5:
                attack.status = AttackStatus.SUSTAINED
                target = self.content.chains.get(attack.target_chain_id)
                if target and target.status == ChainStatus.ACTIVE:
                    target.status = ChainStatus.BROKEN
                    target.attacks_survived = 0  # didn't survive
                    print(f"  [AutoResolve] {attack.attack_id} SUSTAINED → "
                          f"{attack.target_chain_id} BROKEN")

    # ============================================================
    # Fast Consensus Detection (§7)
    # ============================================================

    def _detect_fast_consensus(self):
        """§7: Detect premature agreement (zero attacks + low H_chain + 1 chain/claim).

        If all agents agree without collision, inject adversarial prompts.
        """
        total_attacks = len(self.content.attacks)
        if total_attacks > 0:
            return False

        if not self.entropy_history:
            return False

        Hc = self.entropy_history[-1].get("H_chain", 1.0)
        chains_per_claim = (
            len(self.content.chains) / max(len(self.claims), 1)
        )

        if Hc < 0.1 and chains_per_claim <= 1.0:
            print("  [FastConsensus] Detected: 0 attacks, H_chain<0.1, "
                  "≤1 chain/claim. Injecting adversarial prompt.")
            return True
        return False

    def _should_search(self) -> bool:
        """§5: Evidence search — triggered on any substantive change.

        Triggers:
        1. Focus claims changed from previous round
        2. Previous search detected evidence gaps
        3. Shallow consensus detected (need mechanism evidence)
        4. Any new attacks since last search (always search when collision is happening)
        5. Evidence pool is small (< 10 items) — bootstrap more
        """
        current_ids = {c.claim_id for c in self.focus_claims}
        if current_ids != self._prev_focus_ids:
            return True
        if self._search_gap_detected:
            return True
        if self._detect_shallow_consensus():
            return True
        recent_attacks = [a for a in self.content.attacks.values()
                         if a.round >= self.round - 2]
        if len(recent_attacks) >= 1:
            return True
        if len(self.evidence.pool.items) < 10:
            return True
        return False

    # ============================================================
    # Attack Resolution (§5)
    # ============================================================

    def _resolve_attacks(self):
        """Auto-settle attacks based on chain revisions.

        §5.2-5.3: When a chain is revised, pending attacks on its
        previous version are checked:
        - If the attacked step was modified → attack OVERRULED (defender won)
        - If the step was NOT modified → attack SUSTAINED (attacker won)
        - If target_version outdated → marked TARGET_OUTDATED
        """
        for attack in list(self.content.attacks.values()):
            if attack.status != AttackStatus.PENDING:
                continue

            target = self.content.chains.get(attack.target_chain_id)
            if not target:
                attack.status = AttackStatus.TARGET_OUTDATED
                continue

            # Check if target chain has been revised (version > attack's target version)
            # Since we don't track target_version yet, check for superseded-by chain
            superseded_by = None
            for chain in self.content.chains.values():
                if (chain.supersedes == attack.target_chain_id and
                    chain.version > target.version):
                    superseded_by = chain
                    break

            if superseded_by:
                revised_step = next(
                    (s for s in superseded_by.steps
                     if s.step_id == attack.target_step_id), None)
                if revised_step and revised_step.assertion != "":
                    # Step was repaired/modified → attack overruled
                    attack.status = AttackStatus.OVERRULED
                    target.attacks_survived += 1
                else:
                    # Revision didn't fix this step → attack sustained
                    attack.status = AttackStatus.SUSTAINED
                    if target.status == ChainStatus.ACTIVE:
                        target.status = ChainStatus.BROKEN

    def _update_elo(self):
        """§23: Update Elo ratings based on resolved attacks."""
        for attack in self.content.attacks.values():
            if attack.status == AttackStatus.SUSTAINED:
                self.elo.resolve(attack.attacker, attack.target_agent, attack.depth)
            elif attack.status == AttackStatus.OVERRULED:
                self.elo.resolve(attack.target_agent, attack.attacker, attack.depth)

    # ============================================================
    # Coordination
    # ============================================================

    def _coordinate(self):
        # Sync claims from chain data
        for chain in self.content.chains.values():
            if chain.claim_id not in self.claims:
                self.claims[chain.claim_id] = Claim(
                    claim_id=chain.claim_id,
                    description=chain.steps[0].assertion[:120] if chain.steps else "",
                    created_round=chain.created_at)
            c = self.claims[chain.claim_id]
            if chain.chain_id not in c.chains:
                c.chains.append(chain.chain_id)
            c.evidence_refs |= chain.all_evidence_refs
            c.last_active_round = max(c.last_active_round, chain.last_modified)

        for attack in self.content.attacks.values():
            tc = self.content.chains.get(attack.target_chain_id)
            if tc:
                claim = self.claims.get(tc.claim_id)
                if claim and attack.attack_id not in claim.attacks:
                    claim.attacks.append(attack.attack_id)

        all_claims = list(self.claims.values())

        # alpha
        alphas = {c.claim_id: compute_alpha(c, all_claims) for c in all_claims}

        # U
        recent_ev = self.evidence.pool.get_recent_additions(window=2)
        Us = {}
        for c in all_claims:
            Us[c.claim_id] = compute_U(
                c, self.round, self.content.chains,
                self.content.attacks, self.content.agent_names, recent_ev)

        for c in all_claims:
            c.alpha = alphas[c.claim_id]
            c.U = Us[c.claim_id]
            c.state = classify_chainstate(c.alpha, c.U)

        # Focus
        self.focus_claims = compute_focus(all_claims, alphas, Us,
                                          self.sc.max_focus_claims)
        self.focus_data = [
            {"claim_id": c.claim_id, "state": c.state.value,
             "description": c.description}
            for c in self.focus_claims
        ]

        # 7 entropies
        contrib_counts = {
            name: self.content.get_contribution_binary(name)
            for name in self.content.agent_names
        }
        active_chains = [c for c in self.content.chains.values()
                        if c.status == ChainStatus.ACTIVE]
        # S_novel: semantic novelty — are new chains saying something new?
        new_this_round = [c for c in active_chains if c.created_at == self.round]
        existing = [c for c in active_chains if c.created_at < self.round]
        S_novel = compute_S_novel(new_this_round, existing) if new_this_round else 0.0
        # Override with LLM-based S_novel for academic synonym handling
        if new_this_round and existing:
            llm_sn = self._compute_S_novel_llm(new_this_round, existing)
            if llm_sn is not None:
                S_novel = llm_sn

        entropies = {
            "H_evidence": compute_H_evidence(all_claims),
            "S_attack": compute_S_attack(all_claims),
            "H_part": compute_H_part(contrib_counts, self.content.agent_names),
            "H_chain": compute_H_chain(active_chains),
            "T_max": compute_T_max(self.content.contribution_history),
            "H_remaining": compute_H_remaining(all_claims, alphas, self.round),
            "ApEn": compute_ApEn(self.global_seq),
            "S_novel": S_novel,  # semantic novelty: 1=all new, 0=all redundant
        }

        # §6.8 H_sym: symbolic entropy convergence
        if self.cfg.session.termination_strategy == "hsym":
            symbol_key = self._hsym_observer.discretize(entropies, self.round)
            if symbol_key is not None:
                H_sym = self._update_hsym(symbol_key)
                entropies["H_sym"] = H_sym
                entropies["_symbol"] = symbol_key
        self.entropy_history.append(entropies)

        print(f"  Claims:{len(all_claims)} Chains:{len(active_chains)} "
              f"Attacks:{len(self.content.attacks)}")
        print(f"  Focus: {[c.claim_id for c in self.focus_claims]}")
        self._prev_focus_ids = {c.claim_id for c in self.focus_claims}
        # Display: primary termination signals, veto signals, diagnostics
        Tm = entropies['T_max']; Hc = entropies['H_chain']
        Sa = entropies['S_attack']; Hr = entropies['H_remaining']
        He = entropies['H_evidence']; Hp = entropies['H_part']
        Sn = entropies.get('S_novel', 0)
        Hsym = entropies.get("H_sym", None)
        hsym_str = f" Hsym={Hsym:.3f}" if Hsym is not None else ""
        print(f"  [VOTE] Tm={Tm:.3f} Hc={Hc:.3f} | "
              f"[VETO] Sa={Sa:.3f} Hr={Hr:.3f} | "
              f"[DIAG] He={He:.3f} Hp={Hp:.3f} | "
              f"[NOVEL] Sn={Sn:.3f}{hsym_str}")

        # Semantic snapshot: capture when content first stabilizes
        if Sn < 0.2 and not self._semantic_snapshot_taken and self.round > 3:
            self._semantic_snapshot_taken = True
            snapshot = self._build_summary()
            snapshot["snapshot_type"] = "semantic_convergence"
            snapshot["snapshot_round"] = self.round
            snapshot["S_novel"] = Sn
            import json as _json, os as _os
            import tempfile as _tf
            spath = _os.path.join(_os.path.expanduser('~'),
                     'semantic_snapshot_R' + str(self.round) + '.json')
            with open(spath, 'w') as f:
                _json.dump(snapshot, f, indent=2, default=str, ensure_ascii=False)
            print(f"  [Snapshot] Semantic convergence captured at R{self.round} → {spath}")
        for c in all_claims:
            print(f"    {c.claim_id}: a={c.alpha:.2f} U={c.U} [{c.state.value}]")

    # ============================================================
    # Termination
    # ============================================================

        # Track semantic novelty for termination
        if not hasattr(self, '_semantic_saturation_count'):
            self._semantic_saturation_count = 0

    def _check_termination(self):
        if not self.entropy_history:
            return
        e = self.entropy_history[-1]
        thr = self.sc.get_thresholds()

        # ── §6.8 H_sym Convergence (v3 strategy) ──
        if self.cfg.session.termination_strategy == "hsym":
            Hsym = e.get("H_sym")
            if Hsym is not None and self.round >= self.sc.hsym_min_rounds:
                # Evidence gate: reset count if new evidence entered
                pool_now = len(self.evidence.pool.items)
                if not hasattr(self, '_hsym_last_pool_size'):
                    self._hsym_last_pool_size = pool_now
                if pool_now > self._hsym_last_pool_size:
                    self._hsym_consecutive = 0
                    self._hsym_last_pool_size = pool_now
                # New claim gate: reset if a new claim appeared
                claim_now = len(self.claims)
                if not hasattr(self, '_hsym_last_claim_count'):
                    self._hsym_last_claim_count = claim_now
                if claim_now > self._hsym_last_claim_count:
                    self._hsym_consecutive = 0
                    self._hsym_last_claim_count = claim_now

                # Observe: did this round produce a new symbol?
                just_new = self._hsym_new_symbols_5r[-1] if self._hsym_new_symbols_5r else 1
                if just_new == 1:
                    # §Hamming: partial reset — micro-fluctuation ≠ total novelty
                    novelty = 1.0  # default: fully novel
                    if hasattr(self, '_hsym_last_symbol') and self._hsym_dist:
                        parts = self._hsym_last_symbol.split('|')
                        min_flips = len(parts)
                        for existing in self._hsym_dist:
                            ep = existing.split('|')
                            flips = sum(1 for c, e in zip(parts, ep) if c != e)
                            flips += abs(len(parts) - len(ep))
                            min_flips = min(min_flips, flips)
                        novelty = min_flips / max(len(parts), 1)
                    # novelty≈1 → full reset. novelty≈0.14 → keep ~86%.
                    self._hsym_consecutive = max(0, int(self._hsym_consecutive * (1.0 - novelty)))
                else:
                    self._hsym_consecutive += 1

                N = self.sc.termination_consecutive_rounds
                if self._hsym_consecutive >= N:
                    # §Topology veto: attack collapse ≠ convergence
                    recent_pairs = set()
                    for a in self.content.attacks.values():
                        if a.round >= self.round - 4:
                            recent_pairs.add((a.attacker, a.target_agent))
                    if len(recent_pairs) < 3 and self.round > 20:
                        print(f"  [H_sym] topology veto: only {len(recent_pairs)} attack pairs active — topology collapsed")
                    else:
                        # Guard: auto-calibrate min symbols from observation window variation
                        if self._hsym_min_symbols == 0:
                            obs = self._hsym_observer.observations
                            varied = 0
                            for k, vals in obs.items():
                                if len(vals) >= 3:
                                    rng = max(vals) - min(vals)
                                    avg = sum(vals) / len(vals)
                                    if rng > abs(avg) * 0.1:
                                        varied += 1
                            self._hsym_min_symbols = max(3, varied)
                        if len(self._hsym_dist) < self._hsym_min_symbols:
                            print(f"  [H_sym] stable but {len(self._hsym_dist)}/{self._hsym_min_symbols} symbols — continuing")
                        else:
                            self.terminated = True
                            self.termination_reason = "SYSTEM_STATE_STABILIZED"
                            print(f"  TERMINATED: {self.termination_reason} (no new symbols for {N} rounds)")
                            return

        # ── Legacy entropy-based termination (skipped in hsym mode) ──
        if self.cfg.session.termination_strategy != "hsym":

            Sn = e.get('S_novel', 1.0)
            # If new evidence entered pool this round, reset saturation counter
            # (discussion should re-ignite with fresh evidence)
            pool_now = len(self.evidence.pool.items)
            if not hasattr(self, '_last_pool_size'):
                self._last_pool_size = pool_now
            if pool_now > self._last_pool_size:
                self._semantic_saturation_count = 0
                self._last_pool_size = pool_now

            if Sn <= 0.1 and len(self.entropy_history) >= 3:
                self._semantic_saturation_count += 1
            else:
                self._semantic_saturation_count = 0
            if self._semantic_saturation_count >= 3:
                self.terminated = True
                self.termination_reason = "SEMANTIC_SATURATION"
                print(f"  TERMINATED: {self.termination_reason}")
                return

            # Path 1: Two-tier entropy convergence
            term, cons, reason = check_termination(
                e, thr, self.termination_cons,
                self.sc.termination_consecutive_rounds,
                self.round, self.sc.min_rounds_before_termination)
            self.termination_cons = cons
            if term:
                self.terminated = True
                self.termination_reason = f"ENTROPY_CONVERGED: {reason}"
                print(f"  TERMINATED: {self.termination_reason}")
                return

        # Path 2: Pass-counter — all agents pass for N consecutive rounds
        if len(self.global_seq) >= self.sc.termination_consecutive_rounds:
            recent = self.global_seq[-self.sc.termination_consecutive_rounds:]
            if all(v == 0 for v in recent):
                self.terminated = True
                self.termination_reason = "ALL_PASS_CONSECUTIVE"
                print(f"  TERMINATED: {self.termination_reason}")
                return

        # Path 3: Budget exhausted
        if self.sc.max_rounds is not None and self.round >= self.sc.max_rounds - 1:
            self.terminated = True
            self.termination_reason = "BUDGET_EXHAUSTED"
            print(f"  TERMINATED: {self.termination_reason}")

    # ============================================================
    # Helpers
    # ============================================================

    def _recent_activity(self) -> list[str]:
        acts = []
        for c in sorted(self.content.chains.values(),
                       key=lambda x: x.last_modified, reverse=True)[:5]:
            acts.append(f"[R{c.last_modified}] {c.agent} published "
                       f"{c.chain_id} v{c.version} ({c.step_count} steps)")
        for a in list(self.content.attacks.values())[-5:]:
            acts.append(f"[R{a.round}] {a.attacker} attacked "
                       f"{a.target_agent}/{a.target_chain_id}/step{a.target_step_id}")
        return acts

    def _build_summary(self) -> dict:
        return {
            "question": self.question,
            "task_type": self.evidence.task_info.get("task_type", ""),
            "total_rounds": self.round,
            "terminated": self.terminated,
            "termination_reason": self.termination_reason,
            "token_estimates": dict(self.token_est),
            "claims": [
                {"claim_id": c.claim_id, "description": c.description[:150],
                 "alpha": c.alpha, "U": c.U, "state": c.state.value,
                 "chains": len(c.chains), "attacks": len(c.attacks),
                 "evidence_count": len(c.evidence_refs)}
                for c in self.claims.values()
            ],
            "chains": [
                {"chain_id": c.chain_id, "agent": c.agent, "version": c.version,
                 "steps": c.step_count, "attacks_received": c.attacks_received}
                for c in self.content.chains.values()
            ],
            "attacks": [
                {"attack_id": a.attack_id, "attacker": a.attacker,
                 "target": f"{a.target_agent}/{a.target_chain_id}/step{a.target_step_id}",
                 "claim_preview": a.claim[:300]}
                for a in self.content.attacks.values()
            ],
            "chain_details": [
                {"chain_id": c.chain_id, "agent": c.agent, "version": c.version,
                 "claim_id": c.claim_id, "status": c.status.value,
                 "steps": [{"step_id": s.step_id, "assertion": s.assertion,
                           "evidence": [e.get("ref","") for e in s.evidence],
                           "depends_on": s.depends_on} for s in c.steps]}
                for c in self.content.chains.values()
            ],
            "entropy_trajectory": [
                {k: round(v, 4) if isinstance(v, (int, float)) else v
                 for k, v in e.items()}
                for e in self.entropy_history
            ],
            "evidence_pool_size": len(self.evidence.pool.items),
            "divergence_map": self._render_divergence_map(),
            "natural_summary": self._render_natural_summary(),
        }

    def _render_natural_summary(self) -> str:
        """Natural language summary of what was agreed, what survived, what died."""
        lines = []
        lines.append(f"在 {self.round} 轮辩论后，{len(self.content.agent_names)} 个 AI 模型达成了以下结论。")
        lines.append("")

        # Consensus claims
        consensus = [(t, ti, a, at, sr, d) for (t, ti, a, at, sr, ev, d) in
                     self._scored_cache if ti in ("ironclad", "consensus") and d.strip()]
        if consensus:
            lines.append(f"## 达成共识的结论 ({len(consensus)} 条)")
            for t, ti, a, atk, sr, desc in consensus[:5]:
                label = "铁证级" if ti == "ironclad" else "共识级"
                lines.append(f"- [{label}] {desc[:200]}")
                lines.append(f"  信任度={t:.2f}, 被攻击{atk}次, 存活率={sr:.0%}")
            lines.append("")

        # Surviving chains with steps
        active_with_steps = [c for c in self.content.chains.values()
                            if c.status == ChainStatus.ACTIVE and c.steps]
        if active_with_steps:
            lines.append(f"## 存活下来的推理链 ({len(active_with_steps)} 条)")
            for chain in active_with_steps[:8]:
                lines.append(f"- {chain.agent} 的链 (v{chain.version}, {chain.step_count}步, 被攻击{chain.attacks_received}次):")
                for s in chain.steps[:3]:
                    lines.append(f"  · {s.assertion[:180]}")
            lines.append("")

        # Broken chains and why
        broken = [c for c in self.content.chains.values() if c.status == ChainStatus.BROKEN]
        if broken:
            lines.append(f"## 被攻击击穿的推理链 ({len(broken)} 条崩塌)")
            # Find attacks that caused the break
            for b in broken[:5]:
                killing_attacks = [a for a in self.content.attacks.values()
                                  if a.target_chain_id == b.chain_id and a.status == AttackStatus.SUSTAINED]
                killer_desc = killing_attacks[0].claim[:150] if killing_attacks else "自动结算(5轮未修订)"
                lines.append(f"- {b.agent} 的链 (被攻击{b.attacks_received}次): {killer_desc}")
            lines.append("")

        # Unscrutinized claims
        unscrutinized = [(t, ti, a, at, sr, d) for (t, ti, a, at, sr, ev, d) in
                        self._scored_cache if ti == "unscrutinized" and d.strip()]
        if unscrutinized:
            lines.append(f"## 未经验证的声明 ({len(unscrutinized)} 条)")
            lines.append("以下声明具有高证据独立性(α值高)，但未被任何Agent攻击过——不代表正确，仅代表未经测试。")
            for t, ti, a, atk, sr, desc in unscrutinized[:5]:
                lines.append(f"- {desc[:150]}")

        return "\n".join(lines)

    def _render_divergence_map(self) -> str:
        """Three-zone divergence map: consensus, contested, collapsed."""
        lines = []
        sep = "─" * 60

        # Compute trust per claim (same scoring logic)
        scored = []
        for cid, claim in self.claims.items():
            alpha = claim.alpha
            attacks = len(claim.attacks)
            claim_chains = [ch for ch in self.content.chains.values()
                           if ch.claim_id == cid]
            total_c = len(claim_chains)
            active_c = sum(1 for ch in claim_chains if ch.status == ChainStatus.ACTIVE)
            survival_rate = active_c / max(total_c, 1)
            trust = alpha * (1.0 + survival_rate) / 2.0
            # §Scrutiny: untested claims → trust→0 (Poisson: λ≈1.5 for 5-agent)
            scrutiny = 1.0 - (2.71828 ** (-1.5 * max(attacks, 0)))
            trust *= scrutiny
            evidence_count = len(claim.evidence_refs)

            if attacks == 0:
                tier = "unscrutinized"
            elif alpha > 0.7 and attacks >= 5 and survival_rate > 0.5:
                tier = "ironclad"
            elif alpha > 0.7 and attacks < 5 and survival_rate > 0.5:
                tier = "consensus"
            elif alpha > 0.3:
                tier = "contested"
            else:
                tier = "weak"

            scored.append((trust, tier, alpha, attacks, survival_rate,
                          evidence_count, claim.description))

        scored.sort(key=lambda x: x[0], reverse=True)
        self._scored_cache = scored  # cache for natural_summary
        themes = self._cluster_attack_themes()

        # ═══════════ ZONE 0: UNSCRUTINIZED ═══════════
        unscored = [(t, ti, a, at, sr, ev, d) for (t, ti, a, at, sr, ev, d) in scored
                   if ti == "unscrutinized" and d.strip()]
        if unscored:
            lines.append(sep)
            lines.append("▌未审查区 — 未被任何Agent攻击过，可信度未验证")
            lines.append(sep)
            for t, ti, a, atk, sr, ev, desc in unscored:
                lines.append(f"  ◌ [未审查] {desc[:200]}")
                lines.append(f"     α={a:.2f} | 攻击=0次 | 注意：不代表正确，仅代表未经测试")
                lines.append("")

        # ═══════════ ZONE 1: CONSENSUS ═══════════
        consensus_items = [(t, ti, a, at, sr, ev, d) for (t, ti, a, at, sr, ev, d) in scored
                          if ti in ("ironclad", "consensus") and d.strip()]
        if consensus_items:
            lines.append(sep)
            lines.append("▌共识区 — 通过审查、未被击穿")
            lines.append(sep)
            for t, ti, a, atk, sr, ev, desc in consensus_items:
                symbol = "◆" if ti == "ironclad" else "✓"
                label = "铁证" if ti == "ironclad" else "共识"
                lines.append(f"  {symbol} [{label}] {desc[:200]}")
                lines.append(f"     trust={t:.2f} | α={a:.2f} | 存活率={sr:.0%} | 被攻击{atk}次")
                lines.append("")

        # ═══════════ ZONE 2: CONTESTED ═══════════
        contested_items = [(t, ti, a, at, sr, ev, d) for (t, ti, a, at, sr, ev, d) in scored
                          if ti == "contested"]
        if contested_items:
            lines.append(sep)
            lines.append("▌争议区 — 排名取决于方法论前提")
            lines.append(sep)

            # Show the core disagreement if themes exist
            if themes:
                top_theme = themes[0]
                lines.append(f"  核心分歧：\"{top_theme['theme'][:80]}\" ({top_theme['count']}次攻击)")
                lines.append(f"  这个分歧不能被证据本身解决——它来自方法论立场差异")
                lines.append("")

            for t, ti, a, atk, sr, ev, desc in contested_items:
                if not desc.strip():
                    continue
                lines.append(f"  ◇ trust={t:.2f} | α={a:.2f} | 存活率={sr:.0%} | 被攻击{atk}次")
                lines.append(f"     {desc[:200]}")
                lines.append("")

            # Methodology risks condensed here
            if themes:
                lines.append(f"  方法论风险: {' | '.join(t['theme'][:60] for t in themes[:5])}")
                lines.append("")

        # ═══════════ ZONE 3: COLLAPSED ═══════════
        broken = [ch for ch in self.content.chains.values()
                 if ch.status == ChainStatus.BROKEN]
        weak_items = [(t, ti, a, at, sr, ev, d) for (t, ti, a, at, sr, ev, d) in scored
                     if ti == "weak" and d.strip()]
        if broken or weak_items:
            lines.append(sep)
            lines.append("▌崩塌区 — 被攻击击穿或证据不足")
            lines.append(sep)
            for t, ti, a, atk, sr, ev, desc in weak_items[:5]:
                lines.append(f"  ○ {desc[:150]} (trust={t:.2f})")
            if broken:
                lines.append(f"  崩塌链: {len(broken)}条")
                for b in broken[:5]:
                    lines.append(f"     ✗ {b.chain_id} ({b.agent})")
            lines.append("")

        # ═══════════ DIAGNOSTICS ═══════════
        lines.append(sep)
        lines.append(f"  物理收敛 R{self.round} | Agent: {', '.join(self.content.agent_names)}")
        lines.append(f"  攻击总计 {len(self.content.attacks)}次 | 证据池 {len(self.evidence.pool.items)}条")
        lines.append(sep)

        return "\n".join(lines)

    def _render_counterfactual(self, scored: list, themes: list[dict]) -> str:
        """Show how the ranking changes if methodology weights are flipped.

        Pure computation from attack logs — no LLM needed.
        For each methodology theme, find the top-ranked claim most affected by it,
        then show what happens when that theme's evidence priority is reversed.
        """
        lines = []
        if not themes or not scored:
            return ""

        # Top 3 methodology themes by attack count
        top_themes = sorted(themes, key=lambda t: t.get('count', 0), reverse=True)[:3]

        # Find the top trust-scored claims
        top_claims = [s for s in scored if s[0] >= 0.5][:5]
        if not top_claims:
            top_claims = scored[:3]

        for theme in top_themes:
            theme_name = theme.get('theme', '')[:80]
            count = theme.get('count', 0)
            # Find which top claim is most attacked on this theme
            # (approximation: match theme keywords against claim descriptions)
            affected_claims = []
            for trust, tier, alpha, atk, sr, ev, desc in top_claims:
                # A claim is "affected" if it has high attacks (suggesting this theme matter)
                if atk >= 3:
                    affected_claims.append((trust, tier, desc[:80], atk))

            if affected_claims:
                best = affected_claims[0]  # highest trust among affected
                lines.append(
                    f"  · \"{theme_name}\" ({count} attacks)\n"
                    f"    Top affected claim: [{best[1]}] {best[2]}\n"
                    f"    If this methodology concern is prioritized → "
                    f"ranking shifts toward claims with stronger counter-evidence"
                )

        if not lines:
            lines.append("  (Insufficient data for counterfactual analysis)")

        return "\n".join(lines)

    def _cluster_attack_themes(self) -> list[dict]:
        """Use search executor LLM to cluster attacks into methodological themes.

        More reliable than embedding for academic text where synonyms
        and domain terminology differ significantly from general language.
        """
        if len(self.content.attacks) < 5:
            return []

        # Collect attack texts
        attack_texts = "\n---\n".join(
            f"[{a.attacker}] {a.claim[:300]}"
            for a in list(self.content.attacks.values())[-50:]
        )

        prompt = f"""Analyze these cross-examination attacks from a multi-agent scientific discussion.

## ATTACKS
{attack_texts[:4000]}

## TASK
Identify recurring METHODOLOGICAL THEMES that multiple attacks share.
Group thematically related attacks even if they use different wording.
Focus on themes relevant to scientific validity.

Return JSON:
```json
{{"themes": [{{"theme": "brief label (e.g. germ-free mouse limitations)", "count": N, "agents": "agent_0,agent_2", "example_quote": "..."}}]}}
```

Only include themes with >=2 attacks. Max 8 themes."""

        try:
            raw = call_agent(self.cfg.evidence_llm or self.cfg.agents[0],
                           "", prompt)
            data = parse_json_output(raw)
            return data.get("themes", [])
        except Exception:
            return []

    def _compute_S_novel_llm(self, new_chains: list, existing_chains: list) -> float | None:
        """LLM-based semantic novelty — handles academic synonyms that Jaccard misses.

        Uses evidence LLM (Kimi) to judge whether new chains say something
        genuinely new, or just rephrase existing positions with different words.
        """
        if not new_chains:
            return None

        existing_summary = "\n---\n".join(
            f"Chain {c.chain_id} ({c.agent}): " +
            " | ".join(s.assertion[:120] for s in c.steps[:3])
            for c in existing_chains[-5:]
        )
        new_summary = "\n---\n".join(
            f"NEW Chain {c.chain_id} ({c.agent}): " +
            " | ".join(s.assertion[:120] for s in c.steps[:3])
            for c in new_chains[-3:]
        )

        prompt = f"""Judge whether these NEW chains say something SEMANTICALLY NOVEL.

## EXISTING CHAINS
{existing_summary[:3000]}

## NEW CHAINS
{new_summary[:2000]}

## TASK
For each NEW chain: genuinely new claim/evidence/mechanism/experiment — or rephrase?
Academic synonyms = SAME (e.g. "germ-free mouse" = "axenic model" = "无菌小鼠").
Different structure + same conclusion = NOT novel.

Return JSON:
```json
{{"novel_count": N, "total": T, "judgments": [{{"chain_id": "...", "novel": true/false, "reason": "one sentence"}}]}}
```"""
        try:
            raw = call_agent(self.cfg.evidence_llm or self.cfg.agents[0], "", prompt)
            data = parse_json_output(raw)
            if data and data.get("total", 0) > 0:
                return data["novel_count"] / data["total"]
        except Exception:
            pass
        return None

    def _update_hsym(self, symbol_key: str) -> float:
        """Update exponential-weighted symbol distribution and return H_sym.

        §6.8: Adaptive forgetting rate based on new-symbol rate in 5-round window.
        """
        import math

        # Track new symbols in 5-round window for adaptive alpha
        is_new = (symbol_key != self._hsym_last_symbol and
                  symbol_key not in self._hsym_dist)
        self._hsym_new_symbols_5r.append(1 if is_new else 0)
        if len(self._hsym_new_symbols_5r) > 5:
            self._hsym_new_symbols_5r.pop(0)
        self._hsym_last_symbol = symbol_key

        # N_eff = fraction of rounds in 5r window that produced a new symbol.
        # N_eff=0 → all symbols repeat → alpha≈1 (slow decay, stable memory)
        # N_eff=1 → every round is new → alpha≈0 (fast decay, exploration mode)
        N_eff = sum(self._hsym_new_symbols_5r) / max(len(self._hsym_new_symbols_5r), 1)
        alpha = 1.0 - N_eff
        alpha = max(0.1, min(0.95, alpha))

        # Decay existing symbols; cap dict size to prevent unbounded growth
        for k in list(self._hsym_dist.keys()):
            self._hsym_dist[k] *= alpha
        if len(self._hsym_dist) >= self._hsym_max_dist_size:
            # Drop the rarest symbol to keep memory bounded
            rarest = min(self._hsym_dist, key=self._hsym_dist.get)
            del self._hsym_dist[rarest]

        self._hsym_dist[symbol_key] = self._hsym_dist.get(symbol_key, 0.0) + (1.0 - alpha)

        # Renormalize
        total = sum(self._hsym_dist.values())
        if total > 0:
            for k in self._hsym_dist:
                self._hsym_dist[k] /= total

        # H_sym = Shannon entropy of the empirical symbol distribution
        h = -sum(p * math.log2(max(p, 1e-12)) for p in self._hsym_dist.values())
        self._hsym_history.append(h)
        return h

    def get_chain_status_report(self) -> list[dict]:
        """Per-round chain survival report for data analysis."""
        chains_detail = []
        for cid, chain in self.content.chains.items():
            chains_detail.append({
                "chain_id": cid,
                "agent": chain.agent,
                "version": chain.version,
                "status": chain.status.value,
                "attacks_received": chain.attacks_received,
                "attacks_survived": chain.attacks_survived,
                "steps": chain.step_count,
                "created_at": chain.created_at,
                "last_modified": chain.last_modified,
            })
        return chains_detail
