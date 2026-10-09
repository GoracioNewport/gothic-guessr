/**
 * The real dataset for the tests that need it (git-ignored, built from your own copy of the game, see README). Read at
 * run time instead of a static JSON import so a fresh clone without the dataset still type-checks; vite.config.ts skips
 * those tests (DATASET_TESTS) when the files are missing.
 */
import { readFileSync } from 'node:fs';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function readDataset<T = any>(relativePath: string): T {
  return JSON.parse(readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8')) as T;
}
