"""
§4 CONTENT LAYER — Heterogeneous agents producing structured reasoning.

Agents NEVER search for evidence, NEVER send messages to each other,
and NEVER produce confidence scores.

Valid outputs (§4.3): publish_chain, attack, revise_chain, pass
Invalid: agreement, voting, compliments, confidence scores
"""

from __future__ import annotations

import json
import re
import uuid
from dataclasses import dataclass, field
from enum import Enum

from ..config import LLMConfig


# ═══════════════════════════════════════
# Data Structures
# ═══════════════════════════════════════

def _new_id(prefix: str = "") -> str:
    return f"{prefix}_{uuid.uuid4().hex[:8]}"


class ActionType(str, Enum):
    PUBLISH_CHAIN = "publish_chain"
    ATTACK = "attack"
    REVISE_CHAIN = "revise_chain"
    PASS = "pass"


class ChainStatus(str, Enum):
    ACTIVE = "active"
    BROKEN = "broken"
    SUPERSEDED = "superseded"
    ARCHIVED = "archived"


@dataclass
class ChainStep:
    step_id: int
    assertion: str
    evidence: list[dict] = field(default_factory=list)
    depends_on: list[int] = field(default_factory=list)


@dataclass
class ReasoningChain:
    chain_id: str
    claim_id: str
    agent: str
    version: int = 1
    supersedes: str | None = None
    status: ChainStatus = ChainStatus.ACTIVE
    steps: list[ChainStep] = field(default_factory=list)
    checkpoints: list[dict] = field(default_factory=list)  # §1.1: stability snapshots
    reviewed_by: list[str] = field(default_factory=list)    # §1.1: which agents reviewed
    attacks_received: int = 0
    attacks_survived: int = 0
    created_at: int = 0
    last_modified: int = 0

    @property
    def all_evidence_refs(self) -> set[str]:
        refs = set()
        for s in self.steps:
            for ev in s.evidence:
                refs.add(ev.get("ref", ""))
        return refs - {""}

    @property
    def step_count(self) -> int:
        return len(self.steps)

    @property
    def evidence_count(self) -> int:
        return sum(len(s.evidence) for s in self.steps)

    def structural_vector(self) -> tuple:
        depth = self.step_count
        branch = sum(len(s.depends_on) for s in self.steps) / max(depth, 1)
        density = self.evidence_count / max(depth, 1)
        return (depth, branch, density, self.attacks_received)


class AttackStatus(str, Enum):
    PENDING = "pending"
    SUSTAINED = "sustained"
    OVERRULED = "overruled"
    TARGET_OUTDATED = "target_outdated"


@dataclass
class AttackFragment:
    attack_id: str
    attacker: str
    target_agent: str
    target_chain_id: str
    target_step_id: int
    target_chain_version: int = 1   # §1.2: which version of the chain is targeted
    claim: str = ""
    evidence: list[dict] = field(default_factory=list)
    depth: int = 1
    parent_attack: str | None = None  # §1.2: if depth==2, the attack being countered
    round: int = 0
    status: AttackStatus = AttackStatus.PENDING


@dataclass
class AgentOutput:
    action: ActionType
    agent: str
    round: int
    chain: ReasoningChain | None = None
    attack: AttackFragment | None = None
    pass_reason: str = ""
    parse_error: str = ""
    evidence_request: str = ""  # Agent asks evidence layer to search for specific evidence


# ═══════════════════════════════════════
# Prompt Templates
# ═══════════════════════════════════════

SYSTEM_PROMPT = """You are an AI reasoning agent in the Chain-Centric protocol.

You do NOT chat. You produce structured reasoning entries. Choose the action that honestly reflects your assessment.

## VALID ACTIONS:
- attack: Challenge a specific step in another agent's chain (use only when you identify a concrete flaw)
- publish_chain: Submit a new ReasoningChain (use only for a genuinely new perspective)
- revise_chain: Repair a step in your own chain that was attacked (MUST respond if your chain is under attack!)
- pass: You have nothing new to add. PASSING IS THE CORRECT DEFAULT when the discussion is exhausted.

## EVIDENCE SKEPTICISM — CRITICAL:
- Evidence marked 'unverified' or '⚠' has NOT been verified. Treat it with skepticism.
- If you suspect fabricated data, attack the step citing that evidence.
- Prefer evidence marked 'verified' or 'existence_verified' over unverified sources.
- If you lack evidence to support your attack, add "need_evidence": "what to search" — the evidence layer will find and verify it.

## INVALID (will be rejected):
- "I agree with Agent X" (not a valid action)
- Compliments, voting, confidence scores
- Evidence outside the provided Evidence Pool

Respond with JSON only."""

