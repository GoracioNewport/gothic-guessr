/** Delete the run directory (temporary database, recorded bodies) created by playwright.config.ts. */
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

export default function globalTeardown(): void {
  const dir = process.env.E2E_RUN_DIR;
  if (process.env.E2E_KEEP_RUN_DIR === '1') return;
  if (dir && dir.startsWith(tmpdir())) rmSync(dir, { recursive: true, force: true });
}
