import { test, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const API_BASE = 'http://localhost:3001';
const FIXTURE_IMAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/test-screenshot.png');

test.describe('ST-2: Backend API', () => {
  test('ST-2.1 server is reachable', async ({ request }) => {
    const res = await request.get(`${API_BASE}/api/health`);
    expect(res.ok()).toBe(true);
  });

  test('ST-2.2 health check returns expected JSON', async ({ request }) => {
    const res = await request.get(`${API_BASE}/api/health`);
    const body = await res.json();
    expect(body).toEqual({ status: 'ok', version: '1.0.0' });
  });

  test('ST-2.3 upload succeeds with valid image', async ({ request }) => {
    const imageBuffer = fs.readFileSync(FIXTURE_IMAGE);

    const res = await request.post(`${API_BASE}/api/upload`, {
      multipart: {
        screenshots: {
          name: 'test-screenshot.png',
          mimeType: 'image/png',
          buffer: imageBuffer,
        },
      },
    });

    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.sessionId).toBeTruthy();
    expect(body.files).toHaveLength(1);
    expect(body.files[0].filename).toBe('test-screenshot.png');
    expect(body.files[0].mimetype).toBe('image/png');
  });

  test('ST-2.4 upload rejects non-image file', async ({ request }) => {
    const textBuffer = Buffer.from('This is not an image', 'utf-8');

    const res = await request.post(`${API_BASE}/api/upload`, {
      multipart: {
        screenshots: {
          name: 'readme.txt',
          mimeType: 'text/plain',
          buffer: textBuffer,
        },
      },
    });

    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBeTruthy();
  });

  test('ST-2.5 upload rejects oversized file', async ({ request }) => {
    // Create a buffer slightly over 10MB with valid PNG header
    const pngHeader = fs.readFileSync(FIXTURE_IMAGE).subarray(0, 8);
    const oversized = Buffer.alloc(10 * 1024 * 1024 + 1024);
    pngHeader.copy(oversized, 0);

    const res = await request.post(`${API_BASE}/api/upload`, {
      multipart: {
        screenshots: {
          name: 'huge.png',
          mimeType: 'image/png',
          buffer: oversized,
        },
      },
    });

    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBeTruthy();
  });
});
