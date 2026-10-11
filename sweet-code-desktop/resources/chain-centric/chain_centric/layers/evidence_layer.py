"""
§5 EVIDENCE LAYER — Independent module for evidence acquisition.

Owns:  search executor (one LLM call), 5-stage pipeline,
       evidence pool, verification, deduplication, gap detection,
       perspective seed assignment, echo composition.

Design principle (§5.0): evidence acquisition quality must not
depend on which content-layer agent is asking for evidence.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from enum import Enum

from ..config import LLMConfig


# ═══════════════════════════════════════
# Evidence Data Structures
# ═══════════════════════════════════════

class VerificationTier(str, Enum):
    VERIFIED = "verified"
    FULLY_VERIFIED = "fully_verified"
    ABSTRACT_CONSISTENT = "abstract_consistent"
    EXISTENCE_VERIFIED = "existence_verified"
    UNVERIFIED = "unverified"

VERIFICATION_WEIGHTS = {
    VerificationTier.VERIFIED: 1.00,
    VerificationTier.FULLY_VERIFIED: 1.00,
    VerificationTier.ABSTRACT_CONSISTENT: 0.85,
    VerificationTier.EXISTENCE_VERIFIED: 0.70,
    VerificationTier.UNVERIFIED: 0.30,
}


def _new_id(prefix: str = "") -> str:
    import uuid
    return f"{prefix}_{uuid.uuid4().hex[:8]}"


def _digest(ref: str, detail: str = "") -> str:
    return hashlib.sha256(f"{ref}|{detail}".encode()).hexdigest()[:16]


def _title_similarity(t1: str, t2: str) -> float:
    """Simple word-overlap similarity for semantic dedup."""
    w1 = set(t1.lower().split())
    w2 = set(t2.lower().split())
    if not w1 or not w2:
        return 0.0
    return len(w1 & w2) / len(w1 | w2)


@dataclass
class EvidenceItem:
    ref: str
    evidence_id: str = ""
    title: str = ""
    detail: str = ""
    digest: str = ""
    source: str = "arxiv"
    verification: VerificationTier = VerificationTier.UNVERIFIED
    created_round: int = 0

    def __post_init__(self):
        if not self.digest:
            self.digest = _digest(self.ref, self.detail)
        if not self.evidence_id:
            self.evidence_id = _new_id("e")


class EvidencePool:
    """Session-global, deduplicated evidence store."""

    def __init__(self):
        self._items: dict[str, EvidenceItem] = {}
        self._ref_index: dict[str, str] = {}
        self._digest_set: set[str] = set()
        self._additions_by_round: dict[int, list[str]] = {}

    @property
    def items(self) -> list[EvidenceItem]:
        return list(self._items.values())

    @property
    def refs(self) -> set[str]:
        return set(self._ref_index.keys())

    def get(self, eid: str) -> EvidenceItem | None:
        return self._items.get(eid)

    def add(self, item: EvidenceItem, round_num: int = 0) -> str | None:
        # §3.1 Exact dedup (SHA256)
        if item.digest in self._digest_set:
            return None
        if item.ref and item.ref in self._ref_index:
            existing = self._items.get(self._ref_index[item.ref])
            if existing:
                if VERIFICATION_WEIGHTS.get(item.verification, 0) > VERIFICATION_WEIGHTS.get(existing.verification, 0):
                    existing.verification = item.verification
                return existing.evidence_id
        # §3.2 Semantic dedup: check title similarity for web-sourced items
        if item.source == "web":
            for existing in self._items.values():
                if existing.source == "web" and _title_similarity(
                    item.title, existing.title) > 0.9:
                    return None
        item.created_round = round_num
        self._items[item.evidence_id] = item
        self._ref_index[item.ref] = item.evidence_id
        self._digest_set.add(item.digest)
        if round_num not in self._additions_by_round:
            self._additions_by_round[round_num] = []
        self._additions_by_round[round_num].append(item.evidence_id)
        return item.evidence_id

    def get_recent_additions(self, window: int = 2) -> set[str]:
        recent = set()
        max_round = max(self._additions_by_round.keys()) if self._additions_by_round else 0
        for r in range(max(0, max_round - window + 1), max_round + 1):
            for eid in self._additions_by_round.get(r, []):
                item = self._items.get(eid)
                if item:
                    recent.add(item.ref)
        return recent


# ═══════════════════════════════════════
# Perspective Seed Library (§4.4)
# ═══════════════════════════════════════

PERSPECTIVE_LIBRARY = {
    "engineering": [
        "Performance/Efficiency: prioritize time/space complexity, throughput, latency.",
        "Correctness/Accuracy: prioritize precision, recall, error bounds, edge cases.",
        "Feasibility: prioritize implementation complexity, maintenance cost, ecosystem maturity.",
    ],
    "scientific": [
        "Evidence Quality: scrutinize experimental design, sample size, statistical significance.",
        "Evidence Consistency: scrutinize cross-paper result consistency and reproducibility.",
        "Evidence Scope: scrutinize limits of claimed conclusions and extrapolation risks.",
    ],
    "incident_analysis": [
        "Temporal Causality: construct event ordering and causal dependencies.",
        "System Boundaries: analyze cross-system coupling points and failure propagation.",
        "Change Correlation: analyze deployment/config changes against anomaly timelines.",
    ],
    "code_review": [
        "Correctness: analyze whether the change introduces logical errors or edge cases.",
        "Performance: analyze time/space complexity impact and potential bottlenecks.",
        "Security/Maintainability: analyze vulnerability surface and long-term implications.",
    ],
}

DEFAULT_PERSPECTIVE = "Analyze the question from your best judgment, considering all available evidence."


# ═══════════════════════════════════════
# Task Classification (§5.1)
# ═══════════════════════════════════════

def classify_task(question: str) -> dict:
    q = question.lower()
    scores = {
        "incident_analysis": sum(1 for w in [
            'outage','incident','latency spike','p99','cpu spike','memory leak',
            'root cause','alert','downtime','error rate','timeout','redis memory',
            'kong retry'] if w in q),
        "code_review": sum(1 for w in [
            'pr ','pull request','code review','merge request','code change','diff',
            'patch','commit','bug fix','performance regression','sorting logic',
            'customcomparator'] if w in q),
        "literature_comparison": sum(1 for w in [
            'compare','versus',' vs ','alternative','which is better','should we use',
            'benchmark','comparison','paper a','paper b','arxiv:'] if w in q),
        "strategy_analysis": sum(1 for w in [
            'architecture','design','strategy','migrate','evolve','roadmap',
            'tradeoff','which architecture'] if w in q),
        "open_discussion": 0,
    }
    best = max(scores, key=scores.get)
    task_type = best if scores[best] > 0 else "open_discussion"
    mapping = {
        "incident_analysis": ("distributed_systems", ["metrics_timeseries","deployment_records","error_logs"]),
        "code_review": ("software_engineering", ["diff","test_results","benchmark","lint_output"]),
        "literature_comparison": ("scientific", ["academic_papers","benchmarks","case_studies"]),
        "strategy_analysis": ("engineering", ["case_studies","architecture_docs","benchmarks"]),
        "open_discussion": ("general", ["academic_papers","web"]),
    }
    domain, expected_evidence = mapping[task_type]
    entities = re.findall(r'\b(?:k8s|kubernetes|redis|kafka|nginx|kong|docker|prometheus|grafana|postgres|mysql|mongodb|elasticsearch|[a-z]+-service|[a-z]+-server)\b', q)
    return {"task_type": task_type, "domain": domain, "entities": entities, "expected_evidence_types": expected_evidence}


# ═══════════════════════════════════════
# §5 EVIDENCE LAYER
# ═══════════════════════════════════════

class EvidenceLayer:
    """Independent evidence acquisition layer.

    Owns the search executor (one LLM), the evidence pool,
    and all 5 stages of the acquisition pipeline.
    """

    def __init__(self, search_executor_config: LLMConfig):
        self.search_executor_cfg = search_executor_config
        self.pool = EvidencePool()
        self.task_info: dict = {}
        self.search_count: dict[str, int] = {}
        self._token_tracker: dict | None = None
        self._repository: list[EvidenceItem] = []  # 预设存储库（科研人员手动放入的资料）

    # ── Round 0: Initial acquisition ──

    def load_repository(self, items: list[dict]):
        """预载入科研人员手动提供的资料到存储库。

        items: [{"ref": "arxiv:...", "title": "...", "detail": "...", "source": "arxiv"}, ...]
        """
        for item in items:
            claims = item.get("claims")
            if isinstance(claims, list) and claims:
                self.load_paper(
                    ref=item.get("ref", _new_id("repo")),
                    title=item.get("title", ""),
                    claims=claims,
                    source=item.get("source", "repository"),
                )
                continue
            ev = EvidenceItem(
                ref=item.get("ref", ""),
                title=item.get("title", "")[:200],
                detail=item.get("detail", "")[:500],
                source=item.get("source", "repository"),
                verification=VerificationTier.EXISTENCE_VERIFIED,
            )
            self._repository.append(ev)
            self.pool.add(ev, 0)

    def load_paper(self, ref: str, title: str, claims: list[dict],
                   source: str = "repository"):
        """预载入一篇论文，将其拆分为独立可攻击的声明级证据。

        每一条声明是一个独立的 EvidenceItem，有自己的 evidence_id。
        Agent 可以攻击其中一条而不影响其他。
        """
        for i, c in enumerate(claims):
            claim_ref = f"{ref}/claim_{i+1}"
            ev = EvidenceItem(
                ref=claim_ref,
                title=f"{title} — {c.get('title', '')}"[:200],
                detail=c.get("detail", "")[:500],
                source=source,
                verification=VerificationTier.EXISTENCE_VERIFIED,
            )
            self._repository.append(ev)
            self.pool.add(ev, 0)

    def initialize(self, question: str) -> dict:
        """Stage 0-5 initial run. Returns task_info."""
        self.task_info = classify_task(question)
        self._acquire_initial(question)
        return self.task_info

    def _acquire_initial(self, question: str):
        """Parse embedded evidence from question + run initial search."""
        # Parse structured evidence from question text
        lines = question.split('\n')
        i = 0
        while i < len(lines):
            line = lines[i].strip()

            # Paper references
            m = re.match(
                r'[-*]\s*(?:Paper\s+\w+|Evidence\s+(?:from|in))\s*\(?'
                r'((?:arxiv:[\d\.x]+v?\d*|Semantic\s+Scholar|GitHub\s+\w+|\w+\s+\w+))'
                r'\)?:\s*(.+)', line, re.IGNORECASE)
            if m:
                ref = m.group(1).strip()
                detail = m.group(2).strip()
                self.pool.add(EvidenceItem(
                    ref=ref, title=detail[:150], detail=detail,
                    source="arxiv" if "arxiv:" in ref.lower() else "web",
                    verification=VerificationTier.EXISTENCE_VERIFIED if "arxiv:" in ref.lower() else VerificationTier.UNVERIFIED,
                ), 0)
                i += 1
                while i < len(lines) and lines[i].strip().startswith(('  ','\t')) and not lines[i].strip().startswith('-'):
                    i += 1
                continue

            # Metric/data lines
            m = re.match(r'[-*]\s*([^-:]{2,80}?):\s*([^-:]{2,60}?)$', line)
            if m and not any(kw in line.lower() for kw in ['http','question','scenario','before','after']):
                metric = m.group(1).strip()
                value = m.group(2).strip()
                if len(metric) < 80 and not metric.endswith(('?','!','.')):
                    self.pool.add(EvidenceItem(
                        ref=f"metric:{_digest(metric,'')}", title=f"{metric}: {value}"[:150],
                        detail=f"{metric}: {value}", source="internal",
                        verification=VerificationTier.VERIFIED,
                    ), 0)
                    i += 1
                    continue

            # Code blocks
            if line.startswith('```') and i + 1 < len(lines):
                i += 1
                code_lines = []
                while i < len(lines) and not lines[i].strip().startswith('```'):
                    code_lines.append(lines[i]); i += 1
                if code_lines:
                    code = '\n'.join(code_lines)
                    self.pool.add(EvidenceItem(
                        ref=f"code:{_digest(code,'')}",
                        title=f"Code: {code_lines[0].strip()[:100]}",
                        detail=code[:500], source="internal",
                        verification=VerificationTier.VERIFIED,
                    ), 0)
                i += 1
                continue
            i += 1

        # Always add the question itself
        self.pool.add(EvidenceItem(
            ref=f"question:{_digest(question,'')[:8]}",
            title="User Question", detail=question[:300],
            source="internal", verification=VerificationTier.VERIFIED,
        ), 0)

    # ── Per-round: search triggered by coordination layer (§5.3-5.8) ──

    def search_for_focus(self, focus_claims: list, active_attacks: list,
                         round_num: int) -> int:
        """Search executor LLM directly retrieves evidence.

        No DuckDuckGo middle-layer. The search executor uses its own
        capabilities (built-in search, training knowledge) to find evidence.
        """
        if not focus_claims:
            return 0

        pool_summary = "\n".join(
            f"  {ev.ref} | {ev.title[:120]}"
            for ev in self.pool.items[-10:]
        )

        focus_text = "\n".join(
            f"  [{c.get('claim_id','?')}] [{c.get('state','?')}]: {c.get('description','')[:200]}"
            for c in focus_claims[:3]
        )
        attack_text = "\n".join(
            f"  {a.get('claim_preview','')[:150]}"
            for a in active_attacks[-5:]
        )

        search_prompt = f"""You are the Evidence Layer Search Executor.

