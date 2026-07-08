# ⚠️ LIVE TRADING WARNING

Read all of this before running `bot confirm-live`.

## What you are enabling

With live trading armed, this bot **spends real ETH on Robinhood Chain mainnet automatically, without asking you per trade**, whenever a newly created pool passes its safety checks and risk limits.

## The risks are severe

- **Most newly launched tokens go to zero.** Sniping new pools is one of the highest-risk activities in crypto.
- **Safety checks are best-effort.** They catch obvious honeypots, missing liquidity, visible taxes and some owner-privilege patterns — from public data only. They cannot detect a rug that hasn't happened yet, proxy upgrades, delayed blacklists, or liquidity pulls. A passing report is *not* a safe token.
- **Stop-losses are not guarantees.** If a token becomes unsellable after you buy, the stop-loss cannot execute. The position manager will flag it, but the money may already be gone.
- **Slippage and MEV**: your buys move thin pools; you may fill far worse than quoted (bounded by `MAX_SLIPPAGE_BPS`, but that bound is your choice).
- **Software risk**: bugs, RPC failures, chain reorgs and gas spikes all exist. The bot is careful (simulation-first, gas caps, receipts) but not infallible.

## Non-negotiable ground rules

1. **Testnet first.** Run `MODE=testnet` against Robinhood Chain testnet (chain id 46630) until you've watched full buy→TP/SL→sell cycles succeed.
2. **Dedicated wallet.** Create a fresh wallet for the bot. Fund it *only* with what you are fully prepared to lose. Never reuse a wallet holding other assets — approvals and key exposure are wallet-wide.
3. **Small caps.** Start with dust-level `MAX_BUY_ETH` and `MAX_OPEN_POSITIONS=1`. Worst-case exposure is `MAX_BUY_ETH × MAX_OPEN_POSITIONS` plus gas.
4. **Verify DEX addresses.** A wrong or malicious router address in `.env` can steal funds via approvals. Cross-check factory/router/quoter against the DEX's official docs and the block explorer.
5. **Know the kill switch.** `npm run bot -- emergency-stop` halts all trading instantly and revokes live confirmation. Practice it once before going live.
6. **Watch it.** Don't leave a freshly armed bot unattended. Check `bot status`, `bot positions`, and the `errors` table.

## The arming checklist (enforced by code)

Every one of these must hold or the engine throws `TradeBlockedError` and sends nothing:

- [ ] `MODE=live` and chain id 4663 verified against the RPC
- [ ] `ENABLE_LIVE_TRADING=true`
- [ ] Valid `PRIVATE_KEY` (and `WALLET_ADDRESS` cross-check if set)
- [ ] Real DEX adapter with factory + router (+ quoter for v3) + base token configured
- [ ] Risk limits sane (`MAX_BUY_ETH`, `MAX_SLIPPAGE_BPS`, `MAX_GAS_GWEI`, `STOP_LOSS_PERCENT`, `MAX_OPEN_POSITIONS`)
- [ ] `bot confirm-live` completed — you typed `I UNDERSTAND THE RISKS`
- [ ] No emergency stop active

Disarm at any time: `bot emergency-stop`, or set `ENABLE_LIVE_TRADING=false`, or switch `MODE`.

## Legal & fair-market note

This tool trades on public markets using public data and ordinary transactions. It does not and must not front-run, sandwich, spoof, wash-trade or otherwise manipulate other users. You are responsible for compliance with the laws and platform terms that apply to you.
