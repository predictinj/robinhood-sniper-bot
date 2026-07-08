# Safety architecture

Two distinct layers: **token safety checks** (is this token safe enough to touch?) and **operational safety** (can the bot spend money, and how much?).

## Token safety pipeline (`src/safety/checks.ts`)

Runs before any buy — automatic or manual (`--skip-safety` exists for paper-mode experiments only). Every report is stored in the `safety_checks` table.

| # | Check | Severity | What it does |
| --- | --- | --- | --- |
| 1 | `base_token_pair` | critical | Pool must be quoted in the configured `BASE_TOKEN_ADDRESS`. |
| 2 | `contract_code` | critical | `eth_getCode` must return bytecode at the token address. |
| 3 | `erc20_metadata` | critical | `name`/`symbol`/`decimals`/`totalSupply` must read successfully; decimals in [0, 36]; supply > 0. Bad decimals are a classic malformed-token trap. |
| 4 | `min_liquidity` | critical | Base-token side of the pool must hold ≥ `MIN_LIQUIDITY_ETH`. |
| 5 | `buy_quote` / `sell_quote` | critical | Quote a small buy, then quote selling the proceeds. A revert on the sell side is the classic honeypot signature that public data can reveal. |
| 6 | `token_tax` | critical/warning | Best-effort tax estimate. Over `MAX_TOKEN_TAX_BPS` → critical fail. **Unknown → warning, never a silent pass** (see honesty note below). |
| 7 | `ownership` | info/warning | Probes `owner()`/`getOwner()`. Renounced (zero address) is noted; an active owner is a warning — they may retain mint/blacklist/tax powers. |
| 8 | `tx_wallet_limits` | warning | Probes common `_maxTxAmount`/`maxTransactionAmount`/`maxWalletAmount`/`_maxWalletSize` getters. |
| 9 | `trading_enabled` | critical | If the token exposes `tradingEnabled()` and it returns `false`, buying now would revert or trap funds. |

**Any critical failure ⇒ the token is flagged in the `tokens` table and never bought.** Warnings are stored and logged but don't block by themselves.

### Honesty limits — read this

These checks use only public RPC data. They **cannot** catch everything:

- A token can pass every check and rug later (owner adds a blacklist, pulls liquidity, upgrades a proxy…).
- Transfer taxes often don't show up in router quotes; without trace/state-override access the bot reports "tax not estimable" rather than pretending it's 0%.
- Sell-quote probes can be defeated by tokens that behave differently for quoters vs. real transfers.

Safety checks reduce obvious scams; they do not make new-token trading safe. Size positions accordingly.

## Operational safety

- **Mode ladder**: paper → testnet → live. Paper mode performs zero chain writes; the mock adapter *cannot* build a real transaction (it throws).
- **Live gate**: seven independent conditions (see docs/CONFIG.md), combined in one function (`liveTradingBlockers`). The confirmation ceremony (`bot confirm-live`) requires typing `I UNDERSTAND THE RISKS` and is revoked by every emergency stop.
- **Emergency stop**: `bot emergency-stop` sets a DB flag checked before *every* trade in *every* mode. Effective immediately, even for an already-running bot process.
- **Spending caps**: per-trade `MAX_BUY_ETH`, portfolio-wide `MAX_OPEN_POSITIONS`, rate-limit `COOLDOWN_SECONDS`.
- **Dry-run first**: every real tx is simulated via `eth_call` before sending; reverts cost nothing. Gas estimation failure aborts. Fees are capped by `MAX_GAS_GWEI`.
- **Slippage protection**: `minAmountOut` computed from the quote and `MAX_SLIPPAGE_BPS` on every swap.
- **Exact approvals**: approvals are for the exact sell/buy amount, never `type(uint256).max`.
- **Sell resilience**: sells use the fee-on-transfer-tolerant router variants; a failed auto-sell is retried on the next position tick and recorded in `errors`.
- **Key hygiene**: the private key never leaves process memory; pino redaction censors any accidental log of a `privateKey`-shaped field; the DB stores no key material; `.gitignore` excludes `.env`.

## What this bot deliberately does NOT do

No sandwich attacks, no front-running of other users' transactions, no private-mempool tricks, no spam/wash trading, no fake volume, no exploit logic. It reads public events, applies user-configured rules, and submits ordinary swap transactions. Keep it that way.
