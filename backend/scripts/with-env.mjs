import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(__dirname, '..');
const monorepoRoot = path.resolve(backendRoot, '..');

dotenv.config({ path: path.join(monorepoRoot, '.env') });
dotenv.config({ path: path.join(backendRoot, '.env') });

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) {
  console.error('Usage: node scripts/with-env.mjs <command> [...args]');
  process.exit(1);
}

const result = spawnSync(cmd, args, {
  stdio: 'inherit',
  shell: true,
  env: process.env,
});

process.exit(result.status ?? 1);
