import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function run(cmd: string): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execSync(cmd, { cwd: ROOT, encoding: 'utf-8', timeout: 120_000, stdio: ['pipe', 'pipe', 'pipe'] });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', exitCode: e.status ?? 1 };
  }
}

// Run serially to avoid race conditions (build creates dist while lint scans)
test.describe.configure({ mode: 'serial' });

test.describe('ST-1: Environment & Build', () => {
  test('ST-1.2 typecheck passes', () => {
    const result = run('npm run typecheck');
    expect(result.exitCode, `typecheck failed:\n${result.stderr}`).toBe(0);
  });

  test('ST-1.3 lint passes', () => {
    const result = run('npm run lint');
    expect(result.exitCode, `lint failed:\n${result.stdout}\n${result.stderr}`).toBe(0);
  });

  test('ST-1.4 build succeeds', () => {
    const result = run('npm run build');
    expect(result.exitCode, `build failed:\n${result.stderr}`).toBe(0);
  });
});
