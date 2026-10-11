"""
§6 COORDINATION LAYER — Pure computation. No LLM.

Computes from observable behavior only:
  α (§6.1) — Evidence Independence Weight
  U (§6.2) — Activity Signal
  7 entropy metrics (§6.3)
  ChainState quadrants (§6.5)
  Focus marking (§6.6)
  Adaptive termination (§6.7)
"""

from __future__ import annotations

import math
from collections import Counter
from dataclasses import dataclass, field
from enum import Enum

import numpy as np
from sklearn.cluster import KMeans


class ChainState(str, Enum):
    RICH_DISAGREEMENT = "RICH_DISAGREEMENT"
    EVIDENCE_STARVED = "EVIDENCE_STARVED"
    TRUE_CONSENSUS = "TRUE_CONSENSUS"
    FRAGILE_CONSENSUS = "FRAGILE_CONSENSUS"


@dataclass
class Claim:
    claim_id: str
    description: str = ""
    chains: list[str] = field(default_factory=list)
    attacks: list[str] = field(default_factory=list)
    evidence_refs: set[str] = field(default_factory=set)
    alpha: float = 0.5
    U: int = 0
    state: ChainState = ChainState.RICH_DISAGREEMENT
    created_round: int = 0
    last_active_round: int = 0


# ═══════════════════════════════════════
# §6.1 α — Evidence Independence Weight
# ═══════════════════════════════════════

def _jaccard(a: set, b: set) -> float:
    if not a and not b:
        return 0.0
    inter = len(a & b)
    union = len(a | b)
    return inter / union if union > 0 else 0.0


def compute_alpha(claim: Claim, all_claims: list[Claim]) -> float:
    """α_i = 1 / (1 + mean_Jaccard(E_i, E_j))"""
    E_i = claim.evidence_refs
    n = len(all_claims)
    if n <= 1:
        return 1.0
    j_sum = 0.0
    for other in all_claims:
        if other.claim_id != claim.claim_id:
            j_sum += _jaccard(E_i, other.evidence_refs)
    return 1.0 / (1.0 + j_sum / max(n - 1, 1))


# ═══════════════════════════════════════
# §6.2 U — Activity Signal
# ═══════════════════════════════════════

def compute_U(claim: Claim, current_round: int,
              chains: dict, attacks: dict, agent_names: list[str],
              recent_evidence: set[str]) -> int:
    window = 2
    recent_start = max(0, current_round - window)

    moved = 0
    for cid in claim.chains:
        c = chains.get(cid)
        if c and getattr(c, 'version', 1) > 1 and getattr(c, 'last_modified', 0) >= recent_start:
            moved = 1
            break

    filled = 0
    for cid in claim.chains:
        c = chains.get(cid)
        if c and getattr(c, 'last_modified', 0) >= recent_start:
            for step in getattr(c, 'steps', []):
                for ev in getattr(step, 'evidence', []):
                    if ev.get("ref", "") in recent_evidence:
                        filled = 1
                        break
            if filled:
                break

    silent = 0
    spoken = set()
    for cid in claim.chains:
        c = chains.get(cid)
        if c:
            spoken.add(getattr(c, 'agent', ''))
    for aid in claim.attacks:
        a = attacks.get(aid)
        if a:
            spoken.add(getattr(a, 'attacker', ''))
    if set(agent_names) - spoken:
        silent = 1

    return moved + filled + silent


# ═══════════════════════════════════════
# §6.3 Seven Behavioral Entropy Metrics
# ═══════════════════════════════════════

def compute_H_evidence(claims: list[Claim]) -> float:
    counts = [len(c.evidence_refs) for c in claims]
    total = sum(counts)
    if total == 0:
        return 0.0
    return -sum((c / total) * math.log(c / total) for c in counts if c > 0)


def compute_S_attack(claims: list[Claim]) -> float:
    counts = [len(c.attacks) for c in claims]
    total = sum(counts)
    if total == 0:
        return 0.0
    return 1.0 - sum((c / total) ** 2 for c in counts)


def compute_H_part(contribution_counts: dict[str, int],
                   agent_names: list[str]) -> float:
    N = sum(contribution_counts.values())
    if N == 0:
        return 0.0
    k = len(agent_names)
    if k <= 1:
        return 1.0
    h = -sum(
        (n / N) * math.log(n / N) / math.log(k)
        for n in contribution_counts.values() if n > 0
    )
    return max(0.0, h)  # clamp float rounding near zero


