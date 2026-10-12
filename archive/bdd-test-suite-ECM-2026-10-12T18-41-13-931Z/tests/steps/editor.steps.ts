import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as zlib from 'zlib';

const { Given, When, Then, Before } = createBdd();

const FRONTEND_URL = process.env.FRONTEND_URL ?? 'http://localhost:4300';

let ctx: Record<string, any> = {};

const INSECURE_FRONTEND_URL = process.env.INSECURE_FRONTEND_URL ?? 'http://host.docker.internal:4300';

Before({ tags: '@editor' }, async () => {
  ctx = {};
});

function createTestImage(): string {
  // Create a valid 400x300 PNG (the size ECM's own e2e uses: a hotspot click needs room inside the image)
  const pngSignature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(400, 0); // width
  ihdrData.writeUInt32BE(300, 4); // height
  ihdrData.writeUInt8(8, 8); // bit depth
  ihdrData.writeUInt8(2, 9); // color type (RGB)
  ihdrData.writeUInt8(0, 10); // compression
  ihdrData.writeUInt8(0, 11); // filter
  ihdrData.writeUInt8(0, 12); // interlace
  
  function crc32(buf: Buffer): number {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) {
      crc ^= buf[i];
      for (let j = 0; j < 8; j++) {
        crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
      }
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }
  
  function makeChunk(type: string, data: Buffer): Buffer {
    const typeBuffer = Buffer.from(type, 'ascii');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const crcInput = Buffer.concat([typeBuffer, data]);
    const crcValue = Buffer.alloc(4);
    crcValue.writeUInt32BE(crc32(crcInput), 0);
    return Buffer.concat([length, typeBuffer, data, crcValue]);
  }
  
  const ihdrChunk = makeChunk('IHDR', ihdrData);
  
  // IDAT: 300 scanlines, each = filter byte (0) + 400 RGB pixels
  const scanline = Buffer.concat([Buffer.from([0]), Buffer.alloc(400 * 3, 0x90)]);
  const rawData = Buffer.concat(Array.from({ length: 300 }, () => scanline));
  const compressed = zlib.deflateSync(rawData);
  const idatChunk = makeChunk('IDAT', compressed);
  
  const iendChunk = makeChunk('IEND', Buffer.alloc(0));
  
  const pngBuffer = Buffer.concat([pngSignature, ihdrChunk, idatChunk, iendChunk]);
  
  const tmpDir = os.tmpdir();
  const imagePath = path.join(tmpDir, `test-image-${Date.now()}.png`);
  fs.writeFileSync(imagePath, pngBuffer);
  return imagePath;
}

Given('I open the Editor page with file picker overrides', async ({ page }) => {
  await page.addInitScript('delete window.showSaveFilePicker; delete window.showOpenFilePicker;');
  await page.goto(`${FRONTEND_URL}/editor/`);
  await expect(page).toHaveTitle(/Editor/);
});

When('I click the New catalog button and accept the prompt with {string}', async ({ page }, catalogName: string) => {
  ctx.catalogName = catalogName;
  page.once('dialog', async (dialog) => {
    await dialog.accept(catalogName);
  });
  await page.click('#btn-new');
  // Wait for the prompt to be handled
  await page.waitForTimeout(500);
});

When('I add an image file to the catalog', async ({ page }) => {
  const imagePath = createTestImage();
  ctx.imagePath = imagePath;
  
  // Wait for the add image button to be enabled
  await expect(page.locator('#btn-add-image')).toBeEnabled({ timeout: 5000 });
  
  // Set the file on the hidden input
  await page.locator('#file-image').setInputFiles(imagePath);
  
  // Wait for image to appear
  await expect(page.locator('#stage-img')).toBeAttached({ timeout: 5000 });
});

When('I click inside the image to place a hotspot at offset {int}, {int}', async ({ page }, offsetX: number, offsetY: number) => {
  const stageImg = page.locator('#stage-img');
  await expect(stageImg).toBeVisible();
  
  const box = await stageImg.boundingBox();
  if (!box) throw new Error('Could not get stage image bounding box');
  
  // Click at the specified offset within the image
  await page.mouse.click(box.x + offsetX, box.y + offsetY);
  
  // Wait for the link form to appear
  await expect(page.locator('#form-link')).toBeVisible({ timeout: 5000 });
});

