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

## Gas

The chain uses ETH for gas. `MAX_GAS_GWEI` caps what the bot will ever pay; fee estimation uses EIP-1559 fields when the RPC supports them and falls back to legacy `eth_gasPrice` otherwise.