def compute_H_chain(chains: list) -> float:
    """Rényi α=2 collision entropy on structural vectors."""
    if len(chains) < 2:
        return 0.0
    vectors = np.array([list(c.structural_vector()) for c in chains], dtype=float)
    mins, maxs = vectors.min(axis=0), vectors.max(axis=0)
    ranges = maxs - mins
    ranges[ranges == 0] = 1.0
    vectors = (vectors - mins) / ranges
    K = min(len(chains), 5)
    if K < 2:
        return 0.0
    labels = KMeans(n_clusters=K, n_init=10, random_state=42).fit_predict(vectors)
    counts = Counter(labels)
    total = len(chains)
    p_sq = sum((c / total) ** 2 for c in counts.values())
    return -math.log2(p_sq) if p_sq > 0 else 0.0


def compute_T_max(contribution_history: dict[str, list[int]],
                  window: int = 8) -> float:
    agents = list(contribution_history.keys())
    if len(agents) < 2:
        return 0.0
    min_len = min(len(v) for v in contribution_history.values())
    if min_len < T_MAX_MIN_HISTORY:
        return 0.0

    max_te = 0.0
    for a in agents:
        for b in agents:
            if a == b:
                continue
            sa = contribution_history[a][-window - 2:]
            sb = contribution_history[b][-window:]
            if len(sa) < 3 or len(sb) < 1:
                continue
            joint = {}
            cond = {}
            for t in range(2, min(len(sb), len(sa))):
                bt, bt1, bt2 = sb[t], sb[t-1] if t-1>=0 else 0, sb[t-2] if t-2>=0 else 0
                at1, at2 = sa[t-1] if t-1<len(sa) else 0, sa[t-2] if t-2<len(sa) else 0
                key = (bt1, bt2, at1, at2, bt)
                joint[key] = joint.get(key, 0) + 1
                cond[(bt1, bt2)] = cond.get((bt1, bt2), 0) + 1
            total = sum(joint.values())
            if total == 0:
                continue
            te = 0.0
            for (bt1, bt2, at1, at2, bt), cnt in joint.items():
                p_joint = cnt / total
                p_given = cnt / cond.get((bt1, bt2), 1)
                cnt_no_a = sum(joint.get((bt1, bt2, aa1, aa2, bt), 0)
                              for aa1 in (0, 1) for aa2 in (0, 1))
                p_no_a = cnt_no_a / cond.get((bt1, bt2), 1)
                if p_given > 0 and p_no_a > 0:
                    te += p_joint * math.log2(p_given / p_no_a)
            max_te = max(max_te, abs(te))
    return max_te


def compute_H_remaining(claims: list[Claim], alphas: dict[str, float],
                        current_round: int) -> float:
    """H_remaining = -Σ α_c · log(1/(1+active_c))

    active_c = 1 if claim was referenced in last 3 rounds, else 0.
    For active claims: log(1/2) = -log(2), so contribution = α_c · log(2).
    For inactive claims: log(1/1) = 0, so contribution = 0.
    """
    entropy = 0.0
    for c in claims:
        active = 1 if (current_round - c.last_active_round) <= 3 else 0
        if active:
            entropy += alphas.get(c.claim_id, 0.5) * math.log(2)
    return entropy


def compute_ApEn(seq: list[int], m: int = 3) -> float:
    N = len(seq)
    if N < m + 2:
        return 0.0

    def phi(length):
        pats = [tuple(seq[i:i+length]) for i in range(N - length + 1)]
        if not pats:
            return 0.0
        cnt = Counter(pats)
        return sum(math.log(c / len(pats)) for c in cnt.values()) / len(pats)

    return phi(m) - phi(m + 1)


# ═══════════════════════════════════════
# §6.5 ChainState + §6.6 Focus + §6.7 Termination
# ═══════════════════════════════════════

def classify_chainstate(alpha: float, U: int) -> ChainState:
    e = alpha * U
    if e >= 1.5:
        return ChainState.RICH_DISAGREEMENT if alpha >= 0.6 else ChainState.EVIDENCE_STARVED
    return ChainState.TRUE_CONSENSUS if alpha >= 0.6 else ChainState.FRAGILE_CONSENSUS