When('I fill the link form with name {string} and address {string}', async ({ page }, name: string, address: string) => {
  ctx.lastLinkName = name;
  ctx.lastAddress = address;
  
  await page.locator('#form-link input[name=name]').fill(name);
  await page.locator('#form-link input[name=url]').fill(address);
  await page.locator('#form-link button[type=submit]').click();
  
  // Wait for the row form to appear
  await expect(page.locator('#form-row')).toBeVisible({ timeout: 5000 });
});

When('I fill the table row form with name {string} and SKU {string}', async ({ page }, name: string, sku: string) => {
  ctx.lastSku = sku;
  
  await page.locator('#form-row input[name=name]').fill(name);
  await page.locator('#form-row input[name=sku]').fill(sku);
  await page.locator('#form-row button[type=submit]').click();
  
  // Wait for the row to be created
  await expect(page.locator(`tr[data-row-id]`).first()).toBeVisible({ timeout: 5000 });
});

When('I save the catalog', async ({ page }) => {
  // Set up download listener
  const downloadPromise = page.waitForEvent('download');
  
  await page.click('#btn-save');
  
  const download = await downloadPromise;
  ctx.downloadedFileName = download.suggestedFilename();
  
  // Save to temp location for verification
  const savePath = path.join(os.tmpdir(), ctx.downloadedFileName);
  await download.saveAs(savePath);
  ctx.savedFilePath = savePath;
});

Then('the catalog should be saved as {string}', async ({}, expectedFileName: string) => {
  expect(ctx.downloadedFileName).toBe(expectedFileName);
  
  // Verify it's a SQLite database
  const fileContent = fs.readFileSync(ctx.savedFilePath);
  const header = fileContent.slice(0, 15).toString('utf8');
  expect(header).toBe('SQLite format 3');
});

Then('the hotspot should appear on the image', async ({ page }) => {
  const hotspots = page.locator('#stage-inner .hotspot:not(.pending)');
  await expect(hotspots.first()).toBeVisible();
});

Then('the table row {string} should be visible', async ({ page }, sku: string) => {
  // Look for the SKU in any table row
  const rows = page.locator('tr[data-row-id]');
  const rowCount = await rows.count();
  expect(rowCount).toBeGreaterThan(0);
  
  // Check that at least one row contains the SKU text
  const pageContent = await page.content();
  expect(pageContent).toContain(sku);
});

When('I click on the hotspot to select it', async ({ page }) => {
  const hotspot = page.locator('#stage-inner .hotspot:not(.pending)').first();
  await expect(hotspot).toBeVisible();
  await hotspot.click();
});

When('I drag the hotspot to a new position at offset {int}, {int}', async ({ page }, offsetX: number, offsetY: number) => {
  const hotspot = page.locator('#stage-inner .hotspot:not(.pending)').first();
  const stageImg = page.locator('#stage-img');
  
  const hotspotBox = await hotspot.boundingBox();
  const stageBox = await stageImg.boundingBox();
  
  if (!hotspotBox || !stageBox) throw new Error('Could not get bounding boxes');
  
  // Drag from hotspot center to new position
  ctx.dragFrom = { x: hotspotBox.x, y: hotspotBox.y };
  const startX = hotspotBox.x + hotspotBox.width / 2;
  const startY = hotspotBox.y + hotspotBox.height / 2;
  const endX = stageBox.x + offsetX;
  const endY = stageBox.y + offsetY;
  
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(endX, endY);
  await page.mouse.up();
});

Then('the document title should indicate unsaved changes', async ({ page }) => {
  await expect(page).toHaveTitle(/^● /);
});

When('I press undo', async ({ page }) => {
  await page.keyboard.press('Control+z');
});

When('I press redo', async ({ page }) => {
  await page.keyboard.press('Control+Shift+z');
});

Then('the Editor should remain functional with title containing {string}', async ({ page }, titlePart: string) => {
  await expect(page).toHaveTitle(new RegExp(titlePart));
});

Then('the New catalog button should still be visible', async ({ page }) => {
  await expect(page.locator('#btn-new')).toBeVisible();
});

