# Robinhood Sniper Bot

A token monitor and trading automation bot for **Robinhood Chain** (EVM). It watches configured DEX factories for newly created liquidity pools, runs a battery of safety checks on each new token, and can simulate or execute buys/sells under strict, user-defined risk limits.

> ⚠️ **This is a high-risk tool.** Automated trading of newly created tokens can lose 100% of allocated funds — most new tokens go to zero, and safety checks reduce but never eliminate scam risk. The bot is built **testnet-first**: live trading is disabled by default behind multiple independent switches. Read [docs/LIVE_TRADING_WARNING.md](docs/LIVE_TRADING_WARNING.md) before even thinking about live mode.
>
> The bot only uses public RPC/WebSocket data and normal swap transactions. It contains no front-running, sandwiching, or mempool-manipulation logic, and nothing of the sort should be added.

## What's inside

- **Scanner** — watches new blocks + `PairCreated`/`PoolCreated` factory events, stores pools in SQLite, dedupes, auto-reconnects after RPC/WS failures.
- **Safety pipeline** — ERC20 metadata, contract-code existence, liquidity floor, sell-quote honeypot probe, tax estimate (best-effort), owner/renounce detection, max-tx/max-wallet probes. Tokens that fail *any critical check* are flagged and never bought.
- **Trading engine** — one code path for paper / testnet / live. Quotes → slippage-protected `minOut` → gas cap check → dry-run simulation → send. Exact (never unlimited) approvals.
- **Position manager** — take-profit, stop-loss, optional trailing stop; re-prices open positions on an interval.
- **Adapter-based DEX support** — generic Uniswap v2-style and v3-style adapters plus a mock adapter. Router/factory addresses come from `.env`, never hardcoded.
- **CLI** — status, scan, watch, paper, buy, sell, positions, trades, safety-check, config-check, confirm-live, emergency-stop, backtest.
- **SQLite persistence** — tokens, pools, safety_checks, trades, positions, settings, events, errors.

## Install

```bash
git clone https://github.com/predictinj/robinhood-sniper-bot.git
cd robinhood-sniper-bot
npm install
cp .env.example .env
npm test          # should be green out of the box
```

Requires Node.js ≥ 20.

## 1. Run paper mode immediately (no chain, no keys)

The default `.env.example` uses `MODE=paper` + `DEX_TYPE=mock`, so this works with zero configuration:

```bash
npm run paper
```

You'll see synthetic pools being discovered, safety checks flagging the intentionally-bad ones (honeypots, high-tax, thin liquidity), paper buys of the good ones, and take-profit/stop-loss exits as prices move. Inspect the results:

```bash
npm run bot -- status
npm run bot -- positions --all
npm run bot -- trades
npm run bot -- backtest        # replay stored price events with different TP/SL
```

## 2. Configure Robinhood Chain

| Network | Chain ID | RPC |
| --- | --- | --- |
| Mainnet | `4663` | `https://rpc.mainnet.chain.robinhood.com/` |
| Testnet | `46630` | `https://rpc.testnet.chain.robinhood.com` |

In `.env`:

```ini
ROBINHOOD_RPC_URL=https://rpc.testnet.chain.robinhood.com
CHAIN_ID=46630
MODE=testnet
```

Then verify: `npm run bot -- config-check` — it checks env validity, RPC reachability, and that the RPC's chain id matches `CHAIN_ID`.

## 3. Add DEX addresses

Robinhood Chain's DEX landscape is young and may change, so **no DEX addresses are hardcoded**.

**Don't know the addresses?** Discover them from live on-chain data:

```bash
npm run discover -- --rpc https://rpc.mainnet.chain.robinhood.com/ --blocks 6000
```

