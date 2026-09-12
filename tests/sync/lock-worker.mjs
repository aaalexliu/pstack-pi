import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { mock } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [args, gateKind, gatePath] = process.argv.slice(2);
const readFile = fs.readFile;
const rename = fs.rename;
const rm = fs.rm;
let paused = false;
async function pause() {
  if (paused) return;
  paused = true;
  const resumed = new Promise((resolve) => process.once('message', resolve));
  process.send?.('paused');
  await resumed;
}
/** @param {Parameters<typeof fs.readFile>} args */
async function gatedRead(...args) {
  const bytes = await readFile(...args);
  if (gateKind === 'read' && String(args[0]).endsWith(gatePath)) await pause();
  return bytes;
}
mock.method(fs, 'readFile', gatedRead);
fs.rename = async (...args) => {
  if (gateKind === 'rename' && String(args[0]).endsWith(gatePath)) await pause();
  return rename(...args);
};
fs.rm = async (...args) => {
  if (gateKind === 'cleanup' && path.basename(String(args[0])).startsWith('.pstack-sync-')) await pause();
  return rm(...args);
};
syncBuiltinESMExports();
process.argv = [process.execPath, fileURLToPath(new URL('../../scripts/sync-upstream.mjs', import.meta.url)), ...JSON.parse(args)];
await import('../../scripts/sync-upstream.mjs');
process.once('beforeExit', () => process.disconnect?.());
