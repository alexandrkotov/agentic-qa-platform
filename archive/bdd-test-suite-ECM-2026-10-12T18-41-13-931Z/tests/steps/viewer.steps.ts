import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';

const { Given, When, Then, Before } = createBdd();

const FRONTEND_URL = process.env.FRONTEND_URL ?? 'http://localhost:4300';

let ctx: Record<string, any> = {};

Before({ tags: '@viewer' }, async () => {
  ctx = {};
});

Given('I open the Viewer with the furniture demo catalog', async ({ page }) => {
  await page.addInitScript('delete window.showSaveFilePicker; delete window.showOpenFilePicker;');
  await page.goto(`${FRONTEND_URL}/viewer/?src=/demo/furniture.ecatm`);
  await page.waitForSelector('tr[data-url]');
});

Given('I open the Viewer with the living-room demo catalog', async ({ page }) => {
  await page.addInitScript('delete window.showSaveFilePicker; delete window.showOpenFilePicker;');
  await page.goto(`${FRONTEND_URL}/viewer/?src=/demo/living-room.ecatm`);
  await page.waitForSelector('.hotspot[data-id]');
  ctx.initialImageSrc = await page.locator('#stage-img').getAttribute('src');
});

Given('I open the Viewer with the quiz demo catalog', async ({ page }) => {
  await page.addInitScript('delete window.showSaveFilePicker; delete window.showOpenFilePicker;');
  await page.goto(`${FRONTEND_URL}/viewer/?src=/demo/quiz-cell-biology-en.ecatm`);
  await page.waitForLoadState('networkidle');
});

Given('I open the Viewer with the protected demo catalog', async ({ page }) => {
  await page.addInitScript('delete window.showSaveFilePicker; delete window.showOpenFilePicker;');
  await page.goto(`${FRONTEND_URL}/viewer/?src=/demo/diy-stool-en.ecatm`);
  await page.waitForSelector('#lock-password');
});

When('I open the search panel in the Viewer', async ({ page }) => {
  await page.click('#btn-search');
  await page.waitForSelector('#search-input');
});

When('I search for {string} in the Viewer', async ({ page }, searchTerm: string) => {
  await page.fill('#search-input', searchTerm);
});

When('I change the search field filter to {string}', async ({ page }, filterOption: string) => {
  await page.selectOption('#search-field', { label: filterOption });
});

Then('the search results should contain {string}', async ({ page }, expectedResult: string) => {
  const searchResults = page.locator('.search-results');
  await expect(searchResults).toContainText(expectedResult);
});

When('I add the first item to the cart in the Viewer', async ({ page }) => {
  await page.locator('button.buy-btn').first().click();
});

When('I add the second item to the cart in the Viewer', async ({ page }) => {
  await page.locator('button.buy-btn').nth(1).click();
});

Then('the cart button should show {string}', async ({ page }, expectedText: string) => {
  await expect(page.locator('#btn-cart')).toHaveText(expectedText);
});

Then('the first buy button should show {string}', async ({ page }, expectedText: string) => {
  await expect(page.locator('button.buy-btn').first()).toHaveText(expectedText);
});

When('I open the cart dropdown in the Viewer', async ({ page }) => {
  await page.click('#btn-cart');
  await page.waitForSelector('.cart-remove-btn');
});

Then('the cart should contain {int} items with remove buttons', async ({ page }, count: number) => {
  const removeButtons = page.locator('.cart-remove-btn');
  await expect(removeButtons).toHaveCount(count);
});

Then('the checkout button should show {string}', async ({ page }, expectedText: string) => {
  await expect(page.locator('#cart-checkout')).toHaveText(expectedText);
});

When('I click the Clear cart button', async ({ page }) => {
  await page.click('#cart-clear');
});

When('I click on the first hotspot in the Viewer', async ({ page }) => {
  const hotspot = page.locator('.hotspot[data-id]').first();
  await hotspot.click();
  const dataId = await hotspot.getAttribute('data-id');
  ctx.clickedHotspotId = dataId;
});

Then('the corresponding table row should be selected', async ({ page }) => {
  const selectedRow = page.locator('tr.selected');
  await expect(selectedRow).toBeVisible();
});

When('I click on the table row with address {string}', async ({ page }, address: string) => {
  await page.click(`tr[data-url='${address}']`);
});

Then('the hotspot for address {string} should be highlighted', async ({ page }, address: string) => {
  const row = page.locator(`tr[data-url='${address}']`);
  await expect(row).toHaveClass(/selected/);
});

When('I click on a navigation hotspot in the Viewer', async ({ page }) => {
  const hotspot = page.locator('.hotspot[data-id]').first();
  await hotspot.click();
  await page.waitForTimeout(500);
});

Then('a different image should be loaded in the Viewer', async ({ page }) => {
  const currentImageSrc = await page.locator('#stage-img').getAttribute('src');
  expect(currentImageSrc).not.toBe(ctx.initialImageSrc);
});

Then('the quiz catalog should be rendered with questions visible', async ({ page }) => {
  const stageImg = page.locator('#stage-img');
  await expect(stageImg).toBeVisible();
});

Then('the quiz should be interactive with clickable answer options', async ({ page }) => {
  const tableRows = page.locator('tr[data-url]');
  const count = await tableRows.count();
  expect(count).toBeGreaterThan(0);
});

Then('the password unlock form should be visible', async ({ page }) => {
  await expect(page.locator('#lock-password')).toBeVisible();
  await expect(page.locator('#lock-submit')).toBeVisible();
});

When('I enter the wrong password {string} in the Viewer', async ({ page }, password: string) => {
  await page.fill('#lock-password', password);
});

When('I click the Unlock button in the Viewer', async ({ page }) => {
  await page.click('#lock-submit');
});

Then('the error message should show {string}', async ({ page }, expectedError: string) => {
  const errorElement = page.locator('.error');
  await expect(errorElement).toContainText(expectedError);
});

Then('no table rows should be visible in the Viewer', async ({ page }) => {
  const tableRows = page.locator('tr[data-url]');
  await expect(tableRows).toHaveCount(0);
});
