import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as zlib from 'zlib';

const { Given, When, Then, Before } = createBdd();

const FRONTEND_URL = process.env.FRONTEND_URL ?? 'http://localhost:4300';

let ctx: Record<string, any> = {};

Before({ tags: '@composer' }, async () => {
  ctx = {};
});

function createTestPng(width: number = 100, height: number = 100): Buffer {
  // Create a minimal valid PNG with solid red color
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  
  // IHDR chunk
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData.writeUInt8(8, 8); // bit depth
  ihdrData.writeUInt8(2, 9); // color type (RGB)
  ihdrData.writeUInt8(0, 10); // compression
  ihdrData.writeUInt8(0, 11); // filter
  ihdrData.writeUInt8(0, 12); // interlace
  const ihdrCrc = crc32(Buffer.concat([Buffer.from('IHDR'), ihdrData]));
  const ihdr = Buffer.concat([
    Buffer.from([0, 0, 0, 13]),
    Buffer.from('IHDR'),
    ihdrData,
    uint32Buffer(ihdrCrc)
  ]);

  // IDAT chunk - raw image data
  const rawData: number[] = [];
  for (let y = 0; y < height; y++) {
    rawData.push(0); // filter byte
    for (let x = 0; x < width; x++) {
      rawData.push(255, 0, 0); // RGB red
    }
  }
  const compressed = zlib.deflateSync(Buffer.from(rawData));
  const idatCrc = crc32(Buffer.concat([Buffer.from('IDAT'), compressed]));
  const idat = Buffer.concat([
    uint32Buffer(compressed.length),
    Buffer.from('IDAT'),
    compressed,
    uint32Buffer(idatCrc)
  ]);

  // IEND chunk
  const iendCrc = crc32(Buffer.from('IEND'));
  const iend = Buffer.concat([
    Buffer.from([0, 0, 0, 0]),
    Buffer.from('IEND'),
    uint32Buffer(iendCrc)
  ]);

  return Buffer.concat([signature, ihdr, idat, iend]);
}

function uint32Buffer(val: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(val >>> 0, 0);
  return buf;
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  const table = makeCrcTable();
  for (let i = 0; i < data.length; i++) {
    crc = table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeCrcTable(): number[] {
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
}

function createCsv(rows: { no: number; folder: string; name: string; sku: string; description: string }[]): string {
  const header = 'No.,Folder,Name,SKU,Description';
  const lines = rows.map(r => `${r.no},${r.folder},${r.name},${r.sku},${r.description}`);
  return [header, ...lines].join('\n');
}

Given('I open the Grid Composer page', async ({ page }) => {
  await page.goto(`${FRONTEND_URL}/composer/`);
  await expect(page.locator('h1')).toContainText('ECM Grid Composer');
});

When('I set the catalog name to {string}', async ({ page }, name: string) => {
  await page.locator('#name').fill(name);
});

When('I set the tiles per row to {string}', async ({ page }, tiles: string) => {
  await page.locator('#columns').selectOption(tiles);
});

When('I upload {int} test photos for the Grid Composer', async ({ page }, count: number) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'composer-photos-'));
  ctx.photoDir = tmpDir;
  const files: string[] = [];
  for (let i = 1; i <= count; i++) {
    const filePath = path.join(tmpDir, `${i}.png`);
    fs.writeFileSync(filePath, createTestPng());
    files.push(filePath);
  }
  await page.locator('#photo-files').setInputFiles(files);
});

When('I upload a CSV table with {int} matching rows for the Grid Composer', async ({ page }, count: number) => {
  const rows = [];
  for (let i = 1; i <= count; i++) {
    rows.push({
      no: i,
      folder: '',
      name: `Item ${i}`,
      sku: `SKU-${i}`,
      description: `Description for item ${i}`
    });
  }
  const csvContent = createCsv(rows);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'composer-csv-'));
  const csvPath = path.join(tmpDir, 'table.csv');
  fs.writeFileSync(csvPath, csvContent);
  ctx.csvPath = csvPath;
  await page.locator('#table-file').setInputFiles(csvPath);
});

When('I upload a CSV table with {int} rows but no photos for the Grid Composer', async ({ page }, count: number) => {
  const rows = [];
  for (let i = 1; i <= count; i++) {
    rows.push({
      no: i,
      folder: '',
      name: `Item ${i}`,
      sku: `SKU-${i}`,
      description: `Description for item ${i}`
    });
  }
  const csvContent = createCsv(rows);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'composer-csv-nophoto-'));
  const csvPath = path.join(tmpDir, 'table.csv');
  fs.writeFileSync(csvPath, csvContent);
  await page.locator('#table-file').setInputFiles(csvPath);
});

When('I upload {int} test photos numbered {int} and {int} for the Grid Composer', async ({ page }, count: number, num1: number, num2: number) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'composer-photos-mismatch-'));
  const files: string[] = [];
  const numbers = [num1, num2];
  for (const n of numbers) {
    const filePath = path.join(tmpDir, `${n}.png`);
    fs.writeFileSync(filePath, createTestPng());
    files.push(filePath);
  }
  await page.locator('#photo-files').setInputFiles(files);
});

When('I upload a CSV table with rows numbered {int}, {int}, {int} for the Grid Composer', async ({ page }, num1: number, num2: number, num3: number) => {
  const rows = [num1, num2, num3].map(n => ({
    no: n,
    folder: '',
    name: `Item ${n}`,
    sku: `SKU-${n}`,
    description: `Description for item ${n}`
  }));
  const csvContent = createCsv(rows);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'composer-csv-mismatch-'));
  const csvPath = path.join(tmpDir, 'table.csv');
  fs.writeFileSync(csvPath, csvContent);
  await page.locator('#table-file').setInputFiles(csvPath);
});

When('I click the Build catalog button', async ({ page }) => {
  await page.locator('#build').click();
});

Then('the photo status should show {string}', async ({ page }, expected: string) => {
  await expect(page.locator('.status').first()).toContainText(expected);
});

Then('the table status should show {string}', async ({ page }, expected: string) => {
  await expect(page.locator('.status').nth(1)).toContainText(expected);
});

Then('the report should show {string}', async ({ page }, expected: string) => {
  await expect(page.locator('.box.ok')).toContainText(expected);
});

Then('the report should show a warning about missing photos for rows {int}, {int}, {int}', async ({ page }, row1: number, row2: number, row3: number) => {
  const warnBox = page.locator('.box.warn');
  await expect(warnBox).toBeVisible();
  const text = await warnBox.textContent();
  expect(text).toContain('No photo for No.');
  expect(text).toContain(String(row1));
  expect(text).toContain(String(row2));
  expect(text).toContain(String(row3));
});

Then('the report should show a warning about missing photos for rows {int} and {int}', async ({ page }, row1: number, row2: number) => {
  const warnBox = page.locator('.box.warn');
  await expect(warnBox).toBeVisible();
  const text = await warnBox.textContent();
  expect(text).toContain('No photo for No.');
  expect(text).toContain(String(row1));
  expect(text).toContain(String(row2));
});

Then('the download link for the catalog should be visible', async ({ page }) => {
  await expect(page.locator('a.btn.primary')).toContainText('Download .ecatm');
});
