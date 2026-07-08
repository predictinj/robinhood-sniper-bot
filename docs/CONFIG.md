# Configuration reference

All configuration comes from environment variables (`.env`, loaded via dotenv). `npm run bot -- config-check` validates everything and explains what is missing for live trading.

## Chain

| Variable | Default | Description |
| --- | --- | --- |
| `ROBINHOOD_RPC_URL` | mode-dependent official RPC | HTTP JSON-RPC endpoint. Defaults to the official mainnet RPC (`https://rpc.mainnet.chain.robinhood.com/`) or testnet RPC (`https://rpc.testnet.chain.robinhood.com`) depending on `MODE`/`CHAIN_ID`. |
| `ROBINHOOD_WS_URL` | *(empty)* | Optional WebSocket endpoint for event subscriptions. Without it the bot polls over HTTP (perfectly fine, slightly slower). |
| `CHAIN_ID` | `4663` (`46630` when `MODE=testnet`) | Cross-checked against the RPC at startup. `MODE=testnet` with the mainnet id (or vice versa) is rejected. |

## Wallet

| Variable | Default | Description |
| --- | --- | --- |
| `PRIVATE_KEY` | *(empty)* | 0x-prefixed 32-byte hex key. Only needed for testnet/live. Never logged, never stored in the DB. Use a dedicated wallet. |
| `WALLET_ADDRESS` | *(empty)* | Optional safety cross-check: if set, must match the address derived from `PRIVATE_KEY`. |

## Mode

| Variable | Default | Description |
| --- | --- | --- |
| `MODE` | `paper` | `paper` (simulated fills, no chain writes), `testnet` (real txs on testnet), `live` (real funds; heavily gated). |
| `ENABLE_LIVE_TRADING` | `false` | Master switch. Even `MODE=live` sends nothing while this is false. |

## DEX

| Variable | Default | Description |
| --- | --- | --- |
| `DEX_TYPE` | `mock` | `uniswap_v2`, `uniswap_v3` or `mock`. |
| `DEX_FACTORY_ADDRESS` | *(empty)* | Pool/pair factory to watch for creations. **Paste the real Robinhood Chain DEX factory here.** |
| `DEX_ROUTER_ADDRESS` | *(empty)* | Swap router. **Paste the real router here.** |
| `DEX_QUOTER_ADDRESS` | *(empty)* | QuoterV2 — required for `uniswap_v3` only. |
| `BASE_TOKEN_ADDRESS` | *(empty)* | The token you trade against (WETH/USDG/...). Pools not quoted in this token are ignored. |
| `BASE_TOKEN_IS_NATIVE_WRAPPER` | `true` | `true` → v2 buys pay native ETH (`swapExactETHForTokens`); `false` → ERC20↔ERC20 (needs base balance + approval). |

If a real `DEX_TYPE` is selected but addresses are missing, the bot **falls back to monitor/simulation mode with the mock adapter** and logs exactly which variables to set. Live trading is structurally impossible in that state.

## Risk limits (enforced before every trade)

| Variable | Default | Description |
| --- | --- | --- |
| `MAX_BUY_ETH` | `0.01` | Size of each auto-buy and hard cap on any manual buy. |
| `MAX_SLIPPAGE_BPS` | `300` | Slippage tolerance in basis points; sets the swap's `minAmountOut`. |
| `MAX_GAS_GWEI` | `5` | Refuse to send any tx when the network max fee exceeds this. |
| `MIN_LIQUIDITY_ETH` | `1` | Pools with less base-token liquidity fail safety checks. |
| `MAX_TOKEN_TAX_BPS` | `1000` | Combined estimated buy+sell tax above this is a critical failure. |
| `TAKE_PROFIT_PERCENT` | `50` | Auto-sell when unrealized PnL ≥ this. |
| `STOP_LOSS_PERCENT` | `20` | Auto-sell when unrealized PnL ≤ −this. Must be in (0, 100). |
| `TRAILING_STOP_PERCENT` | *(off)* | Optional: exit when price drops this % from its post-entry high (only while in profit). |
| `MAX_OPEN_POSITIONS` | `3` | Hard cap on concurrently open positions. Worst-case exposure = `MAX_BUY_ETH × MAX_OPEN_POSITIONS`. |
| `COOLDOWN_SECONDS` | `60` | Minimum time between buys. |

## Misc

| Variable | Default | Description |
| --- | --- | --- |
| `DB_PATH` | `./data/bot.db` | SQLite file. Delete it to reset paper balance/positions/history. |
| `LOG_LEVEL` | `info` | `debug` shows block heartbeats and per-check safety details. |
| `PAPER_BALANCE_ETH` | `10` | Starting simulated balance (first run only; stored in the DB afterwards). |
| `POSITION_POLL_MS` | `5000` | How often open positions are re-priced for TP/SL. |

## Live-trading gate (all must hold)

1. `MODE=live`
2. `ENABLE_LIVE_TRADING=true`
3. `PRIVATE_KEY` present and valid
4. Real DEX adapter fully configured (no `mock`)
5. Risk limits valid
6. `bot confirm-live` completed (typed confirmation, stored in the settings table)
7. No emergency stop active

`liveTradingBlockers()` in `src/config/index.ts` is the single source of truth; `bot status` and `bot config-check` print the current blockers.