def compute_focus(claims: list[Claim], alphas: dict[str, float],
                  Us: dict[str, int], max_focus: int = 3) -> list[Claim]:
    ranked = []
    for c in claims:
        alpha = alphas.get(c.claim_id, 0.5)
        U = Us.get(c.claim_id, 0)
        state = classify_chainstate(alpha, U)
        c.alpha = alpha
        c.U = U
        c.state = state
        if U > 0 and alpha > 0.3:
            rank = alpha * U
            if state == ChainState.RICH_DISAGREEMENT:
                rank += 0.3
            elif state == ChainState.FRAGILE_CONSENSUS:
                rank += 0.2
            elif state == ChainState.TRUE_CONSENSUS:
                rank -= 0.3
            ranked.append((rank, c))
    ranked.sort(key=lambda x: x[0], reverse=True)
    return [c for _, c in ranked[:max_focus]]


def check_termination(entropies: dict[str, float], thresholds: dict[str, float],
                      consecutive: int, required: int = 3,
                      current_round: int = 0, min_rounds: int = 5
                      ) -> tuple[bool, int, str]:
    """Two-tier termination (§6.7).

    Primary: T_max < ε_t AND H_chain < ε_c for N consecutive rounds.
    Veto:    S_attack > 0.6 AND H_remaining > 2.0 → false convergence, block.
             H_part > 0.9 AND T_max < ε_t → surface silence, block.
    """
    T_max = entropies.get("T_max", 0)
    H_chain = entropies.get("H_chain", 0)
    S_attack = entropies.get("S_attack", 0)
    H_remaining = entropies.get("H_remaining", 0)
    H_part = entropies.get("H_part", 0)

    ε_t = thresholds.get("T_max", 0.12)
    ε_c = thresholds.get("H_chain", 0.20)

    primary = T_max < ε_t and H_chain < ε_c

    # Veto: active attacks with unexplored space → don't terminate
    if primary and S_attack > 0.6 and H_remaining > 2.0:
        return False, 0, f"veto: S_a={S_attack:.2f} H_r={H_remaining:.2f} (false convergence)"

    # Veto: everyone speaking but no influence → surface silence
    if primary and H_part > 0.9 and T_max < ε_t:
        return False, 0, f"veto: H_p={H_part:.2f} T_m={T_max:.2f} (surface silence)"

    if primary:
        consecutive += 1
    else:
        consecutive = 0

    if current_round < min_rounds and consecutive >= required:
        return False, consecutive, f"premature_guard(round={current_round})"
    if consecutive >= required:
        return True, consecutive, "T_max+H_chain_converged"

    failing = []
    if T_max >= ε_t:
        failing.append(f"T_max={T_max:.3f}")
    if H_chain >= ε_c:
        failing.append(f"H_chain={H_chain:.3f}")
    return False, consecutive, f"failing: {failing}" if failing else "waiting"


# ═══════════════════════════════════════
# §4 Step Divergence Detection
# ═══════════════════════════════════════

def find_divergence_point(chain_a, chain_b) -> int | None:
    """§4.2: Find first step where two chains semantically diverge.

    Returns step_id of first divergence, or None if chains agree.
    """
    steps_a = getattr(chain_a, 'steps', [])
    steps_b = getattr(chain_b, 'steps', [])
    if not steps_a or not steps_b:
        return 1 if steps_a or steps_b else None
    for i, (sa, sb) in enumerate(zip(steps_a, steps_b)):
        # Simple keyword-overlap divergence check (embedding in production)
        words_a = set(getattr(sa, 'assertion', '').lower().split())
        words_b = set(getattr(sb, 'assertion', '').lower().split())
        if not words_a or not words_b:
            continue
        inter = len(words_a & words_b)
        union = len(words_a | words_b)
        jaccard = inter / union if union > 0 else 0
        if jaccard < 0.5:  # hard divergence
            return i + 1
    if len(steps_a) != len(steps_b):
        return min(len(steps_a), len(steps_b)) + 1
    return None


# ═══════════════════════════════════════
# §8 Topic Drift Detection
# ═══════════════════════════════════════

def compute_drift(current_claims: list[Claim],
                  previous_claims: list[str],
                  threshold: float = 0.3) -> float:
    """§8: Detect topic drift by comparing current vs previous claim sets."""
    if not previous_claims:
        return 0.0
    current_ids = {c.claim_id for c in current_claims[-3:]}
    prev_ids = set(previous_claims[-3:])
    inter = len(current_ids & prev_ids)
    union = len(current_ids | prev_ids)
    return 1.0 - (inter / union if union > 0 else 1.0) if union > 0 else 0.0


