"""Demo scenarios for Chain-Centric."""

DEMO_SCENARIOS = {
    "code_review": (
        "Code Review: Performance Bug",
        """Review the following PR code change for potential performance issues.

The PR changes the sorting logic in a Java e-commerce order processing service:

Before:
```
Collections.sort(items);  // uses natural ordering, O(n log n)
```

After:
```
items.sort((a, b) -> customComparator(a, b));
```

The customComparator method calls `db.lookup(a.getId())` internally.
The PR author claims: "This change makes sorting more flexible. Performance is unaffected."

Evidence from benchmarking:
- 100 items: 12ms
- 1,000 items: 340ms  
- 10,000 items: 8,900ms

The service handles 1,000-50,000 items per batch.

Is there a performance regression? What is the root cause?""",
    ),
    "architecture": (
        "Architecture Decision: State Space Models vs Transformers",
        """Compare Mamba (State Space Model) against Transformer architectures for
a production NLP system handling 2,000-token sequences.

Key requirements:
- 99.9% recall on long-range dependency tasks
- Throughput: 10,000 inferences/second
- Memory budget: 16GB GPU

- Paper A (arxiv:2312.00752): Mamba shows O(n) memory scaling.
  At seq_len=2048, peak memory is 58 percent of equivalent Transformer.
- Paper B (arxiv:2401.xxxxx): Mamba Long Range Arena recall: ~85 percent
  vs Transformer ~97 percent at seq_len=2048.
- Paper C (Semantic Scholar): Mamba training cost ~40 percent of Transformer
  for equivalent parameter count.
- Paper D (GitHub benchmark): Mamba inference latency at batch=32,
  seq_len=2048: 12ms vs Transformer: 18ms.

Which architecture is more suitable and why?""",
    ),
    "incident": (
        "Incident Analysis: Latency Spike",
        """Analyze a production incident:
At 02:17, P99 latency on the e-commerce platform spiked from 200ms to 12s.
Five systems show alerts: Order Service, Inventory Service, Payment Gateway,
Redis cluster, and Kong API Gateway.

Evidence:
- Order Service deployed at 01:50. Git diff shows change to Redis key serialization
- Redis memory: 45 percent at 01:50, rose to 89 percent at 02:09.
  Slowlog shows spike on GET order:cache:*
- Kong retry rate: 0.1 percent to 23 percent. All retries point to Order Service timeout
- Order Service QPS: flat line, no traffic spike
- Inventory and Payment services: no deployment changes, but latency also elevated
- No infrastructure changes or network events

What is the root cause? What is the causal chain?""",
    ),
}
