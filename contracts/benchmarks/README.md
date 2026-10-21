# Soroban Gas and Resource Footprint Profiling Suite

> Implements [GitHub Issue #230](https://github.com/utilityjnr1/lumena/issues/230)

This crate profiles CPU instruction and memory byte consumption for all
Lumena Soroban smart contract operations using the `soroban-sdk` testutils
budget API.  Results are asserted against defined thresholds to prevent
performance regression in CI.

---

## Quick Start

```bash
# Run benchmarks (prints table + writes benchmark-results.json)
cargo run --package benchmarks --bin benchmarks

# Or via pnpm from the repo root
pnpm benchmarks:run

# Then launch the web viewer
pnpm benchmarks:view
# → open http://localhost:3456
```

---

## What Gets Measured

| Contract | Operations |
|----------|-----------|
| `smart-account` | `init`, `transfer`, `query (signers + threshold)` |
| `paymaster` | `initialize`, `deposit`, `set_spend_limit`, `sponsor_invocation` |
| `session-keys` | `register_session_key`, `validate_session_call`, `revoke_session_key` |

For each operation the suite captures:

| Metric | Source |
|--------|--------|
| CPU Instructions | `env.budget().cpu_instruction_cost()` |
| Memory Bytes | `env.budget().memory_bytes_cost()` |

---

## Resource Budgets (CI Thresholds)

Thresholds are defined at the top of `src/main.rs` in the `cpu_budget` and
`mem_budget` modules.  If any invocation exceeds its ceiling the binary exits
with a non-zero status code, failing CI.

```
Stellar Mainnet hard limits (for reference):
  CPU:    100,000,000 instructions / transaction
  Memory: 41,943,040 bytes / transaction
```

---

## Output

### Terminal table

```
+--------------------------------------------+----------------------+----------------------+--------------+--------------+------------+
| Benchmark                                  |     CPU Instructions |         Memory Bytes |        CPU % |        Mem % | Status     |
+--------------------------------------------+----------------------+----------------------+--------------+--------------+------------+
| smart_account::init                        |                23031 |                 2872 |          4.6 |          0.1 | ✓ PASS     |
| smart_account::transfer                    |               235891 |                35340 |         39.3 |          1.4 | ✓ PASS     |
| ...                                        |                      |                      |              |              |            |
+--------------------------------------------+----------------------+----------------------+--------------+--------------+------------+
✓  All 10 benchmarks passed resource budgets.
```

### benchmark-results.json

Serialized JSON written to the repo root (one level up from this crate),
consumed by the web viewer.

### Web Viewer (http://localhost:3456)

```
pnpm benchmarks:view
```

Visual dashboard with progress bars showing budget utilisation per benchmark,
colour-coded status, and auto-refresh every 10 seconds.

---

## CI Integration

`.github/workflows/benchmarks.yml` runs on every PR/push that touches
`contracts/**`.  It:

1. Runs the benchmark binary (exits 1 if any threshold is exceeded).
2. Uploads `benchmark-results.json` as an artifact (kept 90 days).
3. Posts a resource footprint summary table as a PR comment.

---

## Adjusting Thresholds

If a new feature intentionally raises resource usage:

1. Run the suite locally to capture the new numbers.
2. Update the relevant constants in `src/main.rs`:

```rust
mod cpu_budget {
    pub const SMART_ACCOUNT_TRANSFER: u64 = 600_000; // ← update here
    // ...
}
```

3. Document the reason in the PR description.

---

## Project Layout

```
contracts/benchmarks/
├── Cargo.toml          — crate manifest (depends on smart-account, paymaster, session-keys)
├── src/
│   ├── lib.rs          — BenchmarkResult / BenchmarkReport types + table printer
│   └── main.rs         — benchmark harness + budget thresholds + CI assertions
├── viewer/
│   ├── package.json
│   ├── server.js       — Express server (serves HTML + /api/results)
│   └── index.html      — interactive dashboard
└── README.md           — this file
```
