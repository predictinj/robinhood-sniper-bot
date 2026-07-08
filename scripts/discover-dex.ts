/**
 * Discover the real DEX infrastructure on Robinhood Chain (or any EVM chain)
 * WITHOUT knowing any addresses in advance.
 *
 * It scans recent blocks for the standard Uniswap-style pool-creation events by
 * their topic signature (not by address), then groups the hits by the emitting
 * contract — that contract IS the factory. The token that appears in the most
 * pairs is almost certainly the base/quote token (WETH/USDG-equivalent).
 *
 * Usage:
 *   npx tsx scripts/discover-dex.ts                # uses .env RPC/CHAIN_ID
 *   npx tsx scripts/discover-dex.ts --rpc <url> --blocks 8000 --chunk 500
 *
 * Output is a set of candidate DEX_TYPE / DEX_FACTORY_ADDRESS / BASE_TOKEN
 * values to paste into .env. The router still needs the DEX's docs/explorer
 * (factory events don't reference it), but this narrows the search enormously.
 */
import { createPublicClient, http, parseAbiItem, type Address, type Log, type PublicClient } from 'viem';
import { loadConfig } from '../src/config/index.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const V2_PAIR_CREATED = parseAbiItem('event PairCreated(address indexed token0, address indexed token1, address pair, uint256 allPairs)');
const V3_POOL_CREATED = parseAbiItem('event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)');
const V3_SWAP = parseAbiItem('event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)');
const V2_SWAP = parseAbiItem('event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)');

/**
 * Find the router empirically: on a sample of the DEX's pools, the `sender` of
 * most Swap events is the contract that called the pool — i.e. the router.
 * (Factory events never reference the router, so this is the best public signal.
 *  Still VERIFY the winner on the explorer before pasting it into .env — a
 *  wrong/hostile router address can drain approvals.)
 */
async function findRouter(client: PublicClient, kind: 'v2' | 'v3', pools: Address[], fromBlock: bigint, toBlock: bigint, chunk: bigint): Promise<Map<string, number>> {
  const senders = new Map<string, number>();
  const sample = pools.slice(0, 8);
  const event = kind === 'v3' ? V3_SWAP : V2_SWAP;
  for (let start = fromBlock; start <= toBlock; start += chunk) {
    const end = start + chunk - 1n > toBlock ? toBlock : start + chunk - 1n;
    try {
      const logs = await client.getLogs({ address: sample, event: event as typeof V3_SWAP, fromBlock: start, toBlock: end });
      for (const l of logs) {
        const sender = (l as unknown as { args: { sender?: Address } }).args.sender;
        if (sender) senders.set(sender, (senders.get(sender) ?? 0) + 1);
      }
    } catch {
      /* range/rate-limit — skip this chunk */
    }
  }
  return senders;
}

