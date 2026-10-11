# Fixed Input: Microbiome Obesity v1

Purpose: keep the initial task constant for later ablations and same-model versus heterogeneous-model experiments.

## Files

- `question.txt`: canonical user question.
- `claim_evidence_pool.json`: claim-level evidence pool derived from the cited papers.
- `experiment_matrix.md`: planned comparable runs.

## First Test

`claim_evidence_loaded_baseline`

This test asks whether preloading claim-level evidence reduces whole-paper/title-level noise and makes the final divergence map cleaner:

- survived after scrutiny
- unscrutinized
- contested
- collapsed

It does not prove the system is true. It tests whether the evidence granularity improves auditability.

## Control Rule

Future runs should keep `question.txt` and `claim_evidence_pool.json` unchanged unless the fixed input version is incremented to `microbiome_obesity_v2`.
