import { test, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const FIXTURE_IMAGE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures/test-screenshot.png',
);
const API_BASE = 'http://localhost:3001';

test.describe.configure({ mode: 'serial' });

test.describe('ST-6: Export & Download', () => {
  // Export tests need a completed session - allow generous time
  test.setTimeout(600_000);

  let sessionId: string;

  test('ST-6.1 download ZIP after iteration', async ({ request, page }) => {
    // ---- Set up: upload screenshot and start a short loop via API ----
    const imageBuffer = fs.readFileSync(FIXTURE_IMAGE);

    const uploadRes = await request.post(`${API_BASE}/api/upload`, {
      multipart: {
        screenshots: {
          name: 'test-screenshot.png',
          mimeType: 'image/png',
          buffer: imageBuffer,
        },
      },
    });
    expect(uploadRes.status()).toBe(201);
    const uploadBody = await uploadRes.json();
    sessionId = uploadBody.sessionId;
    expect(sessionId).toBeTruthy();

    // Start loop with 2 max iterations for fast completion
    const loopRes = await request.post(`${API_BASE}/api/loop/start`, {
      data: {
        sessionId,
        config: {
          projectName: 'e2e-export-test',
          maxIterations: 2,
          targetScore: 99, // high target so it runs all iterations
        },
      },
    });
    expect(loopRes.status()).toBe(202);

    // ---- Wait for loop to complete ----
    const maxWaitMs = 480_000;
    const pollIntervalMs = 5_000;
    const startTime = Date.now();
    let loopState = '';

    while (Date.now() - startTime < maxWaitMs) {
      const statusRes = await request.get(`${API_BASE}/api/loop/${sessionId}/status`);
      if (statusRes.ok()) {
        const body = await statusRes.json();
        loopState = body.state;
        if (loopState === 'completed' || loopState === 'failed') {
          break;
        }
      }
      await page.waitForTimeout(pollIntervalMs);
    }

    expect(loopState).toBe('completed');

    // ---- Test HEAD request for archive metadata ----
    const headRes = await request.head(`${API_BASE}/api/loop/${sessionId}/download`);
    expect(headRes.status()).toBe(200);
    expect(headRes.headers()['content-type']).toBe('application/zip');

    const archiveName = headRes.headers()['x-archive-name'];
    expect(archiveName).toBeTruthy();
    expect(archiveName).toMatch(/^ralphton-.*\.zip$/);

    const archiveBytes = headRes.headers()['x-archive-bytes'];
    expect(Number(archiveBytes)).toBeGreaterThan(0);

    // ---- Test GET download ----
    const downloadRes = await request.get(`${API_BASE}/api/loop/${sessionId}/download`);
    expect(downloadRes.status()).toBe(200);
    expect(downloadRes.headers()['content-type']).toBe('application/zip');
    expect(downloadRes.headers()['content-disposition']).toMatch(/attachment/);

    const body = await downloadRes.body();
    expect(body.byteLength).toBeGreaterThan(0);

    // Verify ZIP magic bytes (PK\x03\x04)
    expect(body[0]).toBe(0x50); // P
    expect(body[1]).toBe(0x4b); // K
    expect(body[2]).toBe(0x03);
    expect(body[3]).toBe(0x04);
  });

  test('ST-6.2 standalone HTML renders in browser', async ({ page }) => {
    // Fetch the ZIP and extract the HTML content
    const downloadRes = await page.request.get(`${API_BASE}/api/loop/${sessionId}/download`);
    expect(downloadRes.status()).toBe(200);

    const zipBuffer = await downloadRes.body();

    // Use JSZip to extract the index.html from the ZIP
    // We do this in the browser context since JSZip is available via the app
    const htmlContent = await page.evaluate(async (zipBase64: string) => {
      // Convert base64 back to Uint8Array
      const binary = atob(zipBase64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }

      // Look for index.html in the ZIP by scanning for the filename in local file headers
      const textDecoder = new TextDecoder();
      const fullText = textDecoder.decode(bytes);

      // Search for "index.html" filename in the ZIP and extract raw content
      // This is a simplified extraction - look for the HTML between markers
      const htmlStart = fullText.indexOf('<!DOCTYPE html');
      if (htmlStart === -1) {
        const htmlAlt = fullText.indexOf('<html');
        if (htmlAlt === -1) return null;
        const htmlEnd = fullText.indexOf('</html>', htmlAlt);
        if (htmlEnd === -1) return null;
        return fullText.substring(htmlAlt, htmlEnd + 7);
      }
      const htmlEnd = fullText.indexOf('</html>', htmlStart);
      if (htmlEnd === -1) return null;
      return fullText.substring(htmlStart, htmlEnd + 7);
    }, zipBuffer.toString('base64'));

    // Verify we extracted valid HTML
    expect(htmlContent).toBeTruthy();
    expect(htmlContent).toContain('<html');
    expect(htmlContent).toContain('</html>');

    // Render the extracted HTML in a new page to verify it works
    const exportPage = await page.context().newPage();
    try {
      await exportPage.setContent(htmlContent!, { waitUntil: 'domcontentloaded' });

      // The standalone HTML should render without errors
      // Check that the body has some content
      const bodyText = await exportPage.locator('body').textContent();
      expect(bodyText!.length).toBeGreaterThan(0);
    } finally {
      await exportPage.close();
    }
  });
});