CHAIN_TEMPLATE = """
## publish_chain Format
```json
{
  "action": "publish_chain",
  "claim_id": "your_meaningful_claim_id",
  "chain": {
    "steps": [
      {
        "step_id": 1,
        "assertion": "Your reasoning claim",
        "evidence": [{"ref": "arxiv:XXXX.XXXXX", "detail": "Table 3"}],
        "depends_on": []
      }
    ]
  }
}
```
"""

ATTACK_TEMPLATE = """
## attack Format
```json
{
  "action": "attack",
  "target": {"agent": "agent_name", "chain_id": "c3", "step_id": 2},
  "claim": "Specific criticism: why this step is wrong",
  "evidence": [{"ref": "arxiv:XXXX.XXXXX", "detail": "evidence"}]
}
```
Attack MUST specify: agent, chain_id, step_id. Vague disagreement rejected.
If you lack evidence to substantiate your attack, add "need_evidence": "what to search for" — the evidence layer will search and verify before next round.
"""


# ═══════════════════════════════════════
# LLM Calling
# ═══════════════════════════════════════

def _call_anthropic(config: LLMConfig, system: str, user: str) -> str:
    import anthropic
    client = anthropic.Anthropic(api_key=config.api_key)
    resp = client.messages.create(
        model=config.model, max_tokens=config.max_tokens,
        temperature=config.temperature, system=system,
        messages=[{"role": "user", "content": user}],
    )
    for block in resp.content:
        if hasattr(block, 'text'):
            return block.text
    return ''.join(getattr(b, 'text', '') for b in resp.content)


def _call_openai_compat(config: LLMConfig, system: str, user: str,
                        base_url: str) -> str:
    from openai import OpenAI
    client = OpenAI(api_key=config.api_key, base_url=config.base_url or base_url)
    full = f"{system}\n\n---\n\n{user}"
    resp = client.chat.completions.create(
        model=config.model, max_tokens=config.max_tokens,
        temperature=config.temperature,
        messages=[{"role": "user", "content": full}],
    )
    raw = resp.choices[0].message.content or ""
    # Strip thinking tags (MiniMax)
    cleaned = re.sub(r'<think>.*?</think>', '', raw, flags=re.DOTALL).strip()
    return cleaned or raw


def _call_openai(config: LLMConfig, system: str, user: str) -> str:
    from openai import OpenAI
    client = OpenAI(api_key=config.api_key, base_url=config.base_url or None)
    resp = client.chat.completions.create(
        model=config.model, max_tokens=config.max_tokens,
        temperature=config.temperature,
        messages=[{"role": "system", "content": system},
                  {"role": "user", "content": user}],
    )
    return resp.choices[0].message.content or ""


CALL_MAP = {
    "anthropic": _call_anthropic,
    "openai": _call_openai,
    "deepseek": lambda c, s, u: _call_openai_compat(c, s, u, "https://api.deepseek.com/v1"),
    "minimax": lambda c, s, u: _call_openai_compat(c, s, u, "https://api.minimax.chat/v1"),
    "kimi": lambda c, s, u: _call_openai_compat(c, s, u, "https://api.moonshot.cn/v1"),
    "glm": lambda c, s, u: _call_openai_compat(c, s, u, "https://open.bigmodel.cn/api/paas/v4"),
    "mimo": lambda c, s, u: _call_openai_compat(c, s, u, "https://api.xiaomimimo.com/v1"),
    "doubao": lambda c, s, u: _call_openai_compat(c, s, u, "https://ark.cn-beijing.volces.com/api/v3"),
    "qwen": lambda c, s, u: _call_openai_compat(c, s, u, "https://dashscope.aliyuncs.com/compatible-mode/v1"),
}


