import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as zlib from 'zlib';

const { Given, When, Then, Before } = createBdd();

const FRONTEND_URL = process.env.FRONTEND_URL ?? 'http://localhost:4300';
const INSECURE_FRONTEND_URL = process.env.INSECURE_FRONTEND_URL ?? 'http://host.docker.internal:4300';
const ECM_REPO_DIR = process.env.ECM_REPO_DIR ?? '.';

let ctx: Record<string, any> = {};

Before({ tags: '@security' }, async () => {
  ctx = {};
});

function createTestPng(width: number = 100, height: number = 100): Buffer {
  // Create a minimal valid PNG (solid red)
  const signature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  
  // IHDR chunk
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData.writeUInt8(8, 8); // bit depth
  ihdrData.writeUInt8(2, 9); // color type (RGB)
  ihdrData.writeUInt8(0, 10); // compression
  ihdrData.writeUInt8(0, 11); // filter
  ihdrData.writeUInt8(0, 12); // interlace
  
  const ihdrType = Buffer.from('IHDR');
  const ihdrCrc = crc32(Buffer.concat([ihdrType, ihdrData]));
  const ihdrLength = Buffer.alloc(4);
  ihdrLength.writeUInt32BE(13, 0);
  const ihdrCrcBuf = Buffer.alloc(4);
  ihdrCrcBuf.writeUInt32BE(ihdrCrc, 0);
  
  // IDAT chunk (compressed image data)
  const rawData: number[] = [];
  for (let y = 0; y < height; y++) {
    rawData.push(0); // filter byte
    for (let x = 0; x < width; x++) {
      rawData.push(255, 0, 0); // RGB red
    }
  }
  const compressed = zlib.deflateSync(Buffer.from(rawData));
  const idatType = Buffer.from('IDAT');
  const idatCrc = crc32(Buffer.concat([idatType, compressed]));
  const idatLength = Buffer.alloc(4);
  idatLength.writeUInt32BE(compressed.length, 0);
  const idatCrcBuf = Buffer.alloc(4);
  idatCrcBuf.writeUInt32BE(idatCrc, 0);
  
  // IEND chunk
  const iendType = Buffer.from('IEND');
  const iendCrc = crc32(iendType);
  const iendLength = Buffer.alloc(4);
  iendLength.writeUInt32BE(0, 0);
  const iendCrcBuf = Buffer.alloc(4);
  iendCrcBuf.writeUInt32BE(iendCrc, 0);
  
  return Buffer.concat([
    signature,
    ihdrLength, ihdrType, ihdrData, ihdrCrcBuf,
    idatLength, idatType, compressed, idatCrcBuf,
    iendLength, iendType, iendCrcBuf
  ]);
}

function crc32(buf: Buffer): number {
  let crc = 0xFFFFFFFF;
  const table: number[] = [];
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c;
  }
  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// XSS Testing Steps

Given('I open the Editor page with file picker overrides for XSS testing', async ({ page }) => {
  await page.addInitScript('delete window.showSaveFilePicker; delete window.showOpenFilePicker;');
  await page.goto(`${FRONTEND_URL}/editor/`);
  await expect(page).toHaveTitle(/Editor/);
});

When('I create a catalog with XSS payload name {string}', async ({ page }, xssName: string) => {
  ctx.xssPayload = xssName;
  page.once('dialog', async (dialog) => {
    await dialog.accept(xssName);
  });
  await page.locator('#btn-new').click();
  await expect(page.locator('#btn-add-image')).toBeEnabled();
});

When('I add a test image for XSS testing', async ({ page }) => {
  const tmpDir = os.tmpdir();
  const imagePath = path.join(tmpDir, `xss-test-${Date.now()}.png`);
  const pngBuffer = createTestPng(200, 200);
  fs.writeFileSync(imagePath, pngBuffer);
  ctx.xssImagePath = imagePath;
  
  await page.locator('#file-image').setInputFiles(imagePath);
  await expect(page.locator('#stage-img')).toBeAttached();
});

When('I place a hotspot for XSS testing at offset {int}, {int}', async ({ page }, x: number, y: number) => {
  const stageImg = page.locator('#stage-img');
  const box = await stageImg.boundingBox();
  expect(box).toBeTruthy();
  await page.mouse.click(box!.x + x, box!.y + y);
  await expect(page.locator('#form-link')).toBeVisible();
});

When('I fill the link form with XSS payload name {string} and address {string}', async ({ page }, xssLinkName: string, address: string) => {
  ctx.xssLinkName = xssLinkName;
  await page.locator('#form-link input[name="name"]').fill(xssLinkName);
  await page.locator('#form-link input[name="url"]').fill(address);
  await page.locator('#form-link button[type="submit"]').click();
  await expect(page.locator('#form-row')).toBeVisible();
});

When('I fill the row form with XSS payload name {string} and SKU {string}', async ({ page }, xssRowName: string, xssSku: string) => {
  ctx.xssRowName = xssRowName;
  ctx.xssSku = xssSku;
  await page.locator('#form-row input[name="name"]').fill(xssRowName);
  await page.locator('#form-row input[name="sku"]').fill(xssSku);
  await page.locator('#form-row button[type="submit"]').click();
  await expect(page.locator('tr[data-row-id]')).toBeVisible();
});

Then('the XSS payload should not execute', async ({ page }) => {
  const xssExecuted = await page.evaluate(() => (window as any).__xss);
  expect(xssExecuted).toBeUndefined();
});

Then('the XSS text should be visible literally in the page', async ({ page }) => {
  const pageContent = await page.content();
  // The XSS payload text should appear as escaped text, not as executable HTML
  // Check that the literal text is somewhere in the page (escaped)
  const bodyText = await page.locator('body').textContent();
  // At least one of our XSS payloads should be visible as literal text
  const hasLiteralXss = bodyText?.includes('<img') || bodyText?.includes('<script') || bodyText?.includes('onerror');
  expect(hasLiteralXss).toBeTruthy();
});

// Malicious URL Testing Steps

// Remote URL Testing Steps

Given('I open the Editor page with file picker overrides for remote URL testing', async ({ page }) => {
  await page.addInitScript('delete window.showSaveFilePicker; delete window.showOpenFilePicker;');
  await page.goto(`${FRONTEND_URL}/editor/`);
  await expect(page).toHaveTitle(/Editor/);
});

When('I attempt to copy a remote catalog from a file URL {string}', async ({ page }, fileUrl: string) => {
  await page.locator('#btn-copy-remote').click();
  await page.locator('#remote-url-input').fill(fileUrl);
  await page.locator('#remote-submit').click();
});

// Brute Force Testing Steps

Then('the remote copy should be rejected with the error {string}', async ({ page }, message: string) => {
  await expect(page.locator('.error').filter({ hasText: message })).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#remote-url-input')).toBeVisible();
});

Then('no catalog should be opened', async ({ page }) => {
  await expect(page.locator('#btn-add-image')).toBeDisabled();
});
