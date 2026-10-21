# Lumen

[![CI](https://github.com/utilityjnr1/lumena/actions/workflows/ci.yml/badge.svg)](https://github.com/utilityjnr1/lumena/actions/workflows/ci.yml)
[![Security](https://github.com/utilityjnr1/lumena/actions/workflows/security.yml/badge.svg)](https://github.com/utilityjnr1/lumena/actions/workflows/security.yml)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Network](https://img.shields.io/badge/network-Stellar-orange.svg)](https://stellar.org)
[![Runtime](https://img.shields.io/badge/runtime-TypeScript%20%2B%20Node-blue.svg)](https://nodejs.org)

> **Seedless, gasless Stellar wallets — the user never holds a key or pays a fee.**

Lumen is a wallet SDK for building non-custodial Stellar wallets where the user never manages secret keys and never pays transaction fees. The server sponsors all accounts and fees, co-signs every transaction after a policy check, and enforces configurable rules (spend limits, velocity, allowlists) — all without holding user funds.

---

## Table of Contents

1. [Features](#features)
2. [How It Works](#how-it-works)
3. [Architecture](#architecture)
4. [Why Lumen Is Different](#why-lumen-is-different)
5. [Quickstart](#quickstart)
6. [Packages](#packages)
7. [Environment](#environment)
8. [SEP-10 Authentication](#sep-10-authentication)
9. [Guides](#guides)
10. [Security](#security)
11. [License](#license)

---

## Features

| Feature | Description |
| --- | --- |
| **Seedless onboarding** | Users create a wallet in seconds — no seed phrase, no key management. |
| **Gasless UX** | The server fee-bumps every transaction so users never hold XLM for fees. |
| **2-of-2 multisig** | Every wallet is a 2-of-2 account: the user signs with their device key, the server co-signs after policy. |
| **Policy-controlled** | Spend limits, velocity rules, and destination allowlists enforced on-chain before co-signing. |
| **Sponsorship** | The server pays XLM reserves for account creation and transaction fees. |
| **Hardware-backed signing** | `Signer` abstraction supports AWS KMS, CloudHSM, and HashiCorp Vault for production. |
| **SEP-10 auth** | Authenticate by proving ownership of a Stellar keypair — no passwords. |

---

## How It Works

```
User creates a wallet
  → Server sponsors the account (pays XLM reserve)
  → Server sets up 2-of-2 multisig
  → User signs with their device key
  → Server co-signs after a policy check
  → Transaction is fee-bumped so the user never holds XLM
```

| Layer | Backed by | What it is |
| --- | --- | --- |
| Identity | Stellar | 2-of-2 multisig account with co-signer |
| Fees | Stellar (fee-bumps) | Server wraps all txs; user pays zero gas |
| Policy | `@lumen/server` | Spend limits, velocity, allowlists enforced before co-signing |
| Key management | `@lumen/core` | Keypair generation, storage, derivation (OAuth, passphrase) |
| SDK | `@lumen/web-sdk` | Browser client: `createWallet`, `getBalance`, `sendPayment` |
| API | Express | `/cosign`, `/fee-bump`, `/wallet/create`, `/policy`, `/auth` |

---

## Why Lumen Is Different

Most wallet SDKs require users to manage seed phrases and hold tokens for gas. Lumen makes both invisible.

| | Traditional Wallet | Lumen |
| --- | --- | --- |
| Onboarding | User must back up seed phrase | Seedless — server manages keys |
| Gas | User holds XLM for fees | Gasless — server fee-bumps all txs |
| Security | Single key controls funds | 2-of-2 multisig — server co-signs |
| Policy | None or off-chain | On-chain spend limits, velocity, allowlists |
| Control | Who holds the seed | Who holds the co-signer key |

---

## Quickstart

> **Prereqs:** Node.js 20+, pnpm, Docker (for the local Stellar network).

### 1. Bootstrap the environment

Run the setup script to initialize your `.env` configuration file from `.env.example` and install all monorepo dependencies:

```bash
pnpm setup
# or: pnpm run setup
```

Follow the terminal prompts to edit `.env` with your network and key configuration (e.g. `FEE_PAYER_SECRET`, `COSIGNER_SECRET`).

### 2. Start the local Stellar network

```bash
docker compose -f docker/docker-compose.yml up -d
```

### 3. Build and test

```bash
pnpm build
pnpm test
```

### 4. Start the server

```bash
pnpm --filter @lumen/server dev
```

---

## Packages

| Package | Description |
| --- | --- |
| **`@lumen/core`** | `StellarClient`, `createSponsoredAccount`, `setupMultisig`, `buildTransaction`, `buildFeeBump`, `pathPayment`, `KeyManager` (with `delete`), `Wallet` |
| **`@lumen/server`** | `CosignerService`, `FeeSponsorService`, `PolicyEngine`, Express API |
| **`@lumen/web-sdk`** | `LumenClient`: `createWallet`, `getBalance`, `sendPayment` |
| **`@lumen/types`** | Shared TypeScript interfaces |

---

## SEP-10 Authentication

Lumen supports [SEP-10](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0010.md) Web Authentication, letting clients authenticate by proving ownership of a Stellar keypair instead of using a password. The server exposes the following endpoints:

| Method | Route | Description |
| --- | --- | --- |
| `GET` | `/.well-known/stellar.toml` | Serves the server's Stellar TOML file, including `WEB_AUTH_ENDPOINT` and `SIGNING_KEY`. |
| `GET` | `/auth` | Issues a SEP-10 challenge transaction for the requested account. |
| `POST` | `/auth` | Verifies the signed challenge transaction and returns a JWT. |

### Flow

1. **Discover** — The client fetches `GET /.well-known/stellar.toml` to learn the `WEB_AUTH_ENDPOINT` and the server's `SIGNING_KEY`.
2. **Challenge** — The client calls `GET /auth?account=G...` and receives a base64-encoded challenge transaction, signed by the server's signing key, with the client's account as the source.
3. **Sign** — The client signs the challenge transaction with the secret key for the requested account.
4. **Verify** — The client submits the signed transaction to `POST /auth` (as `application/x-www-form-urlencoded` with a `transaction` field). The server verifies the signatures and challenge, then returns a JWT.
5. **Authenticate** — The client includes the JWT in the `Authorization: Bearer <token>` header on subsequent requests.

### Example

```bash
# 1. Fetch the challenge
curl "http://localhost:3000/auth?account=GABC...XYZ"

# 2. Sign the returned transaction with the account's secret key, then submit it
curl -X POST http://localhost:3000/auth \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "transaction=<base64-signed-challenge-xdr>"

# 3. Use the returned JWT
curl http://localhost:3000/wallet/create \
  -H "Authorization: Bearer <jwt>"
```

---

## Server Security & Configuration

### API Key Middleware
To safeguard server endpoints in non-localhost deployments, configure `apiKey` in `ServerOpts` or supply `API_KEY` in your environment:
- Protects all endpoints (`/cosign`, `/fee-bump`, `/policy`, etc.) by enforcing an `Authorization: Bearer <api-key>` header.
- Returns `401 Unauthorized` (`{ "error": "Unauthorized" }`) if the key is missing or invalid.
- `/health` and `/metrics` are exempt to permit uptime probes and metric scraping.

### Rate Limiting
Endpoint protection against spam and denial-of-service on `/cosign` and `/fee-bump` using `express-rate-limit`:
- Configurable via `windowMs` and `max` in `ServerOpts` (or `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX` environment variables).
- Exceeding the rate limit returns `429 Too Many Requests` (`{ "error": "Too Many Requests" }`).

---

## Contributing & Open Issues

We welcome open-source contributions! Check out our [Open Issues Directory](ISSUES.md) or browse our active [GitHub Issues](https://github.com/utilityjnr1/lumena/issues) to find tasks available to work on:

- 🚀 **Good First Issues**: Beginner-friendly tasks for new contributors.
- 🛡️ **Security & Policy Engine**: Enhancements for multi-op validation, timebounds, and asset limits.
- ⚡ **Soroban Integration**: Smart contract invocation and SEP-41 token support.
- 📦 **SDKs & DX**: React hooks package (`@lumen/react`), CLI (`@lumen/cli`), and playground app.

See [ISSUES.md](ISSUES.md) for full details on how to fork the repo and submit pull requests.

---

## Guides

Step-by-step guides for common integration patterns:

| Guide | Description |
| --- | --- |
| [Gasless Transactions](docs/guides/gasless-transactions.md) | End-to-end walkthrough of Stellar Fee-Bump (CAP-0015) and how Lumen abstracts gas fees — with code examples for `@lumen/web-sdk`, `@lumen/react`, and the raw REST API. |

---

## Security

Automated security analysis runs on every push and pull request via GitHub Actions:

- **CodeQL** static analysis for JavaScript/TypeScript (security-extended query suite).
- **`pnpm audit`** dependency vulnerability scanning (fails on high/critical severity).
- **Weekly scheduled scan** to catch newly-published advisories.

See [docs/SECURITY.md](docs/SECURITY.md) for the full security policy, vulnerability reporting instructions, and security best practices for production deployments.

---

## License

MIT

## Handsoff notes

<!-- handsoff-issue-357 -->
- #357: [Feature] server: DELETE /policy/:walletId is not wrapped in wrapHandler, so thrown errors bypass the global error handler

<!-- handsoff-issue-358 -->
- #358: [Feature] token-sep41: zero-amount transfers succeed silently instead of being rejected