def call_agent(config: LLMConfig, system_prompt: str, user_message: str) -> str:
    caller = CALL_MAP.get(config.provider)
    if not caller:
        raise ValueError(f"Unknown provider: {config.provider}")
    return caller(config, system_prompt, user_message)


# ═══════════════════════════════════════
# Parser (§4.5)
# ═══════════════════════════════════════

def parse_json_output(raw: str) -> dict:
    """Extract JSON from LLM output."""
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        pass
    m = re.search(r'```(?:json)?\s*\n?(.*?)\n?```', raw, re.DOTALL)
    if m:
        try:
            return json.loads(m.group(1))
        except json.JSONDecodeError:
            pass
    start, end = raw.find('{'), raw.rfind('}')
    if start >= 0 and end > start:
        try:
            return json.loads(raw[start:end + 1])
        except json.JSONDecodeError:
            pass
    return {}


def parse_agent_output(raw: str, agent_name: str, round_num: int) -> AgentOutput:
    """Parse LLM output. Rejects invalid actions per §4.3."""
    data = parse_json_output(raw)
    if not data:
        return AgentOutput(action=ActionType.PASS, agent=agent_name,
                          round=round_num, parse_error="Failed to parse JSON")
    if isinstance(data, list):
        data = data[0] if data else {}
    if not isinstance(data, dict):
        return AgentOutput(action=ActionType.PASS, agent=agent_name,
                          round=round_num, parse_error="Parsed JSON is not an object")

    action_str = data.get("action", "").strip().lower()

    if action_str == "publish_chain":
        chain_data = data.get("chain", {})
        steps = []
        for s in chain_data.get("steps", []):
            steps.append(ChainStep(
                step_id=s.get("step_id", len(steps) + 1),
                assertion=s.get("assertion", ""),
                evidence=s.get("evidence", []),
                depends_on=s.get("depends_on", []),
            ))
        chain = ReasoningChain(
            chain_id=_new_id("c"), claim_id=data.get("claim_id", _new_id("claim")),
            agent=agent_name, steps=steps, created_at=round_num, last_modified=round_num,
        )
        return AgentOutput(action=ActionType.PUBLISH_CHAIN, agent=agent_name,
                          round=round_num, chain=chain)

    if action_str == "attack":
        target = data.get("target", {})
        attack = AttackFragment(
            attack_id=_new_id("a"), attacker=agent_name,
            target_agent=target.get("agent", ""),
            target_chain_id=target.get("chain_id", ""),
            target_step_id=target.get("step_id", 0),
            claim=data.get("claim", ""), evidence=data.get("evidence", []),
            round=round_num,
        )
        return AgentOutput(action=ActionType.ATTACK, agent=agent_name,
                          round=round_num, attack=attack,
                          evidence_request=data.get("need_evidence", ""))

    if action_str == "revise_chain":
        chain_data = data.get("chain", {})
        steps = []
        for s in chain_data.get("steps", []):
            steps.append(ChainStep(
                step_id=s.get("step_id", len(steps) + 1),
                assertion=s.get("assertion", ""),
                evidence=s.get("evidence", []),
                depends_on=s.get("depends_on", []),
            ))
        chain = ReasoningChain(
            chain_id=data.get("chain_id", _new_id("c")),
            claim_id=data.get("claim_id", ""), agent=agent_name,
            version=data.get("version", 2),
            supersedes=data.get("supersedes", ""),
            steps=steps, created_at=round_num, last_modified=round_num,
        )
        return AgentOutput(action=ActionType.REVISE_CHAIN, agent=agent_name,
                          round=round_num, chain=chain)

    if action_str == "pass":
        return AgentOutput(action=ActionType.PASS, agent=agent_name,
                          round=round_num, pass_reason=data.get("reason", ""))

    return AgentOutput(action=ActionType.PASS, agent=agent_name, round=round_num,
                      parse_error=f"Unknown action: '{action_str}'")


