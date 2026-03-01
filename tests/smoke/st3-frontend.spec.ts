import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURE_IMAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/test-screenshot.png');

test.describe('ST-3: Frontend UI', () => {
  test('ST-3.1 page loads with ScreenClone heading on dark background', async ({ page }) => {
    await page.goto('/');
    const heading = page.locator('h1');
    await expect(heading).toContainText('ScreenClone');
    await expect(heading).toBeVisible();

    // Verify dark background on body/main
    const main = page.locator('main');
    const bgColor = await main.evaluate((el) => getComputedStyle(el).backgroundColor);
    // Should be a dark color (not white/transparent)
    expect(bgColor).not.toBe('rgba(0, 0, 0, 0)');
  });

  test('ST-3.2 drag-drop zone highlights on dragenter', async ({ page }) => {
    await page.goto('/');
    const dropZone = page.locator('div[role="button"]');
    await expect(dropZone).toBeVisible();

    // Verify drop zone has expected text
    await expect(dropZone).toContainText('Drop screenshots here');
  });

  test('ST-3.3 file picker opens via Browse Files button', async ({ page }) => {
    await page.goto('/');

    // The hidden file input should exist
    const fileInput = page.locator('input[type="file"]');
    await expect(fileInput).toHaveCount(1);

    // Upload a file via the file input
    await fileInput.setInputFiles(FIXTURE_IMAGE);

    // Thumbnail should appear
    const thumbnail = page.locator('img[alt="test-screenshot.png"]');
    await expect(thumbnail).toBeVisible({ timeout: 5000 });
  });

  test('ST-3.4 start button enables when project name and image are provided', async ({
    page,
  }) => {
    await page.goto('/');

    const startButton = page.getByRole('button', { name: /Start Cloning/i });
    await expect(startButton).toBeDisabled();

    // Fill project name
    const projectNameInput = page.locator('input[placeholder="my-landing-page"]');
    await projectNameInput.fill('test-project');

    // Still disabled without image
    await expect(startButton).toBeDisabled();

    // Upload image
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(FIXTURE_IMAGE);

    // Now should be enabled
    await expect(startButton).toBeEnabled();
  });

  test('ST-3.5 remove image via X button updates counter', async ({ page }) => {
    await page.goto('/');

    // Upload image
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(FIXTURE_IMAGE);

    // Verify thumbnail appeared
    const thumbnail = page.locator('img[alt="test-screenshot.png"]');
    await expect(thumbnail).toBeVisible({ timeout: 5000 });

    // Counter should show 1/5 uploaded
    const counter = page.locator('text=1/5 uploaded');
    await expect(counter).toBeVisible();

    // Click remove button
    const removeButton = page.getByRole('button', { name: /Remove test-screenshot\.png/i });
    await removeButton.click();

    // Thumbnail should be gone
    await expect(thumbnail).not.toBeVisible();

    // Counter should show 0/5 uploaded
    await expect(page.locator('text=0/5 uploaded')).toBeVisible();
  });

  test('ST-3.6 form settings persist across page reload via localStorage', async ({ page }) => {
    await page.goto('/');

    // Fill form fields
    const projectNameInput = page.locator('input[placeholder="my-landing-page"]');
    await projectNameInput.fill('persisted-project');

    const maxIterationsInput = page.locator('input[type="number"][min="1"]');
    await maxIterationsInput.fill('500');

    // Upload image so start button is enabled
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(FIXTURE_IMAGE);

    // Click start to trigger localStorage save
    const startButton = page.getByRole('button', { name: /Start Cloning/i });
    await startButton.click();

    // Reload page
    await page.reload();

    // Values should be restored from localStorage
    await expect(projectNameInput).toHaveValue('persisted-project');
    await expect(maxIterationsInput).toHaveValue('500');
  });
});