# ═══════════════════════════════════════
# §17 Invariants Check
# ═══════════════════════════════════════

def check_invariants(chains: dict, attacks: dict, max_depth: int = 2) -> list[str]:
    """§17: Verify structural invariants. Returns list of violations."""
    violations = []

    # I1: No cycles in chain dependencies
    for cid, chain in chains.items():
        visited = set()
        path = []

        def dfs(step_id):
            if step_id in path:
                violations.append(f"I1_CYCLE: {cid} step {step_id} in cycle {path}")
                return
            if step_id in visited:
                return
            visited.add(step_id)
            path.append(step_id)
            for s in getattr(chain, 'steps', []):
                if s.step_id == step_id:
                    for dep in getattr(s, 'depends_on', []):
                        dfs(dep)
                    break
            path.pop()

        for s in getattr(chain, 'steps', []):
            dfs(s.step_id)

    # I2: Attack depth ≤ max_depth
    for aid, attack in attacks.items():
        d = getattr(attack, 'depth', 1)
        if d > max_depth:
            violations.append(f"I2_DEPTH: {aid} depth={d} > max={max_depth}")

    return violations


# ═══════════════════════════════════════
# §23 Elo Rating System
# ═══════════════════════════════════════

class EloSystem:
    """§23: Track agent reliability via attack outcomes."""

    def __init__(self):
        self.ratings: dict[str, float] = {}
        self.match_count: dict[str, int] = {}
        self._default = 1500.0

    def get(self, agent: str) -> float:
        return self.ratings.get(agent, self._default)

    def resolve(self, winner: str, loser: str, depth: int = 1):
        """Update Elo after attack resolution."""
        rw = self.ratings.get(winner, self._default)
        rl = self.ratings.get(loser, self._default)

        # Dynamic K-factor (§23.2)
        diff = abs(rw - rl)
        k = 24.0
        if depth <= 2:
            k *= 1.5  # premise-level attack
        if self.match_count.get(winner, 0) < 5:
            k *= 1.3  # new agent
        if diff > 300:
            k *= 0.5
        elif diff < 50:
            k *= 1.2

        expected = 1.0 / (1.0 + 10.0 ** ((rl - rw) / 400.0))
        delta = k * (1.0 - expected)

        self.ratings[winner] = rw + delta
        self.ratings[loser] = rl - delta
        self.match_count[winner] = self.match_count.get(winner, 0) + 1
        self.match_count[loser] = self.match_count.get(loser, 0) + 1


# ═══════════════════════════════════════
# Semantic Novelty — distinguishes structural diversity from content diversity
# ═══════════════════════════════════════

def compute_S_novel(new_chains: list, existing_chains: list,
                    word_overlap_threshold: float = 0.85) -> float:
    """Measure semantic novelty of new chains vs existing chains.

    Uses word-overlap Jaccard on step assertions as a lightweight
    semantic similarity proxy. If all new chains are semantically
    redundant (>threshold similarity to existing chains), returns 0.0.

    When S_novel = 0 for N consecutive rounds → semantic saturation.
    """
    if not new_chains:
        return 0.0
    if not existing_chains:
        return 1.0

    def _words(chain) -> set:
        words = set()
        for s in getattr(chain, 'steps', []):
            words.update(getattr(s, 'assertion', '').lower().split())
        return words

    existing_words = [_words(c) for c in existing_chains]
    novel_count = 0

    for nc in new_chains:
        nc_words = _words(nc)
        if not nc_words:
            continue
        max_sim = 0.0
        for ew in existing_words:
            if not ew:
                continue
            inter = len(nc_words & ew)
            union = len(nc_words | ew)
            sim = inter / union if union > 0 else 0.0
            max_sim = max(max_sim, sim)
        if max_sim < word_overlap_threshold:
            novel_count += 1

    return novel_count / len(new_chains)


# ═══════════════════════════════════════
# §6.8 H_sym — Symbolic Entropy Convergence
# ═══════════════════════════════════════

# Shared constant: T_max requires 20 rounds of contribution history
T_MAX_MIN_HISTORY: int = 20