## CRITICAL: USE WEB SEARCH + VERIFY EVERY SOURCE
You MUST:
1. Search the web for evidence using your internet search capability
2. VERIFY each source is real — check that arXiv IDs resolve, URLs are live, DOIs exist
3. Only return evidence you have personally verified through web search
4. Include the specific verified URL or arXiv ID for each item
5. Do NOT fabricate, guess, or use training data alone

## SOURCE VERIFICATION RULES
- arXiv IDs: verify the paper exists on arxiv.org
- URLs: verify the page loads and contains the claimed information
- DOIs: verify they resolve through doi.org
- If you cannot verify a source, do NOT include it
- Mark unverifiable sources as "unverified" with a note

## EXISTING EVIDENCE (do NOT repeat)
{pool_summary or '(empty)'}

## FOCUS CLAIMS
{focus_text}

## RECENT ATTACKS
{attack_text or '(none)'}

## OUTPUT
```json
{{"new_evidence": [{{"ref": "arxiv:XXXX or verified URL", "title": "...", "detail": "specific data point or finding", "source": "arxiv|benchmark|case_study|web", "verified": true}}]}}
```

Search the web and verify. Return empty array only if nothing verifiable found."""

        try:
            from .content_layer import call_agent, parse_json_output
            raw = call_agent(self.search_executor_cfg, "", search_prompt)
            if self._token_tracker:
                self._token_tracker["input"] += len(search_prompt) // 4
                self._token_tracker["output"] += len(raw) // 4
                self._token_tracker["calls"] += 1
            data = parse_json_output(raw)
        except Exception:
            print(f"  [Evidence] Search executor call failed")
            return 0

        if not data:
            print(f"  [Evidence] No parseable output")
            return 0

        new_items = data.get("new_evidence", [])
        if not new_items:
            print(f"  [Evidence] No new evidence found")
            return 0

        added = 0
        for item in new_items[:5]:
            ref = item.get("ref", "")
            title = item.get("title", "")
            if not ref or not title:
                continue
            if ref in self.pool.refs:
                continue
            # Use the search executor's own verification status
            is_verified = item.get("verified", False)
            ev = EvidenceItem(
                ref=ref, title=title[:200],
                detail=item.get("detail", "")[:500],
                source=item.get("source", "web"),
                verification=VerificationTier.EXISTENCE_VERIFIED
                    if (is_verified or ref.startswith("arxiv:") or ref.startswith("http"))
                    else VerificationTier.UNVERIFIED,
            )
            if self.pool.add(ev, round_num):
                added += 1

        print(f"  [Evidence] +{added} new evidence (pool: {len(self.pool.items)})")
        return added

    # ── Echo composition (§3.2 step 2) ──

    def compose_echo(self, agent_name: str, question: str,
                     focus_data: list[dict], recent_activity: list[str],
                     perspective_seed: str, round_num: int,
                     review_targets: list[dict],
                     threats: list[dict] | None = None) -> str:
        """Compose the information echo for one content-layer agent."""
        lines = []

        lines.append(f"## QUESTION\n{question}\n")

        if perspective_seed:
            lines.append(f"## YOUR ANALYTICAL FOCUS\n{perspective_seed}\n")

        # Evidence pool
        lines.append("## EVIDENCE POOL")
        lines.append("  Cite using the REF (e.g. 'arxiv:2312.00752'), NOT the display number.")
        lines.append("")
        if not self.pool.items:
            lines.append("  (empty)")
        else:
            for ev in self.pool.items:
                tier = {"verified":"✓✓","fully_verified":"✓✓✓","abstract_consistent":"✓",
                        "existence_verified":"○","unverified":"⚠"}.get(ev.verification.value,"⚠")
                lines.append(f"  REF: {ev.ref:50s} {tier} {ev.title[:120]}")
                if ev.detail:
                    lines.append(f"       {ev.detail[:200]}")
        lines.append("")

        # Focus claims
        if focus_data:
            lines.append("## FOCUS (claims needing attention)")
            for fc in focus_data:
                lines.append(f"  · {fc['claim_id']} [{fc.get('state','?')}]: {fc.get('description','')[:120]}")
        else:
            lines.append("## FOCUS\n  No claims yet. You are among the first to speak.")
        lines.append("")

        # Recent activity
        if recent_activity:
            lines.append("## RECENT ACTIVITY")
            for act in recent_activity[-6:]:
                lines.append(f"  · {act}")
        lines.append("")

        # Your chains under attack — defend or revise
        if threats:
            lines.append("## YOUR CHAINS UNDER ATTACK — you MUST respond")
            for t in threats[:5]:
                lines.append(f"  [{t['chain_id']}] step {t['step_id']} attacked by {t['attacker']}")
                lines.append(f"  Attack: {t['claim'][:200]}")
                lines.append(f"  Action: revise_chain to repair, or publish a new chain defending your reasoning.")
            lines.append("")

        # Review targets
        if review_targets:
            lines.append("## REVIEW TARGETS (examine for flaws)")
            lines.append("  Ordered by scrutiny: least-attacked chains first.")
            for rt in review_targets[:8]:
                atk = rt.get('attacks', 0)
                tag = " [未审查]" if atk == 0 else f" [{atk}次攻击]"
                lines.append(f"  [{rt['chain_id']}] Agent '{rt['agent']}' v{rt['version']}{tag}")
                for s in rt.get('steps', [])[:3]:
                    lines.append(f"    Step {s['step_id']}: {s['assertion'][:120]}")
                    for ev in s.get('evidence', [])[:1]:
                        lines.append(f"      ↳ {ev.get('ref','?')[:50]}")
            lines.append("")
            lines.append("  If you find a flaw in any step above, issue an attack targeting that specific step.")
            lines.append("")

        # Action instructions
        lines.append("## YOUR TURN")
        lines.append("Choose ONE action based on your honest assessment:")
        lines.append("  attack — if you found a specific flaw in a REVIEW TARGET step")
        lines.append("  publish_chain — only if you have a genuinely new perspective not covered above")
        lines.append("  revise_chain — to repair YOUR OWN chain that was attacked")
        lines.append("  pass — if you have nothing new to add. Passing is the correct default.")
        lines.append("Respond with JSON only.")

        return "\n".join(lines)

    def get_perspective_seeds(self, n_agents: int) -> list[str]:
        seeds = PERSPECTIVE_LIBRARY.get(self.task_info.get("domain", "general"), [DEFAULT_PERSPECTIVE])
        if len(seeds) >= n_agents:
            return seeds[:n_agents]
        return seeds + [DEFAULT_PERSPECTIVE] * (n_agents - len(seeds))