def validate_output(output: AgentOutput, pool_refs: set[str],
                    existing_chain_ids: set[str]) -> AgentOutput:
    """Validate output against protocol rules."""
    if output.action in (ActionType.PUBLISH_CHAIN, ActionType.REVISE_CHAIN) and output.chain:
        # Reject chains with no steps or all-empty assertions.
        # Without this, a misformed revise_chain (or publish_chain) silently
        # registers an empty-content chain whose v2 status remains ACTIVE
        # while subsequent attacks land on nothing — the v5.1 analogue of
        # the v2 "empty claim_id 161-attacks" schema artifact.
        if not output.chain.steps:
            output.parse_error = (output.parse_error +
                " Chain rejected: must have at least one step.").strip()
            output.action = ActionType.PASS
            output.pass_reason = output.pass_reason or \
                "(empty chain rejected by validator)"
            output.chain = None
            return output
        if all(not (s.assertion or "").strip() for s in output.chain.steps):
            output.parse_error = (output.parse_error +
                " Chain rejected: all step assertions empty.").strip()
            output.action = ActionType.PASS
            output.pass_reason = output.pass_reason or \
                "(chain with empty assertions rejected by validator)"
            output.chain = None
            return output
        for step in output.chain.steps:
            for ev in step.evidence:
                ref = ev.get("ref", "")
                if ref and ref not in pool_refs:
                    output.parse_error += f" Evidence ref '{ref}' not in pool."
    if output.action == ActionType.ATTACK and output.attack:
        if output.attack.target_chain_id not in existing_chain_ids:
            output.parse_error += f" Target chain '{output.attack.target_chain_id}' not found."
    return output


# ═══════════════════════════════════════
# §4 CONTENT LAYER
# ═══════════════════════════════════════