class HsymObserver:
    """Per-session symbolic entropy observer (§6.8).

    Owns observation window, bin boundaries, and discretization state.
    One instance per Session — no global mutable state. Thread-safe.
    """

    def __init__(self, observation_window: int = 10):
        self.window = observation_window
        self.boundaries: dict | None = None
        self.observations: dict[str, list[float]] = {
            "H_evidence": [], "S_attack": [], "H_part": [],
            "H_chain": [], "T_max": [], "H_remaining": [], "S_novel": [],
        }

    def reset(self):
        """Reset for a fresh session."""
        self.boundaries = None
        for k in self.observations:
            self.observations[k].clear()

    def _observe(self, entropies: dict[str, float]) -> None:
        """Collect observations; lock boundaries at window end."""
        if self.boundaries is not None:
            return
        for k in self.observations:
            if k in entropies:
                self.observations[k].append(entropies[k])

    def try_lock_boundaries(self, round_num: int) -> None:
        """Attempt to lock bin boundaries if window is complete."""
        if self.boundaries is not None:
            return
        if round_num >= self.window:
            self._lock()

    def _lock(self):
        """Lock bin boundaries based on observation min/max."""
        self.boundaries = {}
        for k, vals in self.observations.items():
            if not vals or len(vals) < 3:
                self.boundaries[k] = None
                continue
            vmin, vmax = min(vals), max(vals)
            if vmax - vmin < 0.001:
                vmax = vmin + 1.0
            if k in ("H_chain", "T_max"):
                self.boundaries[k] = [vmin + (vmax - vmin) * 0.5]
            else:
                step = (vmax - vmin) / 3.0
                self.boundaries[k] = [vmin + step, vmin + 2 * step]

    @staticmethod
    def _classify(value: float, thresholds: list[float] | None,
                  labels: list[str]) -> str:
        if thresholds is None:
            return "?"
        for i, t in enumerate(thresholds):
            if value <= t:
                return labels[i]
        return labels[-1]

    def discretize(self, entropies: dict[str, float],
                   round_num: int) -> str | None:
        """Convert 8-entropy vector → symbolic string.

        Returns None before observation window is locked.
        """
        self._observe(entropies)
        self.try_lock_boundaries(round_num)

        if self.boundaries is None:
            return None

        b = self.boundaries
        symbols = {}

        if b.get("H_evidence"):
            symbols["H_evidence"] = self._classify(
                entropies.get("H_evidence", 0), b["H_evidence"],
                ["He低", "He中", "He高"])
        if b.get("S_attack"):
            symbols["S_attack"] = self._classify(
                entropies.get("S_attack", 0), b["S_attack"],
                ["Sa低", "Sa中", "Sa高"])
        if b.get("H_part"):
            symbols["H_part"] = self._classify(
                entropies.get("H_part", 0), b["H_part"],
                ["Hp低", "Hp中", "Hp高"])
        if b.get("H_chain"):
            symbols["H_chain"] = self._classify(
                entropies.get("H_chain", 0), b["H_chain"],
                ["Hc低", "Hc高"])

        # T_max: 2-bin with unavailable marker for R0-R19
        if round_num < T_MAX_MIN_HISTORY:
            symbols["T_max"] = "Tm-"
        elif b.get("T_max"):
            symbols["T_max"] = self._classify(
                entropies.get("T_max", 0), b["T_max"],
                ["Tm低", "Tm高"])

        if b.get("H_remaining"):
            symbols["H_remaining"] = self._classify(
                entropies.get("H_remaining", 0), b["H_remaining"],
                ["Hr低", "Hr中", "Hr高"])

        # S_novel: 2-bin (枯/活 at 0.1)
        sn = entropies.get("S_novel", 1.0)
        symbols["S_novel"] = "Sn枯" if sn <= 0.1 else "Sn活"

        return self._encode(symbols)

    @staticmethod
    def _encode(symbols: dict[str, str]) -> str:
        order = ["H_evidence", "S_attack", "H_part", "H_chain",
                 "T_max", "H_remaining", "S_novel"]
        return "|".join(symbols.get(k, "-") for k in order)


# Backward-compatible thin wrappers (used by tests / legacy paths)
_OBSOLETE_GLOBAL_OBSERVER = HsymObserver()


def discretize_entropies(entropies: dict[str, float],
                         round_num: int) -> str | None:
    """Legacy wrapper: use the global observer (backward compat)."""
    return _OBSOLETE_GLOBAL_OBSERVER.discretize(entropies, round_num)


def _reset_symbolization():
    """Legacy wrapper: reset the global observer (backward compat)."""
    _OBSOLETE_GLOBAL_OBSERVER.reset()


# ═══════════════════════════════════════
# §13 Output Rendering
# ═══════════════════════════════════════

