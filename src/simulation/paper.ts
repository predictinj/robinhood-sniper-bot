import { parseEther, formatEther } from 'viem';
import type { Address, Mode, Position } from '../types/index.js';
import type { DexAdapter } from '../dex/adapter.js';
import type { BotDb } from '../storage/db.js';
import { priceFromAmounts } from '../utils/math.js';
import { childLogger } from '../utils/logger.js';

const log = childLogger('paper');

const BALANCE_KEY = 'paper_balance_wei';

/**
 * Paper trading engine: identical decision path to live trading, but fills
 * happen at the adapter's quoted price and only the local balance changes.
 * No transaction is ever built or sent in paper mode.
 */
export class PaperEngine {
  constructor(
    private readonly db: BotDb,
    private readonly adapter: DexAdapter,
    initialBalanceEth: number,
  ) {
    if (this.db.getSetting(BALANCE_KEY) === null) {
      this.db.setSetting(BALANCE_KEY, parseEther(initialBalanceEth.toString()).toString());
    }
  }

  balance(): bigint {
    return BigInt(this.db.getSetting(BALANCE_KEY) ?? '0');
  }

  private setBalance(v: bigint) {
    this.db.setSetting(BALANCE_KEY, v.toString());
  }

  async buy(token: Address, pool: Address | null, amountInBase: bigint, tokenDecimals = 18): Promise<{ tradeId: number; positionId: number; amountOut: bigint }> {
    const bal = this.balance();
    if (amountInBase > bal) {
      throw new Error(`paper balance too low: have ${formatEther(bal)} ETH, need ${formatEther(amountInBase)} ETH`);
    }
    const amountOut = await this.adapter.quoteBuy(token, amountInBase);
    if (amountOut <= 0n) throw new Error('paper buy: quote returned 0');
    const price = priceFromAmounts(amountInBase, amountOut, tokenDecimals);

    this.setBalance(bal - amountInBase);
    const tradeId = this.db.insertTrade({
      mode: 'paper' as Mode,
      side: 'buy',
      token,
      pool,
      amountIn: amountInBase,
      amountOut,
      price,
      txHash: null,
      status: 'simulated',
      error: null,
    });
    const positionId = this.db.openPosition({ token, pool, mode: 'paper', entryPrice: price, amountToken: amountOut, costBase: amountInBase });
    this.db.insertEvent('paper_buy', { token, amountInBase, amountOut, price });
    log.info({ token, in: formatEther(amountInBase), out: amountOut.toString(), price }, 'paper BUY filled');
    return { tradeId, positionId, amountOut };
  }

  async sell(position: Position, percent: number, reason: string, tokenDecimals = 18): Promise<{ tradeId: number; amountOutBase: bigint }> {
    if (percent <= 0 || percent > 100) throw new Error(`invalid sell percent: ${percent}`);
    const amountTokens = (position.amountToken * BigInt(Math.floor(percent * 100))) / 10_000n;
    if (amountTokens <= 0n) throw new Error('paper sell: nothing to sell');
    const amountOutBase = await this.adapter.quoteSell(position.token, amountTokens);
    const price = priceFromAmounts(amountOutBase, amountTokens, tokenDecimals);

    this.setBalance(this.balance() + amountOutBase);
    const tradeId = this.db.insertTrade({
      mode: 'paper' as Mode,
      side: 'sell',
      token: position.token,
      pool: position.pool,
      amountIn: amountTokens,
      amountOut: amountOutBase,
      price,
      txHash: null,
      status: 'simulated',
      error: null,
    });
    this.db.reducePosition(position.id, amountTokens, percent >= 100 ? reason : null);
    this.db.insertEvent('paper_sell', { token: position.token, amountTokens, amountOutBase, price, reason });
    log.info({ token: position.token, sold: amountTokens.toString(), got: formatEther(amountOutBase), reason }, 'paper SELL filled');
    return { tradeId, amountOutBase };
  }
}
