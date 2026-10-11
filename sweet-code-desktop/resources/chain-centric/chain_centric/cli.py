"""Chain-Centric CLI"""
import json, sys, os
from pathlib import Path
import click

@click.group()
def main():
    """Chain-Centric Multi-Agent Framework."""
    pass

def _load_repository(session, repository_path: str | None):
    if not repository_path:
        return
    path = Path(repository_path).expanduser()
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    if isinstance(data, dict):
        for key in ("items", "evidence", "ccma_repository_items", "repository_items", "claims"):
            value = data.get(key)
            if isinstance(value, list):
                data = value
                break
        else:
            data = [data] if {"ref", "title", "detail"} & set(data) else data
    if not isinstance(data, list):
        raise click.ClickException(
            "Repository JSON must be a list or contain items/evidence/ccma_repository_items/repository_items/claims."
        )
    session.evidence.load_repository(data)
    print(f"Loaded repository: {path} ({len(data)} records)")

@main.command()
@click.option("--scenario", "-s", default="architecture",
              type=click.Choice(["architecture", "code_review", "incident"]))
@click.option("--max-rounds", type=int, default=None)
def demo(scenario, max_rounds):
    """Run a pre-built demo scenario."""
    from .config import Config, LLMConfig, SessionConfig
    from .session import Session
    from .demo.run_demo import DEMO_SCENARIOS

    title, question = DEMO_SCENARIOS[scenario]
    config = Config.from_env()
    if max_rounds is not None:
        config.session.max_rounds = max_rounds
    config.session.min_rounds_before_termination = 4

    session = Session(config, question)
    result = session.run()

    _print(result, title)
    out = f"/tmp/cc_demo_{scenario}.json"
    json.dump(result, open(out,"w"), indent=2, default=str, ensure_ascii=False)
    print(f"\nSaved: {out}")

@main.command()
@click.option("--question", "-q", required=True)
@click.option("--max-rounds", type=int, default=30)
@click.option("--repository", "-r", type=click.Path(exists=True, dir_okay=False),
              help="Optional preloaded evidence repository JSON.")
@click.option("--output", "-o", type=click.Path(dir_okay=False),
              help="Optional JSON output path.")
@click.option("--checkpoint", type=click.Path(dir_okay=False),
              help="Optional checkpoint JSON path.")
def run(question, max_rounds, repository, output, checkpoint):
    """Run with a custom question."""
    from .config import Config
    from .session import Session

    config = Config.from_env()
    config.session.max_rounds = max_rounds
    config.session.min_rounds_before_termination = 4

    session = Session(config, question)
    _load_repository(session, repository)
    result = session.run(checkpoint_path=checkpoint or "")
    _print(result, question[:80])
    if output:
        out = Path(output).expanduser()
        out.parent.mkdir(parents=True, exist_ok=True)
        with open(out, "w", encoding="utf-8") as f:
            json.dump(result, f, indent=2, default=str, ensure_ascii=False)
        print(f"\nSaved: {out}")

@main.command()
def keys():
    """Check API keys."""
    from .config import LLMConfig
    for p in ["anthropic", "openai", "deepseek", "minimax", "kimi", "glm", "mimo", "doubao", "qwen"]:
        c = LLMConfig(provider=p)
        print(f"  {p:12s}: {'SET' if c.api_key else 'MISSING'}")

def _print(result, title):
    print(f"\n{'='*60}")
    print(f"RESULT: {title}")
    print(f"{'='*60}")
    print(f"Rounds: {result['total_rounds']}  Terminated: {result['terminated']}")
    t = result.get("token_estimates",{})
    print(f"Tokens: {t.get('input',0)+t.get('output',0):,}  Calls: {t.get('calls',0)}")
    print(f"Claims: {len(result['claims'])}  Chains: {len(result['chains'])}  Attacks: {len(result['attacks'])}")
    for i,e in enumerate(result.get("entropy_trajectory",[])):
        b = all(e.get(k,99)<{"H_evidence":.15,"S_attack":.15,"H_part":.30,"H_chain":.20,"T_max":.12,"H_remaining":.12}.get(k,99) for k in ["H_evidence","S_attack","H_part","H_chain","T_max","H_remaining"])
        print(f"  R{i}: He={e.get('H_evidence',0):.3f} Sa={e.get('S_attack',0):.3f} Hp={e.get('H_part',0):.3f} Hc={e.get('H_chain',0):.3f} Tm={e.get('T_max',0):.3f} Hr={e.get('H_remaining',0):.3f}{' *' if b else ''}")
    for c in result.get("claims",[]):
        print(f"  [{c['claim_id'][:30]}] {c['state']} a={c['alpha']:.2f}")
    if result.get("attacks"):
        print(f"\nAttacks ({len(result['attacks'])}):")
        for a in result["attacks"][-3:]:
            print(f"  {a['attacker']}: {a['claim_preview'][:120]}")

if __name__ == "__main__":
    main()
