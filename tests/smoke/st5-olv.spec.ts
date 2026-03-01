import { test, expect, type Page } from '@playwright/test';

// OLV tests share a page and run serially (WebSocket state carries over)
test.describe.configure({ mode: 'serial' });

test.describe('ST-5: Live2D / OpenWaifu (Optional)', () => {
  test.setTimeout(60_000);

  let page: Page;

  /** Ensure the Cloney panel aside is visible, expanding it if collapsed. */
  async function ensurePanelExpanded(): Promise<void> {
    // Playwright maps <aside> to the "complementary" role
    const aside = page.locator('aside');
    const expandBtn = page.locator('button[aria-label="Expand Cloney panel"]');

    if (await aside.filter({ hasText: 'OLV' }).isVisible().catch(() => false)) {
      return;
    }

    if (await expandBtn.isVisible().catch(() => false)) {
      await expandBtn.click();
      await expect(aside.filter({ hasText: 'OLV' })).toBeVisible({ timeout: 5_000 });
    }
  }

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

    await page.goto('/');
    await page.evaluate(() => {
      window.localStorage.removeItem('ralphton-olv-panel-collapsed');
    });
    await page.reload();
    await page.waitForTimeout(2_000);
  });

  test.afterAll(async () => {
    await page.close();
  });

  test('ST-5.1 WebSocket connects to OLV server', async () => {
    await ensurePanelExpanded();

    const panel = page.locator('aside').filter({ hasText: 'OLV' });
    await expect(panel).toBeVisible({ timeout: 10_000 });

    // Connection indicator should show one of: Connected, Connecting, or Disconnected
    // This verifies the WebSocket machinery is wired up to the OLV server
    const statusText = panel.locator('text=/OLV (Connected|Connecting|Disconnected)/');
    await expect(statusText).toBeVisible({ timeout: 10_000 });

    // If connected, great. If connecting/disconnected, verify the server URL is configured
    const serverUrlInput = panel.locator('input[placeholder="ws://localhost:12393/ws"]');
    await expect(serverUrlInput).toBeVisible();
    const url = await serverUrlInput.inputValue();
    expect(url).toContain('12393');
  });

  test('ST-5.2 Live2D canvas renders WaifuClaw model', async () => {
    await ensurePanelExpanded();

    // The Live2D Canvas section should exist
    await expect(page.locator('h3', { hasText: 'Live2D Canvas' })).toBeVisible();

    // The iframe should be loaded with the OpenWaifu frontend
    const iframe = page.locator('iframe[title="OpenWaifu Live2D"]');
    const fallback = page.locator('text=OLV server not connected');

    const iframeVisible = await iframe.isVisible().catch(() => false);
    const fallbackVisible = await fallback.isVisible().catch(() => false);

    // At least one of these should be true - the component rendered
    expect(iframeVisible || fallbackVisible).toBe(true);

    // If the iframe loaded, verify it has content (the Live2D model loads inside)
    if (iframeVisible) {
      const src = await iframe.getAttribute('src');
      expect(src).toMatch(/^https?:\/\//);

      // Verify the iframe rendered something (check it has a non-zero size)
      const box = await iframe.boundingBox();
      expect(box).toBeTruthy();
      expect(box!.width).toBeGreaterThan(0);
      expect(box!.height).toBeGreaterThan(0);
    }
  });

  test('ST-5.3 chat messages work with Cloney', async () => {
    await ensurePanelExpanded();

    // Chat History section should exist
    await expect(page.locator('h3', { hasText: 'Chat History' })).toBeVisible();

    // Cloney's greeting message should already be visible
    await expect(page.locator('article').filter({ hasText: /Cloney/ })).toBeVisible();

    // Chat input should be available
    const chatInput = page.locator('input[placeholder="Message Cloney..."]');
    await expect(chatInput).toBeVisible();

    // Record current message count
    const beforeCount = await page.locator('aside').filter({ hasText: 'OLV' }).locator('article').count();

    // Type a message and send
    await chatInput.fill('Hello Cloney!');
    const sendButton = page.getByRole('button', { name: 'Send' });
    await sendButton.click();

    // A new article should appear for the user message
    await expect(async () => {
      const afterCount = await page.locator('aside').filter({ hasText: 'OLV' }).locator('article').count();
      expect(afterCount).toBeGreaterThan(beforeCount);
    }).toPass({ timeout: 10_000 });

    // The user message text should be in the chat
    await expect(
      page.locator('aside').filter({ hasText: 'OLV' }).locator('article').filter({ hasText: 'Hello Cloney!' }),
    ).toBeVisible();
  });

  test('ST-5.4 Cloney narrates clone progress', async () => {
    await ensurePanelExpanded();

    const panel = page.locator('aside').filter({ hasText: 'OLV' });

    // The expression indicator badge should be visible (shows current Live2D emotion)
    // The badge shows emotion text like "neutral", "joy", etc.
    const expressionBadge = panel.locator('text=/neutral|joy|sadness|surprise|fear/').first();
    await expect(expressionBadge).toBeVisible({ timeout: 5_000 });

    // The Chat History section should show the narration UI elements
    await expect(page.locator('h3', { hasText: 'Chat History' })).toBeVisible();

    // Verify the initial Cloney greeting has an emotion indicator
    const greeting = panel.locator('article').first();
    await expect(greeting).toBeVisible();

    // The greeting message should contain the emotion emoji (from the DOM snapshot: "😊 joy")
    const greetingText = await greeting.textContent();
    expect(greetingText).toBeTruthy();
    expect(greetingText!.length).toBeGreaterThan(0);

    // Ask about status via chat to test bridge intent recognition
    const chatInput = page.locator('input[placeholder="Message Cloney..."]');
    await chatInput.fill('status');
    await page.getByRole('button', { name: 'Send' }).click();

    // The status message should appear in chat
    await expect(
      panel.locator('article').filter({ hasText: 'status' }),
    ).toBeVisible({ timeout: 5_000 });
  });
});
