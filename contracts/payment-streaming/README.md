# Payment Streaming Contract

> **Issue #228** — Automated Batch Settlement and Micro-Payment Streaming Contract

A Stellar Soroban smart contract for continuous micro-payment streaming (salary, subscriptions, API pay-per-call).

## How It Works

```
claimable = (now − start_time) × rate_per_second
```

A **sender** deposits tokens upfront; the contract linearly releases them to the **recipient** over time. Neither party needs to be online — the recipient can claim at any time and only receives what has accrued.

## Contract Interface

| Function | Caller | Description |
|---|---|---|
| `create_stream(sender, recipient, token, deposit, rate_per_second)` | Sender | Create a new stream. Returns stream ID. |
| `withdraw(id, recipient)` | Recipient | Withdraw all currently accrued tokens. |
| `top_up(id, sender, amount)` | Sender | Add more tokens to the stream deposit. |
| `pause(id, sender)` | Sender | Freeze accrual (no tokens earned while paused). |
| `resume(id, sender)` | Sender | Resume accrual from current timestamp. |
| `cancel(id, sender)` | Sender | End stream: pays accrued to recipient, refunds remainder to sender immediately. |
| `get_stream(id)` | Anyone | Read stream state. |
| `claimable(id)` | Anyone | Preview current claimable amount without mutating state. |

## Stream States

```
Active ──pause──► Paused ──resume──► Active
  │                  │
  └──cancel──────────┘
       │
       ▼
  Cancelled
  
Active ──(deposit exhausted after withdraw)──► Completed
```

## Build

```bash
# Tests
cargo test -p payment-streaming

# WASM binary (release)
cargo build -p payment-streaming --target wasm32-unknown-unknown --release
```

## Web Viewer

A live browser dashboard to interact with the contract simulator:

```bash
cd viewer
npm install
node server.js
# Open http://localhost:3420
```

The viewer simulates the exact contract logic and updates claimable amounts in real-time.

## Acceptance Criteria

- ✅ **Continuous flow rate**: `claimable = (now - start) * rate_per_second`
- ✅ **Progressive withdrawal**: recipient can withdraw accrued funds at any time
- ✅ **Top-up**: sender can add more deposit to an active or paused stream
- ✅ **Pause/Resume**: sender can freeze and restart accrual
- ✅ **Cancel with immediate refund**: unstreamed deposit returned to sender on cancel
- ✅ **27 unit tests** covering all operations and edge cases
