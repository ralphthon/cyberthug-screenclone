import { test } from '@playwright/test';

test.describe('ST-4: Clone Session (Integration)', () => {
  test.skip('ST-4.1 session starts with simple screenshot', async () => {
    // Requires ralph backend (ralph.sh + omx) to be configured
  });

  test.skip('ST-4.2 iterations appear in timeline', async () => {
    // Requires ralph backend running for 2-3 iterations
  });

  test.skip('ST-4.3 comparison slider works', async () => {
    // Requires at least one completed iteration
  });

  test.skip('ST-4.4 auto-commit per iteration', async () => {
    // Requires GitHub token + iteration data
  });
});