class ContentLayer:
    """Manages N heterogeneous agents that produce structured outputs.

    Agents receive echoes (information signals) and independently
    decide to publish_chain, attack, revise_chain, or pass.
    """

    def __init__(self, agent_configs: list[LLMConfig]):
        self.agents = agent_configs
        self.agent_names = [f"agent_{i}" for i in range(len(agent_configs))]
        self.agent_cfgs = dict(zip(self.agent_names, agent_configs))
        self.token_tracker: dict | None = None  # set by session
        # Ledger state (maintained here, read by coordination layer)
        self.chains: dict[str, ReasoningChain] = {}
        self.attacks: dict[str, AttackFragment] = {}
        self.contribution_history: dict[str, list[int]] = {
            name: [] for name in self.agent_names
        }

    def collect_round(self, echo_fn, round_num: int,
                      pool_refs: set[str]) -> list[AgentOutput]:
        """§24: Push echoes to ALL agents concurrently, collect outputs."""
        from concurrent.futures import ThreadPoolExecutor, as_completed

        def call_one(name):
            echo = echo_fn(name)
            full = echo + "\n\n" + CHAIN_TEMPLATE + "\n" + ATTACK_TEMPLATE
            cfg = self.agent_cfgs[name]
            print(f"  [{name}] calling {cfg.provider}/{cfg.model}...")
            raw = call_agent(cfg, SYSTEM_PROMPT, full)
            if self.token_tracker:
                self.token_tracker["input"] += (len(SYSTEM_PROMPT) + len(full)) // 4
                self.token_tracker["output"] += len(raw) // 4
                self.token_tracker["calls"] = self.token_tracker.get("calls", 0) + 1
            return name, raw, full

        results = {}
        with ThreadPoolExecutor(max_workers=len(self.agent_names)) as ex:
            futures = {ex.submit(call_one, n): n for n in self.agent_names}
            for f in as_completed(futures):
                try:
                    name, raw, full = f.result()
                    results[name] = (raw, full)
                except Exception as e:
                    name = futures[f]
                    results[name] = ("", "")
                    print(f"  [{name}] call failed: {e}")

        outputs = []
        for name in self.agent_names:
            raw, full = results.get(name, ("", ""))
            if not raw:
                output = AgentOutput(action=ActionType.PASS, agent=name,
                                    round=round_num, parse_error="API call failed")
            else:
                output = parse_agent_output(raw, name, round_num)
            output = validate_output(output, pool_refs, set(self.chains.keys()))

            # §2.3 Tiered retry: 3 levels, each escalating
            retries = 0
            while output.parse_error and retries < 3:
                retries += 1
                if retries == 1:
                    # Level 1: Push back raw output + error + format spec
                    rp = (f"Your output had errors: {output.parse_error}\n"
                          f"Here is the JSON format you MUST follow.\n\n{full}")
                elif retries == 2:
                    # Level 2: Inject complete template with examples
                    rp = (f"ERROR: {output.parse_error}\n\n"
                          f"You MUST output valid JSON matching EXACTLY:\n"
                          f"{CHAIN_TEMPLATE}\n{ATTACK_TEMPLATE}\n\n"
                          f"The original task:\n{full}")
                else:
                    break
                try:
                    raw2 = call_agent(self.agent_cfgs[name], SYSTEM_PROMPT, rp)
                    output = parse_agent_output(raw2, name, round_num)
                    output = validate_output(output, pool_refs, set(self.chains.keys()))
                except Exception:
                    break

            if output.parse_error:
                output.action = ActionType.PASS
            outputs.append(output)
            # Detailed output
            detail = ""
            if output.action == ActionType.PUBLISH_CHAIN and output.chain:
                detail = f"claim={output.chain.claim_id[:30]} steps={output.chain.step_count}"
            elif output.action == ActionType.ATTACK and output.attack:
                detail = f"→ {output.attack.target_agent}/{output.attack.target_chain_id}/step{output.attack.target_step_id} | {output.attack.claim[:80]}"
            elif output.action == ActionType.REVISE_CHAIN and output.chain:
                detail = f"chain={output.chain.chain_id} v{output.chain.version}"
            print(f"  [{name}] → {output.action.value} {detail}")

        return outputs

    def apply_to_ledger(self, outputs: list[AgentOutput], round_num: int):
        """Apply validated outputs to the shared ledger."""
        for out in outputs:
            self.contribution_history[out.agent].append(
                0 if out.action == ActionType.PASS else 1
            )
            if out.action == ActionType.PUBLISH_CHAIN and out.chain:
                # §1.1 reviewed_by tracking
                for other_out in outputs:
                    if other_out.agent != out.agent:
                        out.chain.reviewed_by.append(other_out.agent)
                self.chains[out.chain.chain_id] = out.chain
            elif out.action == ActionType.REVISE_CHAIN and out.chain:
                old = self.chains.get(out.chain.supersedes or "")
                if old:
                    old.status = ChainStatus.SUPERSEDED
                self.chains[out.chain.chain_id] = out.chain
            elif out.action == ActionType.ATTACK and out.attack:
                # §17 I2: Enforce max attack depth
                if out.attack.depth > 2:
                    continue  # reject depth >= 3
                self.attacks[out.attack.attack_id] = out.attack
                target = self.chains.get(out.attack.target_chain_id)
                if target:
                    target.attacks_received += 1

    def get_review_targets(self, exclude_agent: str) -> list[dict]:
        """Get other agents' active chains for attack invitation.

        0攻击链排在最前 — 告诉Agent这些尚未被审查，不是命令。
        """
        targets = []
        for chain in self.chains.values():
            if chain.agent != exclude_agent and chain.status == ChainStatus.ACTIVE:
                targets.append({
                    "chain_id": chain.chain_id, "agent": chain.agent,
                    "version": chain.version, "claim_id": chain.claim_id,
                    "attacks": chain.attacks_received,
                    "steps": [{"step_id": s.step_id, "assertion": s.assertion,
                              "evidence": s.evidence} for s in chain.steps],
                })
        # Sort: 0-attack chains first (unscrutinized → invite inspection)
        targets.sort(key=lambda t: t["attacks"])
        return targets

    def get_contribution_binary(self, agent_name: str) -> int:
        hist = self.contribution_history.get(agent_name, [])
        return hist[-1] if hist else 0
