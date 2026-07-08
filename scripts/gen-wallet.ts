/**
 * Generate a fresh throwaway wallet for testnet (or a dedicated live wallet).
 * Prints the address and private key to stdout ONCE — store the key in .env
 * yourself; nothing is written to disk.
 *
 *   npx tsx scripts/gen-wallet.ts
 */
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const pk = generatePrivateKey();
const account = privateKeyToAccount(pk);

console.log('New wallet generated (NOT saved anywhere — copy it now):');
console.log(`  address:     ${account.address}`);
console.log(`  private key: ${pk}`);
console.log('');
console.log('Put the key in .env as PRIVATE_KEY=... and fund the address.');
console.log('Use a DEDICATED wallet for the bot — never your main wallet.');