async function main() {
  const cfg = loadConfig();
  const rpc = arg('rpc') ?? cfg.rpcUrl;
  const scanBlocks = BigInt(arg('blocks') ?? '6000');
  const chunk = BigInt(arg('chunk') ?? '500');

  const client = createPublicClient({ transport: http(rpc, { retryCount: 2, timeout: 15_000 }) });

  console.log(`\nRobinhood Chain DEX discovery`);
  console.log(`  RPC:    ${rpc}`);

  let chainId: number;
  let head: bigint;
  try {
    chainId = await client.getChainId();
    head = await client.getBlockNumber();
  } catch (err) {
    console.error(`\n✖ Could not reach the RPC: ${err instanceof Error ? err.message : String(err)}`);
    console.error(`  Check ROBINHOOD_RPC_URL / --rpc, your network, and that the endpoint is live.`);
    process.exit(1);
  }
  console.log(`  chainId: ${chainId}`);
  console.log(`  head:    ${head}`);
  const fromBlock = head > scanBlocks ? head - scanBlocks : 0n;
  console.log(`  scanning blocks ${fromBlock}..${head} (${scanBlocks} blocks, chunk ${chunk})\n`);

  const v2: Log[] = [];
  const v3: Log[] = [];
  let scanned = 0n;
  for (let start = fromBlock; start <= head; start += chunk) {
    const end = start + chunk - 1n > head ? head : start + chunk - 1n;
    try {
      const [a, b] = await Promise.all([
        client.getLogs({ event: V2_PAIR_CREATED, fromBlock: start, toBlock: end }),
        client.getLogs({ event: V3_POOL_CREATED, fromBlock: start, toBlock: end }),
      ]);
      v2.push(...a);
      v3.push(...b);
    } catch (err) {
      // some public RPCs cap getLogs ranges/results — shrink and continue
      console.warn(`  ! chunk ${start}..${end} failed (${short(err)}) — try a smaller --chunk`);
    }
    scanned += end - start + 1n;
    process.stdout.write(`\r  progress: ${scanned}/${scanBlocks} blocks, v2 hits=${v2.length} v3 hits=${v3.length}   `);
  }
  process.stdout.write('\n\n');

  await report(client, 'uniswap_v2', 'v2', v2, (l) => (l as unknown as { args: { pair: Address } }).args.pair, fromBlock, head, chunk);
  await report(client, 'uniswap_v3', 'v3', v3, (l) => (l as unknown as { args: { pool: Address } }).args.pool, fromBlock, head, chunk);

  if (v2.length === 0 && v3.length === 0) {
    console.log('No Uniswap-v2/v3-style pool-creation events found in this range.');
    console.log('Possible reasons:');
    console.log('  • No DEX (of these styles) has launched yet, or none created pools recently.');
    console.log('  • The DEX uses a different event signature — check the chain explorer / DEX docs.');
    console.log('  • Widen the scan: --blocks 50000  (and shrink --chunk if the RPC rate-limits).');
  } else {
    console.log('Next steps:');
    console.log('  1. Verify the top candidate factory on the Robinhood Chain explorer.');
    console.log('  2. Find that DEX\'s ROUTER address from its docs/explorer (events don\'t reveal it).');
    console.log('  3. Put DEX_TYPE / DEX_FACTORY_ADDRESS / DEX_ROUTER_ADDRESS / BASE_TOKEN_ADDRESS in .env.');
    console.log('  4. `npm run bot -- config-check`, then `bot watch` on testnet before trading.');
  }
}

async function report(
  client: PublicClient,
  kind: string,
  swapKind: 'v2' | 'v3',
  logs: Log[],
  poolOf: (l: Log) => Address,
  fromBlock: bigint,
  toBlock: bigint,
  chunk: bigint,
) {
  if (!logs.length) return;
  const byFactory = new Map<string, number>();
  const byToken = new Map<string, number>();
  const pools: Address[] = [];
  for (const l of logs) {
    byFactory.set(l.address, (byFactory.get(l.address) ?? 0) + 1);
    const { token0, token1 } = (l as unknown as { args: { token0: Address; token1: Address } }).args;
    for (const t of [token0, token1]) byToken.set(t.toLowerCase(), (byToken.get(t.toLowerCase()) ?? 0) + 1);
    pools.push(poolOf(l));
  }
  console.log(`══ ${kind}: ${logs.length} pool(s) created ══`);
  console.log(`  Candidate factories (DEX_FACTORY_ADDRESS), by pools created:`);
  for (const [addr, n] of [...byFactory.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
    console.log(`    ${addr}   ${n} pools`);
  }
  console.log(`  Most-paired tokens (likely BASE_TOKEN_ADDRESS = WETH/USDG-equivalent):`);
  for (const [addr, n] of [...byToken.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
    console.log(`    ${addr}   in ${n} pairs`);
  }

  // recent window for swaps — routers are busiest lately; keep the range small
  const swapFrom = fromBlock; // sample swaps across the whole scanned range
  const senders = await findRouter(client, swapKind, pools, swapFrom, toBlock, chunk);
  if (senders.size) {
    console.log(`  Candidate ROUTER (DEX_ROUTER_ADDRESS) — most common Swap caller (VERIFY on explorer!):`);
    for (const [addr, n] of [...senders.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)) {
      console.log(`    ${addr}   ${n} swaps routed`);
    }
  } else {
    console.log(`  Router: no recent swaps sampled — get DEX_ROUTER_ADDRESS from the DEX docs/explorer.`);
  }
  console.log('');
}

function short(err: unknown): string {
  const s = err instanceof Error ? err.message : String(err);
  return s.length > 80 ? s.slice(0, 80) + '…' : s;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
