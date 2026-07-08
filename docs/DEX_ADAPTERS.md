# DEX adapters

All DEX-specific logic is behind one interface — `DexAdapter` in `src/dex/adapter.ts` — so supporting a new DEX never touches the scanner, safety, or trading code.

## The interface

```ts
interface DexAdapter {
  name: string;
  scanNewPools(fromBlock, toBlock): Promise<PoolInfo[]>;      // historical
  watchNewPools(onPool, onError): () => void;                 // subscription; returns unsubscribe
  getPoolLiquidityBase(pool): Promise<bigint>;                // base-token depth, wei
  quoteBuy(token, amountInBase): Promise<bigint>;             // expected tokens out
  quoteSell(token, amountTokens): Promise<bigint>;            // expected base out
  buildBuyTx(params): Promise<TxRequest>;                     // build, never send
  buildSellTx(params): Promise<TxRequest>;
  spender(): Address | null;                                  // approval target (router)
  estimateTaxesBps?(token): Promise<{buyBps, sellBps} | null>; // optional, null = unknown
  getTokenMeta?(token): Promise<TokenMeta | null>;             // optional (mock only)
}
```

Conventions: "base" amounts are wei of `BASE_TOKEN_ADDRESS`; "token" amounts are raw units. Adapters *build* transactions — only the trading engine simulates, gas-checks and sends them.

## Built-in adapters

### `uniswap_v2` (`src/dex/uniswapV2.ts`)
- Watches the factory's `PairCreated` event; ignores pairs not involving the base token.
- Quotes via `router.getAmountsOut`.
- Buys: `swapExactETHForTokens` when `BASE_TOKEN_IS_NATIVE_WRAPPER=true`, else `swapExactTokensForTokens`.
- Sells: the `SupportingFeeOnTransferTokens` variants, so taxed tokens still exit cleanly.
- Liquidity: base-token side of `pair.getReserves()`.

### `uniswap_v3` (`src/dex/uniswapV3.ts`)
- Watches `PoolCreated`; remembers each token's fee tier for later quotes/swaps.
- Quotes via QuoterV2 `quoteExactInputSingle` (needs `DEX_QUOTER_ADDRESS`).
- Swaps via `exactInputSingle`. Note: v3 trades are ERC20↔ERC20 — with a WETH-style base you must hold wrapped balance.
- Liquidity: approximated as the pool's base-token balance (v3 has no flat reserves).

### `mock` (`src/dex/mock.ts`)
- Zero chain access. Emits deterministic synthetic pools (seeded PRNG); ~30% are intentionally bad — honeypots, 20–70% taxes, dust liquidity — so the safety layer has real work to do in demos and tests.
- Prices random-walk each tick so TP/SL logic triggers naturally in paper mode.
- `buildBuyTx`/`buildSellTx` **throw**: the mock can never produce a sendable transaction, which structurally prevents live trading against fake data. `liveTradingBlockers` also rejects `DEX_TYPE=mock` explicitly.

## Adding a new DEX style

1. Create `src/dex/myDex.ts` implementing `DexAdapter` (copy `uniswapV2.ts` as a template; put its ABIs in `src/dex/abis.ts`).
2. Add a variant to `DexType` in `src/types/index.ts` and to the `DEX_TYPE` enum in `src/config/index.ts`.
3. Wire it into `createAdapter()` and `dexFullyConfigured()` in `src/dex/index.ts`, validating whatever addresses it needs.
4. If it needs extra addresses, add env vars to `.env.example` + the config schema.
5. Add tests (see `tests/adapter.test.ts` for the contract every adapter should satisfy).

Keep the adapter honest: if it can't know something (taxes, liquidity), return `null`/throw rather than guessing — the safety layer treats unknown as a warning, and a wrong "all clear" is worse than no answer.
