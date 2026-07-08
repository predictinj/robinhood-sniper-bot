import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  Address,
  Mode,
  PoolInfo,
  Position,
  SafetyReport,
  TokenMeta,
  TradeRecord,
} from '../types/index.js';

/**
 * SQLite persistence layer. Schema is created automatically and versioned via
 * PRAGMA user_version so future migrations can build on it.
 *
 * SECURITY: no private key material is ever written to this database.
 */
export class BotDb {
  readonly db: Database.Database;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  private migrate() {
    const version = this.db.pragma('user_version', { simple: true }) as number;
    if (version < 1) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS tokens (
          address TEXT PRIMARY KEY,
          name TEXT, symbol TEXT, decimals INTEGER, total_supply TEXT,
          flagged INTEGER NOT NULL DEFAULT 0, notes TEXT,
          first_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS pools (
          address TEXT PRIMARY KEY,
          dex TEXT NOT NULL, token TEXT NOT NULL, base_token TEXT NOT NULL,
          token0 TEXT NOT NULL, token1 TEXT NOT NULL,
          block_number TEXT NOT NULL, liquidity_base TEXT,
          discovered_at TEXT NOT NULL DEFAULT (datetime('now')),
          last_checked_at TEXT
        );
        CREATE TABLE IF NOT EXISTS safety_checks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          token TEXT NOT NULL, pool TEXT,
          passed INTEGER NOT NULL,
          critical_failures TEXT NOT NULL, warnings TEXT NOT NULL,
          details_json TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS trades (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          mode TEXT NOT NULL, side TEXT NOT NULL,
          token TEXT NOT NULL, pool TEXT,
          amount_in TEXT NOT NULL, amount_out TEXT NOT NULL,
          price REAL NOT NULL,
          tx_hash TEXT, status TEXT NOT NULL, error TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS positions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          token TEXT NOT NULL, pool TEXT, mode TEXT NOT NULL,
          entry_price REAL NOT NULL, amount_token TEXT NOT NULL, cost_base TEXT NOT NULL,
          current_price REAL NOT NULL DEFAULT 0, pnl_percent REAL NOT NULL DEFAULT 0,
          high_water_price REAL NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'open',
          opened_at TEXT NOT NULL DEFAULT (datetime('now')),
          closed_at TEXT, close_reason TEXT
        );
        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY, value TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL, data_json TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS errors (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          scope TEXT NOT NULL, message TEXT NOT NULL, data_json TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_trades_token ON trades(token);
        CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
        CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
      `);
      this.db.pragma('user_version = 1');
    }
  }

  // ---- settings ----
  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string) {
    this.db
      .prepare(
        `INSERT INTO settings(key, value, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value);
  }

  isEmergencyStopped(): boolean {
    return this.getSetting('emergency_stop') === '1';
  }

  isLiveConfirmed(): boolean {
    return this.getSetting('live_confirmed') === '1';
  }

  // ---- tokens ----
  upsertToken(meta: TokenMeta) {
    this.db
      .prepare(
        `INSERT INTO tokens(address, name, symbol, decimals, total_supply) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(address) DO UPDATE SET
           name = COALESCE(excluded.name, tokens.name),
           symbol = COALESCE(excluded.symbol, tokens.symbol),
           decimals = COALESCE(excluded.decimals, tokens.decimals),
           total_supply = COALESCE(excluded.total_supply, tokens.total_supply)`,
      )
      .run(meta.address.toLowerCase(), meta.name, meta.symbol, meta.decimals, meta.totalSupply?.toString() ?? null);
  }

  flagToken(address: Address, notes: string) {
    this.db
      .prepare(
        `INSERT INTO tokens(address, flagged, notes) VALUES (?, 1, ?)
         ON CONFLICT(address) DO UPDATE SET flagged = 1, notes = excluded.notes`,
      )
      .run(address.toLowerCase(), notes);
  }

  getToken(address: Address): { address: string; name: string | null; symbol: string | null; decimals: number | null; flagged: number } | undefined {
    return this.db.prepare('SELECT * FROM tokens WHERE address = ?').get(address.toLowerCase()) as ReturnType<BotDb['getToken']>;
  }

  // ---- pools ----
  /** Returns true if the pool was newly inserted (false = duplicate). */
  insertPool(pool: PoolInfo, liquidityBase: bigint | null): boolean {
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO pools(address, dex, token, base_token, token0, token1, block_number, liquidity_base)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        pool.address.toLowerCase(),
        pool.dex,
        pool.token.toLowerCase(),
        pool.baseToken.toLowerCase(),
        pool.token0.toLowerCase(),
        pool.token1.toLowerCase(),
        pool.blockNumber.toString(),
        liquidityBase?.toString() ?? null,
      );
    return res.changes > 0;
  }

  hasPool(address: Address): boolean {
    return !!this.db.prepare('SELECT 1 FROM pools WHERE address = ?').get(address.toLowerCase());
  }

  listPools(limit = 50): Array<Record<string, unknown>> {
    return this.db.prepare('SELECT * FROM pools ORDER BY discovered_at DESC LIMIT ?').all(limit) as Array<Record<string, unknown>>;
  }

  getPoolForToken(token: Address): Record<string, unknown> | undefined {
    return this.db.prepare('SELECT * FROM pools WHERE token = ? ORDER BY discovered_at DESC LIMIT 1').get(token.toLowerCase()) as
      | Record<string, unknown>
      | undefined;
  }

  // ---- safety ----
  insertSafetyReport(report: SafetyReport): number {
    const res = this.db
      .prepare(
        `INSERT INTO safety_checks(token, pool, passed, critical_failures, warnings, details_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        report.token.toLowerCase(),
        report.pool?.toLowerCase() ?? null,
        report.passed ? 1 : 0,
        JSON.stringify(report.criticalFailures),
        JSON.stringify(report.warnings),
        JSON.stringify(report.findings),
      );
    return Number(res.lastInsertRowid);
  }

  // ---- trades ----
  insertTrade(t: TradeRecord): number {
    const res = this.db
      .prepare(
        `INSERT INTO trades(mode, side, token, pool, amount_in, amount_out, price, tx_hash, status, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        t.mode,
        t.side,
        t.token.toLowerCase(),
        t.pool?.toLowerCase() ?? null,
        t.amountIn.toString(),
        t.amountOut.toString(),
        t.price,
        t.txHash,
        t.status,
        t.error,
      );
    return Number(res.lastInsertRowid);
  }

  updateTradeStatus(id: number, status: string, txHash: string | null, error: string | null) {
    this.db.prepare('UPDATE trades SET status = ?, tx_hash = COALESCE(?, tx_hash), error = ? WHERE id = ?').run(status, txHash, error, id);
  }

  listTrades(limit = 50): Array<Record<string, unknown>> {
    return this.db.prepare('SELECT * FROM trades ORDER BY id DESC LIMIT ?').all(limit) as Array<Record<string, unknown>>;
  }

  lastBuyAt(): string | null {
    const row = this.db
      .prepare(`SELECT created_at FROM trades WHERE side = 'buy' AND status != 'failed' ORDER BY id DESC LIMIT 1`)
      .get() as { created_at: string } | undefined;
    return row?.created_at ?? null;
  }

  // ---- positions ----
  openPosition(p: { token: Address; pool: Address | null; mode: Mode; entryPrice: number; amountToken: bigint; costBase: bigint }): number {
    const res = this.db
      .prepare(
        `INSERT INTO positions(token, pool, mode, entry_price, amount_token, cost_base, current_price, high_water_price)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(p.token.toLowerCase(), p.pool?.toLowerCase() ?? null, p.mode, p.entryPrice, p.amountToken.toString(), p.costBase.toString(), p.entryPrice, p.entryPrice);
    return Number(res.lastInsertRowid);
  }

  private rowToPosition(row: Record<string, unknown>): Position {
    return {
      id: row.id as number,
      token: row.token as Address,
      pool: (row.pool as Address) ?? null,
      mode: row.mode as Mode,
      entryPrice: row.entry_price as number,
      amountToken: BigInt(row.amount_token as string),
      costBase: BigInt(row.cost_base as string),
      currentPrice: row.current_price as number,
      pnlPercent: row.pnl_percent as number,
      highWaterPrice: row.high_water_price as number,
      status: row.status as Position['status'],
      openedAt: row.opened_at as string,
      closedAt: (row.closed_at as string) ?? null,
      closeReason: (row.close_reason as string) ?? null,
    };
  }

  getPosition(id: number): Position | null {
    const row = this.db.prepare('SELECT * FROM positions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToPosition(row) : null;
  }

  openPositions(): Position[] {
    const rows = this.db.prepare(`SELECT * FROM positions WHERE status = 'open' ORDER BY id`).all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToPosition(r));
  }

  openPositionForToken(token: Address): Position | null {
    const row = this.db
      .prepare(`SELECT * FROM positions WHERE status = 'open' AND token = ? ORDER BY id DESC LIMIT 1`)
      .get(token.toLowerCase()) as Record<string, unknown> | undefined;
    return row ? this.rowToPosition(row) : null;
  }

  listPositions(limit = 50): Position[] {
    const rows = this.db.prepare('SELECT * FROM positions ORDER BY id DESC LIMIT ?').all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToPosition(r));
  }

  updatePositionPrice(id: number, currentPrice: number, pnlPercent: number, highWaterPrice: number) {
    this.db
      .prepare('UPDATE positions SET current_price = ?, pnl_percent = ?, high_water_price = ? WHERE id = ?')
      .run(currentPrice, pnlPercent, highWaterPrice, id);
  }

  /** Reduce or close a position after a (partial) sell. */
  reducePosition(id: number, soldAmount: bigint, closeReason: string | null) {
    const pos = this.getPosition(id);
    if (!pos) return;
    const remaining = pos.amountToken - soldAmount;
    if (remaining <= 0n) {
      this.db
        .prepare(`UPDATE positions SET amount_token = '0', status = 'closed', closed_at = datetime('now'), close_reason = ? WHERE id = ?`)
        .run(closeReason, id);
    } else {
      // proportionally reduce cost basis
      const newCost = (pos.costBase * remaining) / pos.amountToken;
      this.db.prepare('UPDATE positions SET amount_token = ?, cost_base = ? WHERE id = ?').run(remaining.toString(), newCost.toString(), id);
    }
  }

  // ---- events & errors ----
  insertEvent(type: string, data: unknown) {
    this.db.prepare('INSERT INTO events(type, data_json) VALUES (?, ?)').run(type, JSON.stringify(data, bigintReplacer));
  }

  listEvents(type: string | null, limit = 1000): Array<{ id: number; type: string; data_json: string; created_at: string }> {
    if (type) {
      return this.db.prepare('SELECT * FROM events WHERE type = ? ORDER BY id LIMIT ?').all(type, limit) as ReturnType<BotDb['listEvents']>;
    }
    return this.db.prepare('SELECT * FROM events ORDER BY id LIMIT ?').all(limit) as ReturnType<BotDb['listEvents']>;
  }

  insertError(scope: string, message: string, data?: unknown) {
    this.db.prepare('INSERT INTO errors(scope, message, data_json) VALUES (?, ?, ?)').run(scope, message, data ? JSON.stringify(data, bigintReplacer) : null);
  }

  close() {
    this.db.close();
  }
}

function bigintReplacer(_key: string, value: unknown) {
  return typeof value === 'bigint' ? value.toString() : value;
}
