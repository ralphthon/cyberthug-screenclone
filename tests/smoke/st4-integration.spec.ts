import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURE_IMAGE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures/test-screenshot.png',
);
const API_BASE = 'http://localhost:3001';

// Integration tests share a page and run serially
test.describe.configure({ mode: 'serial' });

test.describe('ST-4: Clone Session (Integration)', () => {
  test.setTimeout(300_000);

  let page: Page;
  // Captured from the upload API response so afterAll can clean up
  let capturedSessionId: string | null = null;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  });

  test.afterAll(async () => {
    if (capturedSessionId) {
      try {
        await page.request.post(`${API_BASE}/api/loop/${capturedSessionId}/stop`);
      } catch {
        // Loop may have already stopped
      }
    }
    await page.close();
  });

  test('ST-4.1 session starts with simple screenshot', async () => {
    await page.goto('/');

    // Intercept the upload response to capture the sessionId for cleanup
    page.on('response', async (response) => {
      if (response.url().includes('/api/upload') && response.status() === 201) {
        try {
          const body = await response.json();
          capturedSessionId = body.sessionId ?? null;
        } catch {
          // Response may have already been consumed
        }
      }
    });

    // Upload screenshot
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(FIXTURE_IMAGE);
    await expect(page.locator('img[alt="test-screenshot.png"]')).toBeVisible({ timeout: 5_000 });

    // Fill project name
    await page.locator('input[placeholder="my-landing-page"]').fill('e2e-test-clone');

    // Set max iterations low for fast testing
    const maxIter = page.locator('input[type="number"][min="1"]');
    await maxIter.fill('3');

    // Click Start Cloning
    const startButton = page.getByRole('button', { name: /Start Cloning/i });
    await expect(startButton).toBeEnabled();
    await startButton.click();

    // Verify the UI transitions to running state
    await expect(page.locator('text=Clone is running')).toBeVisible({ timeout: 30_000 });

    // Skeleton cards should show while waiting for first iteration
    await expect(
      page.locator('text=Generating first iteration').or(page.locator('article').filter({ hasText: /Score:/ })),
    ).toBeVisible({ timeout: 30_000 });
  });

  test('ST-4.2 iterations appear in timeline', async () => {
    // Wait for at least one completed iteration card with a real score
    const iterationCard = page.locator('article').filter({ hasText: /Score:/ }).first();
    await expect(iterationCard).toBeVisible({ timeout: 180_000 });

    // The card should show iteration #1
    await expect(iterationCard.locator('text=/#\\d/')).toBeVisible();

    // Wait for the score to be a real number (not "n/a")
    await expect(
      page.locator('article').filter({ hasText: /Score: \d/ }).first(),
    ).toBeVisible({ timeout: 120_000 });

    // Score Progress chart should have data
    await expect(page.locator('h3', { hasText: 'Score Progress' })).toBeVisible();
  });

  test('ST-4.3 comparison slider works', async () => {
    // The comparison section should be populated now
    const compareHeading = page.locator('h2').filter({ hasText: /Compare: Iteration #\d/ });
    await expect(compareHeading).toBeVisible({ timeout: 10_000 });

    // Verify comparison mode buttons exist
    const sliderBtn = page.getByRole('button', { name: 'Slider' });
    const diffBtn = page.getByRole('button', { name: 'Diff Overlay' });
    const sideBtn = page.getByRole('button', { name: 'Side-by-Side' });

    await expect(sliderBtn).toBeVisible();
    await expect(diffBtn).toBeVisible();
    await expect(sideBtn).toBeVisible();

    // Test Side-by-Side mode
    await sideBtn.click();
    await expect(page.locator('text=Original').first()).toBeVisible();
    await expect(page.locator('text=/Generated/')).toBeVisible();

    // Test Slider mode
    await sliderBtn.click();
    await expect(page.locator('input[type="range"]')).toBeVisible();
    await expect(page.locator('text=Reveal')).toBeVisible();

    // Test Diff Overlay mode
    await diffBtn.click();
    await expect(page.locator('img[alt="Original screenshot"]').first()).toBeVisible();

    // Similarity bar should be present
    await expect(page.locator('text=Similarity')).toBeVisible();
  });

  test('ST-4.4 auto-commit per iteration', async () => {
    // Expand the first iteration card
    const iterationCard = page.locator('article').filter({ hasText: /Score: \d/ }).first();
    await iterationCard.locator('button').first().click();

    // The expanded card should show at least one of: code preview, screenshot, or commit link
    const codePreview = page.locator('text=Code Preview');
    const screenshot = page.locator('p', { hasText: 'Screenshot' });
    const commitLink = page.locator('text=View commit');

    // Wait briefly for expansion animation
    await page.waitForTimeout(500);

    const hasCode = await codePreview.isVisible().catch(() => false);
    const hasScreenshot = await screenshot.isVisible().catch(() => false);
    const hasCommit = await commitLink.isVisible().catch(() => false);

    // The expanded card must show at least one piece of iteration data
    expect(hasCode || hasScreenshot || hasCommit).toBe(true);

    // If GitHub was configured, verify the commit link is a valid URL
    if (hasCommit) {
      const href = await commitLink.locator('a').getAttribute('href');
      expect(href).toMatch(/^https?:\/\//);
    }
  });
});