This scans recent blocks for Uniswap-style pool-creation events, and prints the factory (the contract emitting them), the base token (the one in most pairs), and a router candidate (most common Swap caller). See [docs/ROBINHOOD_CHAIN.md](docs/ROBINHOOD_CHAIN.md#finding-the-dex-addresses-automatically) — as of 2026-07-08 the active mainnet venue is a Uniswap-v3-style DEX with a WETH base token. **Always verify the router/quoter on the explorer before trading.**

When you know which DEX you want to trade on, paste its contracts into `.env`:

```ini
DEX_TYPE=uniswap_v2            # or uniswap_v3
DEX_FACTORY_ADDRESS=0x...      # <-- paste the DEX factory here
DEX_ROUTER_ADDRESS=0x...       # <-- paste the DEX router here
DEX_QUOTER_ADDRESS=0x...       # v3 only: QuoterV2
BASE_TOKEN_ADDRESS=0x...       # <-- paste WETH (or USDG etc.) here
BASE_TOKEN_IS_NATIVE_WRAPPER=true
```

Until these are set, the bot **runs in monitor/simulation mode** with the mock adapter and says so at startup — live trading is impossible. See [docs/DEX_ADAPTERS.md](docs/DEX_ADAPTERS.md) for how the adapters work and how to add a new DEX style.

## 4. Test on testnet

```bash
MODE=testnet, CHAIN_ID=46630, PRIVATE_KEY=0x...   # a throwaway testnet key!
npm run testnet
```

Testnet sends real transactions on the test network — it exercises approvals, gas estimation, simulation and swap execution end-to-end with worthless funds.

## 5. Enable live trading (only after testing)

Live trading requires **all** of the following, independently:

1. `MODE=live` and `CHAIN_ID=4663`
2. `ENABLE_LIVE_TRADING=true`
3. `PRIVATE_KEY` set (use a dedicated wallet funded only with what you can lose)
4. Real DEX adapter configured (factory + router + base token; quoter for v3)
5. All risk limits valid (`MAX_BUY_ETH`, `MAX_SLIPPAGE_BPS`, `MAX_GAS_GWEI`, `STOP_LOSS_PERCENT`, …)
6. The interactive ceremony: `npm run bot -- confirm-live` (you must type `I UNDERSTAND THE RISKS`)

Then `npm run live`. **`npm run bot -- emergency-stop` halts all trading instantly** (and revokes the live confirmation). See [docs/LIVE_TRADING_WARNING.md](docs/LIVE_TRADING_WARNING.md).

## CLI reference

```bash
npm run bot -- status                        # mode, balances, positions, live readiness
npm run bot -- config-check                  # validate .env + RPC + chain id
npm run bot -- scan [--blocks 2000]          # one-shot historical pool scan
npm run bot -- watch                         # monitor-only: discover + safety-check, never trade
npm run bot -- paper                         # full pipeline, simulated fills
npm run bot -- buy --token 0x... --amount 0.01
npm run bot -- sell --token 0x... --percent 100
npm run bot -- positions [--all]
npm run bot -- trades [--limit 25]
npm run bot -- safety-check --token 0x...
npm run bot -- confirm-live                  # interactive live-arming ceremony
npm run bot -- emergency-stop                # ⛔ kill switch
npm run bot -- resume                        # clear emergency stop
npm run bot -- backtest [--take-profit 80 --stop-loss 15 --trailing 10]
```

`npm run start` runs the long-lived scanner + auto-trade pipeline in whatever `MODE` your `.env` sets; `npm run scan` / `npm run paper` / `npm run testnet` / `npm run live` are shortcuts.

## Docker

```bash
docker build -t robinhood-sniper-bot .
docker run --env-file .env -v "$PWD/data:/app/data" robinhood-sniper-bot
```

The SQLite database lives in `/app/data` — mount it to persist state across restarts.

## Common errors

| Symptom | Cause / fix |
| --- | --- |
| `Invalid configuration: …` at startup | A `.env` value failed validation — the message names the exact variable. |
| `RPC reports chain id X, expected Y` | RPC URL and `CHAIN_ID` disagree. Fix one of them. |
| `cannot reach RPC` | Endpoint down/typo/firewall. Try the other official endpoint. |
| `trade blocked: … MAX_BUY_ETH` etc. | Working as intended — a risk limit refused the trade. |
| `simulation reverted — not sending` | The swap would fail on-chain (honeypot, no liquidity, bad path). No gas was spent. |
| `network max fee … exceeds MAX_GAS_GWEI` | Gas spike protection. Raise the cap only if you mean it. |
| `SELL QUOTE REVERTED — possible honeypot` | The safety layer caught an unsellable token. Do not override. |
| `paper balance too low` | Paper wallet spent; reset by deleting `data/bot.db` or lowering buy size. |
| Scanner logs `stream error — will resubscribe` | Normal RPC/WS hiccup; it reconnects with backoff automatically. |

## Testing

```bash
npm test            # vitest: config, db, safety, paper, TP/SL, adapters, engine gating, scanner
npm run typecheck   # tsc --noEmit
npm run build       # compile to dist/
```

## Security model (summary)

- Private key only ever lives in `.env` / process env; it is never logged (pino redaction as backstop) and never written to SQLite.
- Live trading is off by default and requires five independent switches plus an interactive confirmation.
- Exact-amount ERC20 approvals only — never unlimited.
- Every transaction is simulated (`eth_call`) before it is sent; gas is capped by `MAX_GAS_GWEI`; spending is capped by `MAX_BUY_ETH` × `MAX_OPEN_POSITIONS`.
- `bot emergency-stop` blocks all trading (even paper) immediately and revokes live confirmation.

Details: [docs/SAFETY.md](docs/SAFETY.md) · [docs/CONFIG.md](docs/CONFIG.md) · [docs/ROBINHOOD_CHAIN.md](docs/ROBINHOOD_CHAIN.md)

## License

MIT
