# Robinhood Chain notes

Robinhood Chain is an EVM-compatible network, so standard Ethereum tooling (viem, ethers, foundry, MetaMask custom networks) works unchanged.

## Network parameters

| | Mainnet | Testnet |
| --- | --- | --- |
| Chain ID | `4663` | `46630` |
| RPC | `https://rpc.mainnet.chain.robinhood.com/` | `https://rpc.testnet.chain.robinhood.com` |
| Native gas token | ETH | ETH (testnet) |

These are also the defaults baked into `src/chain/chains.ts`; `ROBINHOOD_RPC_URL` / `CHAIN_ID` in `.env` override them (useful if you run your own node or a third-party RPC).

## Startup verification

`bot config-check` (and every non-paper startup) calls `eth_chainId` and refuses to proceed if the RPC's chain id doesn't match `CHAIN_ID`. This prevents the classic footgun of firing mainnet transactions at the wrong network or vice versa.

## WebSocket vs HTTP

If Robinhood Chain exposes a WebSocket endpoint, set `ROBINHOOD_WS_URL` — factory-event subscriptions become push-based. Without it, viem's `watchContractEvent` polls `eth_getLogs` over HTTP every ~4s, which is entirely adequate and more robust against flaky WS connections. The scanner auto-reconnects with exponential backoff in both cases.

## DEX infrastructure caveat

Robinhood Chain launched recently and its DEX landscape (which AMMs deploy there, at which addresses) may still be settling. That is why:

- **No factory/router addresses are hardcoded anywhere in this repo.** They live in `.env` (`DEX_FACTORY_ADDRESS`, `DEX_ROUTER_ADDRESS`, `DEX_QUOTER_ADDRESS`).
- The adapters are *generic*: any Uniswap-v2-compatible or Uniswap-v3-compatible deployment works by pasting its addresses.
- Until addresses are configured, the bot runs in monitor/simulation mode and says so.

When you pick a DEX, verify its contracts yourself (block explorer, official docs/announcements) before pasting the addresses — a malicious "router" can steal approvals.

## Finding the DEX addresses automatically

You don't have to guess. `npm run discover` scans recent blocks for the standard
Uniswap-style pool-creation events *by their event signature* (not by address),
groups the hits by the emitting contract (that's the factory), finds the token
present in the most pairs (the base/quote token), and tallies the most common
Swap caller on those pools (a router candidate):

```bash
npm run discover -- --rpc https://rpc.mainnet.chain.robinhood.com/ --blocks 6000 --chunk 500
npm run discover -- --rpc https://rpc.testnet.chain.robinhood.com  --blocks 6000 --chunk 500
```

### Example output (Robinhood Chain mainnet, observed 2026-07-08 — VERIFY before use)

A Uniswap-v3-style DEX is clearly the active venue on mainnet:

| Field | Discovered value | Confidence |
| --- | --- | --- |
| `DEX_TYPE` | `uniswap_v3` | high (≈90 pools created per few-thousand blocks) |
| `DEX_FACTORY_ADDRESS` | `0x1f7d7550b1b028f7571e69a784071f0205fd2efa` | high (emitted every `PoolCreated`) |
| `BASE_TOKEN_ADDRESS` | `0x0bd7d308f8e1639fab988df18a8011f41eacad73` (WETH, 18 dec) | high (in ~every pair) |
| `DEX_ROUTER_ADDRESS` | router candidate from Swap `sender` | **LOW — must verify on explorer** |
| `DEX_QUOTER_ADDRESS` | (QuoterV2) not discoverable from events | from DEX docs/explorer |

> ⚠️ These are **empirical observations from public logs**, not official addresses,
> and they can change. The factory and WETH base token are strongly evidenced;
> the **router and quoter you must confirm from the DEX's own docs / a verified
> contract on the explorer** before trading — a wrong or hostile router address
> can drain token approvals. Never paste a router you haven't verified.

## Gas

The chain uses ETH for gas. `MAX_GAS_GWEI` caps what the bot will ever pay; fee estimation uses EIP-1559 fields when the RPC supports them and falls back to legacy `eth_gasPrice` otherwise.