function createTestPng(width: number, height: number): Buffer {
  // Create a minimal valid PNG with solid color
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  
  // IHDR chunk
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData.writeUInt8(8, 8);  // bit depth
  ihdrData.writeUInt8(2, 9);  // color type (RGB)
  ihdrData.writeUInt8(0, 10); // compression
  ihdrData.writeUInt8(0, 11); // filter
  ihdrData.writeUInt8(0, 12); // interlace
  
  const ihdrCrc = crc32(Buffer.concat([Buffer.from('IHDR'), ihdrData]));
  const ihdrChunk = Buffer.concat([
    Buffer.from([0, 0, 0, 13]), // length
    Buffer.from('IHDR'),
    ihdrData,
    ihdrCrc
  ]);
  
  // IDAT chunk - create raw image data
  const rawData: number[] = [];
  for (let y = 0; y < height; y++) {
    rawData.push(0); // filter byte
    for (let x = 0; x < width; x++) {
      rawData.push(100, 150, 200); // RGB
    }
  }
  const compressed = zlib.deflateSync(Buffer.from(rawData));
  const idatCrc = crc32(Buffer.concat([Buffer.from('IDAT'), compressed]));
  const idatLenBuf = Buffer.alloc(4);
  idatLenBuf.writeUInt32BE(compressed.length, 0);
  const idatChunk = Buffer.concat([
    idatLenBuf,
    Buffer.from('IDAT'),
    compressed,
    idatCrc
  ]);
  
  // IEND chunk
  const iendCrc = crc32(Buffer.from('IEND'));
  const iendChunk = Buffer.concat([
    Buffer.from([0, 0, 0, 0]),
    Buffer.from('IEND'),
    iendCrc
  ]);
  
  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

function crc32(data: Buffer): Buffer {
  let crc = 0xffffffff;
  const table: number[] = [];
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c;
  }
  for (let i = 0; i < data.length; i++) {
    crc = table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  crc = crc ^ 0xffffffff;
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(crc >>> 0, 0);
  return buf;
}

Given('I open the Editor page on an insecure context with file picker overrides', async ({ page }) => {
  await page.addInitScript('delete window.showSaveFilePicker; delete window.showOpenFilePicker;');
  await page.goto(`${INSECURE_FRONTEND_URL}/editor/`);
  await expect(page).toHaveTitle(/Editor/);
});

When('I create a new catalog named {string} via prompt', async ({ page }, catalogName: string) => {
  ctx.catalogName = catalogName;
  page.once('dialog', async (dialog) => {
    await dialog.accept(catalogName);
  });
  await page.locator('#btn-new').click();
  await expect(page.locator('#btn-add-image')).toBeEnabled();
});

When('I add a test image to the catalog', async ({ page }) => {
  const tmpDir = os.tmpdir();
  const imgPath = path.join(tmpDir, `test-image-${Date.now()}.png`);
  const pngData = createTestPng(200, 200);
  fs.writeFileSync(imgPath, pngData);
  ctx.testImagePath = imgPath;
  
  await page.locator('#file-image').setInputFiles(imgPath);
  await expect(page.locator('#stage-img')).toBeAttached();
});

When('I click the Export protected button', async ({ page }) => {
  await page.locator('#btn-export-protected').click();
  await expect(page.locator('#protect-password')).toBeVisible();
});

When('I fill the protection password fields with {string}', async ({ page }, password: string) => {
  await page.locator('#protect-password').fill(password);
  await page.locator('#protect-repeat').fill(password);
});

When('I click the Protect and download button', async ({ page }) => {
  const downloadPromise = page.waitForEvent('download', { timeout: 3000 }).catch(() => null);
  await page.locator('#protect-submit').click();
  ctx.downloadResult = await downloadPromise;
});

Then('no protected catalog file should be downloaded', async () => {
  expect(ctx.downloadResult).toBeNull();
});

Then('the Editor should still be functional', async ({ page }) => {
  await expect(page).toHaveTitle(/Editor/);
  await expect(page.locator('#btn-new')).toBeVisible();
});

Given('I open the Editor page with file picker overrides for unsaved changes test', async ({ page }) => {
  await page.addInitScript('delete window.showSaveFilePicker; delete window.showOpenFilePicker;');
  await page.goto(`${FRONTEND_URL}/editor/`);
  await expect(page).toHaveTitle(/Editor/);
});

When('I place a hotspot at offset {int}, {int} on the image', async ({ page }, x: number, y: number) => {
  const stageImg = page.locator('#stage-img');
  await expect(stageImg).toBeVisible();
  const box = await stageImg.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.click(box!.x + x, box!.y + y);
  await expect(page.locator('#form-link')).toBeVisible();
});

When('I fill the hotspot link form with name {string} and address {string}', async ({ page }, name: string, address: string) => {
  await page.locator('#form-link input[name="name"]').fill(name);
  await page.locator('#form-link input[name="url"]').fill(address);
  await page.locator('#form-link button[type="submit"]').click();
  await expect(page.locator('#form-row')).toBeVisible();
});

When('I fill the hotspot row form with name {string} and SKU {string}', async ({ page }, name: string, sku: string) => {
  await page.locator('#form-row input[name="name"]').fill(name);
  await page.locator('#form-row input[name="sku"]').fill(sku);
  await page.locator('#form-row button[type="submit"]').click();
});

Then('the document title should start with the unsaved changes marker', async ({ page }) => {
  await expect(page).toHaveTitle(/^● /);
});

When('I attempt to close the page with beforeunload handling', async ({ page }) => {
  ctx.beforeunloadTriggered = false;
  page.once('dialog', async (dialog) => {
    if (dialog.type() === 'beforeunload') {
      ctx.beforeunloadTriggered = true;
      await dialog.dismiss();
    }
  });
  await page.close({ runBeforeUnload: true }).catch(() => {
    // Page close may be cancelled by dialog dismissal
  });
});

Then('a beforeunload dialog should be triggered', async () => {
  await expect.poll(() => ctx.beforeunloadTriggered, { timeout: 5000 }).toBe(true);
});

Given('I open the Editor page with file picker overrides for large image test', async ({ page }) => {
  await page.addInitScript('delete window.showSaveFilePicker; delete window.showOpenFilePicker;');
  await page.goto(`${FRONTEND_URL}/editor/`);
  await expect(page).toHaveTitle(/Editor/);
});

When('I upload a large test image of {int}x{int} pixels', async ({ page }, width: number, height: number) => {
  const tmpDir = os.tmpdir();
  const imgPath = path.join(tmpDir, `large-image-${Date.now()}.png`);
  const pngData = createTestPng(width, height);
  fs.writeFileSync(imgPath, pngData);
  ctx.largeImagePath = imgPath;
  
  await page.locator('#file-image').setInputFiles(imgPath);
  await page.waitForSelector('#stage-img', { state: 'attached', timeout: 30000 });
});

const firstSavedHotspot = (page: import('@playwright/test').Page) => page.locator('#stage-inner .hotspot:not(.pending)').first();

const hotspotDistanceFrom = async (page: import('@playwright/test').Page, point: { x: number; y: number }) => {
  const box = await firstSavedHotspot(page).boundingBox();
  return box ? Math.hypot(box.x - point.x, box.y - point.y) : Number.POSITIVE_INFINITY;
};

Then('the hotspot should be marked as being edited', async ({ page }) => {
  await expect(firstSavedHotspot(page)).toHaveClass(/\bediting\b/, { timeout: 5000 });
});

Then('the hotspot should have moved from its original position', async ({ page }) => {
  await expect.poll(() => hotspotDistanceFrom(page, ctx.dragFrom), { timeout: 5000 }).toBeGreaterThan(20);
  const box = await firstSavedHotspot(page).boundingBox();
  ctx.dragTo = { x: box!.x, y: box!.y };
});

Then('the hotspot should be back at its original position', async ({ page }) => {
  await expect.poll(() => hotspotDistanceFrom(page, ctx.dragFrom), { timeout: 5000 }).toBeLessThan(3);
});

Then('the hotspot should be at the moved position again', async ({ page }) => {
  await expect.poll(() => hotspotDistanceFrom(page, ctx.dragTo), { timeout: 5000 }).toBeLessThan(3);
});

When('I submit the link form with name {string} and address {string}', async ({ page }, name: string, address: string) => {
  await page.locator('#form-link input[name=name]').fill(name);
  await page.locator('#form-link input[name=url]').fill(address);
  await page.locator('#form-link button[type=submit]').click();
});

Then('the link form should remain open', async ({ page }) => {
  await expect(page.locator('#form-link')).toBeVisible();
});

Then('the row form should not appear', async ({ page }) => {
  await expect(page.locator('#form-row')).toBeHidden();
});

Then('the number of saved hotspots on the diagram should be {int}', async ({ page }, expected: number) => {
  await expect(page.locator('#stage-inner .hotspot:not(.pending)')).toHaveCount(expected);
});

Then('the Add image button should be disabled', async ({ page }) => {
  await expect(page.locator('#btn-add-image')).toBeDisabled();
});

Then('the Add image button should be enabled', async ({ page }) => {
  await expect(page.locator('#btn-add-image')).toBeEnabled();
});

Then('the image list should contain {int} image', async ({ page }, expected: number) => {
  await expect(page.locator('.image-list-name')).toHaveCount(expected);
});
