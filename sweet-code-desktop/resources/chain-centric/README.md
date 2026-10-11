# Chain-Centric: Observational Protocol for Multi-Agent Adversarial Reasoning

[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.20244533.svg)](https://doi.org/10.5281/zenodo.20244533)
[![ORCID](https://img.shields.io/badge/ORCID-0009--0009--5902--1272-green)](https://orcid.org/0009-0009-5902-1272)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Status](https://img.shields.io/badge/status-v5.1_empirically_validated-blue)]()

> **Not a chatbot. An adversarial reasoning laboratory. 5 heterogeneous LLMs attack each other's reasoning chains. The coordination layer only observes — never intervenes.**

---

## What It Does

Chain-Centric answers one question: **"Can adversarial cross-examination by multiple LLMs produce more reliable conclusions than a single LLM?"**

The answer is yes. Tested across 8 scientific problems with 5 heterogeneous models (Claude + GLM + MiMo + Doubao + Qwen). Key findings:

| Finding | Evidence |
|---------|----------|
| **Corrects training-data frequency bias** | Alzheimer's: single LLM ranked amyloid A>B>C. 176 attacks later, consensus became B≈C>A. Single LLM revised its answer upon seeing the debate. |
| **Honest about uncertainty** | Fermi Paradox: only 1 claim survived 144 attacks. System correctly reports: "insufficient evidence to rank." |
| **Confirms when consensus is solid** | Sleep function: both single LLM and 5-agent agreed C>B>A. 135 attacks found no vulnerabilities. |
| **Generates hypotheses, not just ranks them** | Obesity open-ended: agents created 4 novel hypotheses, attacked each other, converged on 3. |

---

## Core Principle: Observe, Never Intervene

Chain-Centric's coordination layer is **pure computation, zero LLM calls.** It does not tell agents what to do. It only measures:

```
┌─────────────────────────────────────────────┐
│         COORDINATION LAYER (Observer)        │
│                                              │
│  H_sym Observer: Is the symbol space         │
│  still expanding? → Convergence signal       │
│                                              │
│  Scrutiny Multiplier: Has this claim been    │
│  cross-examined? → Trust calibration         │
│                                              │
│  Hamming-weighted Counter: Micro-fluctuation │
│  or genuine state change? → Noise filter     │
│                                              │
│  Output: Three-zone divergence map            │
│  [未审查] [共识] [争议] [崩塌]                 │
└─────────────────────────────────────────────┘
```

Every metric derives from **observable agent behavior** — zero confidence scores, zero self-report, zero LLM judgment in the coordination layer.

---

## How It Works

### Three-Layer Architecture

```
EVIDENCE LAYER      →  5-stage pipeline. Papers decomposed into claim-level evidence.
                       Search ONCE. Verify. Share uniformly to all agents.

CONTENT LAYER       →  5 heterogeneous agents. Only 4 actions allowed:
                       publish_chain | attack | revise_chain | pass
                       "I agree" is NOT a valid action.

COORDINATION LAYER  →  Pure computation. H_sym symbolic entropy convergence.
                       Three-zone divergence map. No thresholds, no voting.
```

### Convergence: H_sym Observer

Instead of "signal X must be below threshold Y" (v2's approach, which dragged to 144 rounds), v5 observes one physical fact:

> **Has the system stopped producing new entropy configurations?**

1. 8 continuous entropies → discretized into symbol strings
2. Each round: is this symbol new? → counter +1 or weighted reset
3. N consecutive rounds without new symbols → natural convergence

Converges at 37-57 rounds across all test problems. No parameters to tune per domain.

### Output: Three-Zone Divergence Map

```
▌未审查区 — 0次攻击，未经验证
  ◌ [未审查] This claim has high α but was never challenged

▌共识区 — Through cross-examination, not broken
  ◆ [铁证] Survived 16 attacks, 100% survival rate
  ✓ [共识] Survived 3 attacks, 100% survival

▌争议区 — Ranking depends on methodological assumptions
  ◇ 17 contested claims. Core dispute: "Is GWAS evidence causal?"

▌崩塌区 — Broken under attack
  ✗ 19 collapsed chains
```

---

## Empirical Results (5-agent, 8 problems)

| Problem | Rounds | Attacks | Consensus | vs Single LLM |
|---------|--------|---------|-----------|---------------|
| Microbiome (obesity causality) | 41 | 122 | Hierarchical model | Consistent |
| Intermittent Fasting (ranking) | 50 | 140 | C > A > B | **Disagree** |
| Intermittent Fasting (integration) | 44 | 93 | Unified model | Consistent |
| Alzheimer's Disease | 57→49 | 176→94 | B≈C > A | **LLM revised** |
| Sleep Function | 43 | 135 | C > B > A | Consistent |
| Depression (serotonin) | 40 | 96 | B > C > A | **LLM revised** |
| Fermi Paradox (thin data) | 39 | 144 | Only 1 claim survives | Consistent |
| Dinosaur Extinction | 37 | 106 | A (impact) strongest | Consistent |
| Obesity (open-ended) | 57 | 117 | 3 novel hypotheses | Consistent |

**Pattern:** When the literature consensus is ahead of the curve, both agree. When consensus lags, adversarial debate corrects it. Single LLMs revised their answers in 2 of 3 disagreements.

---

## Why Not Just Ask a Single LLM?

Single LLMs suffer from **training-data frequency bias**. "Amyloid causes Alzheimer's" appears 10,000× more often than "GWAS variants converge on microglia" in training corpora. A single forward pass takes the highest-probability path — it echoes frequency, not truth.

Five heterogeneous models attacking each other's reasoning steps **re-weights evidence by adversarial survivability** — not by how often it appears in PubMed.

| | Single LLM | Chain-Centric 5-agent |
|---|---|---|
| Speed | 30 seconds | 30-60 minutes |
| Cost | ~2K tokens | 700K-1,700K tokens |
| Audit trail | None — one answer | Every step of every chain traceable |
| Adversarial testing | Self-critique only ("I might be wrong") | 3 independent attackers per claim |
| Methodology risks | Implicit | Structured risk table |
| Uncertainty | "Probably..." | "This claim had 0 attacks — we don't know." |

**The single LLM is a calculator. Chain-Centric is a wind tunnel.**

---

## Version History

**Current: v5.1 (branch `v5.1`)** — All previous versions preserved on separate branches for traceability.

| Version | Branch | Key Innovation | What Changed | Status |
|---------|--------|---------------|-------------|--------|
| **v5.1** | `v5.1` | Hamming-weighted counter + topology veto | Micro-fluctuations no longer fully reset convergence counter. Attack topology collapse detected and vetoed. | **Active** |
| **v5.0** | `v5-scrutiny` | Scrutiny multiplier + unscrutinized zone | 0-attack claims marked [未审查] instead of falsely labeled "consensus". Evidence pool supports claim-level paper decomposition (`load_paper`). Review targets sorted by scrutiny. | Active |
| **v4.0** | `v4-hsym-convergence` | H_sym Observer — "no new symbols" convergence | Replaced v3's |ΔH_sym|<0.05 with pure observation. Two-line architecture: H_sym terminates, S_novel snapshots. Three-zone divergence map. | Maintained |
| **v3.0** | `v3-hsym-convergence` | H_sym |ΔH_sym|<ε convergence | **Deprecated.** |ΔH_sym|<0.05 was too strict — converged on 60-round tests never met the criterion. Replaced by v4's "no new symbols" approach. | Deprecated |
| **v2.0** | `main` | 7-entropy two-tier threshold voting | Original architecture: Path 0 (S_novel), Path 1 (T_max+H_chain), Path 2 (all-pass), Path 3 (budget). 6+ tunable thresholds. **Converged at 144 rounds on microbiome test** due to T_max+H_chain oscillating around thresholds. | Legacy |

### What Each Version Deprecated and Why

```
v2 → v3:  Threshold voting deprecated — heuristic ε_t=0.12, ε_c=0.20 had no information-theoretic basis.
          Oscillating entropy values around fixed thresholds caused 144-round drag on microbiome test.

v3 → v4:  |ΔH_sym|<0.05 deprecated — single-symbol fluctuations caused |Δ| jumps of 0.3+, 
          making convergence criterion unreachable within 60 rounds.

v4 → v5:  "Consensus" label for 0-attack claims deprecated — violated Bayesian principle that 
          unexamined claims should regress to prior. Scrutiny multiplier from Poisson process.

v5 → v5.1: Full counter reset on any new symbol deprecated — 1-bit micro-fluctuation ≠ 
           7-bit state change. Hamming distance in symbol space provides weighted reset.
           Topology collapse veto prevents convergence when attack graph degrades to <3 pairs.
```

---

## Quick Start

```bash
git clone https://github.com/dzy235/chain-centric-multi-agent.git
cd chain-centric-multi-agent
pip install -e ".[llm]"

# Configure provider keys in your shell or in a local .env file.
# Never commit or share real API keys.

python -m chain_centric.cli demo --scenario architecture
```

```python
from chain_centric.config import Config
from chain_centric.session import Session

config = Config.from_env()
session = Session(config, "Your research question here")
result = session.run()
print(result['divergence_map'])
```

---

## Documentation

- **[Preprint v2](chain_centric_preprint_v2.md)** — Architecture and specifications
- **[Full Algorithm Specification](chain_centric_spec.md)** — Implementation-level spec v0.3.0
- **Papers:** `~/Desktop/论文版本/` — v2 through v5.1

## Citation

```bibtex
@software{dai_2026_20244533,
  title     = {Chain-Centric: A Protocol Architecture for Auditable,
               Step-Addressable, Coordination-Independent Multi-LLM Reasoning},
  author    = {Dai, Zhenyu},
  year      = 2026,
  publisher = {Zenodo},
  doi       = {10.5281/zenodo.20244533},
  url       = {https://doi.org/10.5281/zenodo.20244533}
}
```

## License

MIT — see [LICENSE](LICENSE)
