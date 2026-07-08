/**
 * Reset local bot state: deletes the SQLite database (positions, trades,
 * discovered pools, paper balance, live confirmation, emergency stop).
 *
 *   npx tsx scripts/reset-db.ts
 */
import { existsSync, rmSync } from 'node:fs';
import { loadConfig } from '../src/config/index.js';

const cfg = loadConfig();
const files = [cfg.dbPath, `${cfg.dbPath}-wal`, `${cfg.dbPath}-shm`];
let removed = 0;
for (const f of files) {
  if (existsSync(f)) {
    rmSync(f);
    removed++;
    console.log(`removed ${f}`);
  }
}
console.log(removed ? 'database reset — paper balance, positions and live confirmation are cleared.' : `nothing to remove at ${cfg.dbPath}`);
