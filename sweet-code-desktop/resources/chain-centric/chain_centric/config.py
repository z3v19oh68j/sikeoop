"""Chain-Centric Configuration."""
import os
from dataclasses import dataclass, field
from pathlib import Path

def _load_dotenv():
    for p in [Path.cwd()/".env", Path.home()/".chain_centric.env"]:
        if p.exists():
            with open(p) as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith("#") and "=" in line:
                        k, v = line.split("=", 1)
                        v = v.strip().strip('"').strip("'")
                        if k not in os.environ:
                            os.environ[k] = v
_load_dotenv()

@dataclass
class LLMConfig:
    provider: str = "anthropic"
    model: str = "claude-sonnet-4-20250514"
    api_key: str = ""
    temperature: float = 0.3
    max_tokens: int = 4096
    base_url: str = ""

    def __post_init__(self):
        if not self.api_key:
            envs = {"anthropic":"ANTHROPIC_API_KEY","openai":"OPENAI_API_KEY",
                    "deepseek":"DEEPSEEK_API_KEY","minimax":"MINIMAX_API_KEY",
                    "kimi":"KIMI_API_KEY","glm":"GLM_API_KEY","mimo":"MIMO_API_KEY","doubao":"DOUBAO_API_KEY","qwen":"QWEN_API_KEY"}
            self.api_key = os.environ.get(envs.get(self.provider,""),"")

@dataclass
class SessionConfig:
    max_rounds: int | None = None
    termination_consecutive_rounds: int = 3
    min_rounds_before_termination: int = 5
    max_focus_claims: int = 3
    # §6.7 Primary termination signals
    epsilon_transfer: float = 0.12      # T_max: mutual influence undetectable
    epsilon_chain: float = 0.20          # H_chain: chain structures near-identical
    # §6.7 Auxiliary veto thresholds
    veto_attack: float = 0.60            # S_attack above this → attacks still active
    veto_remaining: float = 2.0          # H_remaining above this → unexplored space
    # Diagnostic-only metrics: H_evidence, H_part, ApEn — not used for termination
    scenario: str = "general"            # general | scientific | philosophical | fast | deep
    # §6.8 Termination strategy
    termination_strategy: str = "hsym"   # "hsym" (symbolic entropy) | "legacy" (threshold voting)
    epsilon_hsym: float = 0.05           # H_sym convergence threshold
    hsym_min_rounds: int = 10            # minimum rounds before hsym convergence can trigger

    def get_thresholds(self) -> dict:
        """Return primary + veto thresholds for two-tier termination (§6.7)."""
        base = {"T_max": self.epsilon_transfer, "H_chain": self.epsilon_chain,
                "S_attack": self.veto_attack, "H_remaining": self.veto_remaining}
        if self.scenario == "scientific":
            return {k: v * 0.85 for k, v in base.items()}
        elif self.scenario == "philosophical":
            return {k: v * 1.20 for k, v in base.items()}
        elif self.scenario == "fast":
            self.termination_consecutive_rounds = 2
            return {k: v * 0.70 for k, v in base.items()}
        elif self.scenario == "deep":
            self.termination_consecutive_rounds = 5
            return {k: v * 1.50 for k, v in base.items()}
        return base

@dataclass
class Config:
    agents: list[LLMConfig] = field(default_factory=list)
    evidence_llm: LLMConfig | None = None
    session: SessionConfig = field(default_factory=SessionConfig)

    @classmethod
    def from_env(cls) -> "Config":
        s = os.environ.get("CHAIN_CENTRIC_AGENTS",
            "anthropic:claude-sonnet-4-20250514,glm:glm-4-plus,mimo:mimo-v2-flash,doubao:doubao-seed-2-0-pro-260215")
        agents = []
        for spec in s.split(","):
            spec = spec.strip()
            if ":" in spec:
                p, m = spec.split(":",1)
                agents.append(LLMConfig(provider=p.strip(), model=m.strip()))
        evidence_spec = os.environ.get("CHAIN_CENTRIC_EVIDENCE_LLM", "kimi:moonshot-v1-8k").strip()
        evidence_provider, evidence_model = "kimi", "moonshot-v1-8k"
        if ":" in evidence_spec:
            evidence_provider, evidence_model = evidence_spec.split(":", 1)
        max_rounds_env = os.environ.get("CHAIN_CENTRIC_MAX_ROUNDS")
        return cls(
            agents=agents or [LLMConfig(provider="anthropic")],
            evidence_llm=LLMConfig(provider=evidence_provider.strip(), model=evidence_model.strip()),
            session=SessionConfig(
                max_rounds=int(max_rounds_env) if max_rounds_env else None,
                scenario=os.environ.get("CHAIN_CENTRIC_SCENARIO","general"),
                termination_strategy=os.environ.get("CHAIN_CENTRIC_TERMINATION","hsym"),
            ),
        )
