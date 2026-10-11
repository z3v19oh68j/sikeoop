# Fixed Input: Chain-Centric Self Paper Writing v1

## Purpose

Run Chain-Centric on itself with a paper-writing task: produce a structured set of claims about Chain-Centric, each backed by observable evidence, that has survived adversarial cross-examination among 5 heterogeneous LLM agents.

The output is NOT a finished paper. It is a divergence map of claims about Chain-Centric — partitioned into iron-clad / consensus / contested / collapsed / unscrutinised — that the author can subsequently use as the substantive content of a paper.

## What this input contains

- `question.txt` — task definition. Includes scope, constraints, required examinations (E1-E8), and forbidden claims.
- `repository.json` — initial evidence pool seed, organised by namespace:
  - `code/...` — observable mechanism descriptions with file paths and line ranges.
  - `experiment/...` — summaries of v5.1 runs and the v2 microbiome baseline.
  - `historical_paper/...` — claims from prior paper drafts, treated as author's prior claims (NOT truth).
  - `external_arxiv/...` — peer-cited preprints already verified by the author.
  - `mathematical/...` — Shannon / Cover & Thomas references.
  - `control_theory/...` — Luenberger / Page / Lai references for observer-based change point detection framing.
  - `legacy_arch/...` — HEARSAY-II blackboard, Walton dialogue games.
  - `risk/...` — known limitations and structural blind spots the protocol cannot self-detect.

## Critical constraints

1. **Heterogeneity caveat.** This run is executed by five Chinese-vendor models (DeepSeek, GLM, MiMo, Doubao, Qwen). All five may share Chinese-internet training-data biases. The question explicitly requires agents to attack the heterogeneity-sufficiency claim. The output should reflect this risk.

2. **Self-reference caveat.** This input was designed in collaboration between the author and a Claude-based AI assistant. The participating agents are NOT the same instance and did not participate in input design, but they share the broader LLM training distribution. Agents are explicitly permitted to attack the input design itself.

3. **No retroactive truth claims.** The claim "Chain-Centric produces answers closer to truth than a single LLM" is forbidden. The archive does not contain retroactive truth-benchmark experiments.

4. **Negative claims encouraged.** Claims about what the protocol does NOT do, or scenarios where it is NOT useful, are at least as valuable as positive claims.

## Expected duration

- Estimated rounds: 30-80 (based on prior fixed-input runs)
- Estimated tokens: 700K-1.5M input, 100K-200K output
- Estimated wall-clock: 1-2 hours depending on API latency

## How to run

From command line (preferred for reproducibility):

```
cd /tmp/chain-centric-multi-agent
python3 /Users/dzy23335/Desktop/链心实验数据/runners/run_fixed_repository_question.py \
  --input-dir /Users/dzy23335/Desktop/链心实验数据/fixed_inputs/self_paper_writing_v1 \
  --max-rounds 1000 \
  --label app_self_paper_writing \
  --language zh \
  --agents deepseek:deepseek-chat,glm:glm-4-plus,mimo:mimo-v2-flash,doubao:doubao-seed-2-0-pro-260215,qwen:qwen-plus
```

Or via the macOS app: register a custom test pointing at this directory.

## Output location

- `checkpoint_v5.1_app_self_paper_writing.json` — running checkpoint (refreshed every few rounds during execution).
- `exp_v5.1_app_self_paper_writing_<timestamp>.json` — final saved JSON after termination.

## Interpretation

A "successful" run is NOT one where every claim about Chain-Centric is iron-clad. A successful run is one where:

1. The forbidden claim ("better than single LLM in truth-approach") is attacked and collapses.
2. The required examination claims (E1-E8) all receive attack attention; methodological deadlocks are reported as contested rather than forced to consensus.
3. The heterogeneity-sufficiency claim is challenged.
4. Negative claims (limitations, structural blind spots) appear in the iron-clad / consensus zones with clear evidence support.

A "failed" run signature: divergence map dominated by iron-clad claims praising Chain-Centric, no methodological deadlocks reported, heterogeneity claim unattacked. This signature would indicate sycophancy at the protocol level.
