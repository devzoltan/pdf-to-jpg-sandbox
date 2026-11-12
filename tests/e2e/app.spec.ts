import { expect, test, Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { unzipSync } from 'fflate';
import { encryptedPdf, notAPdf, numberedPdf } from '../fixtures.js';
import { decodePageNumber, ourContainers } from '../helpers.js';

async function spyObjectUrls(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __created: number; __revoked: number };
    w.__created = 0;
    w.__revoked = 0;
    const c = URL.createObjectURL.bind(URL);
    const r = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (o: Blob | MediaSource) => {
      w.__created++;
      return c(o);
    };
    URL.revokeObjectURL = (u: string) => {
      w.__revoked++;
      r(u);
    };
  });
}

test.afterEach(() => {
  expect(ourContainers()).toEqual([]);
});

test('main flow: upload 12 pages, preview, JPG and ZIP download, new PDF', async ({ page }) => {
  await spyObjectUrls(page);
  const resp = await page.goto('/');
  expect(resp!.headers()['cache-control']).toBe('no-store');
  await expect(page.getByRole('heading', { name: 'PDF to JPG' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');

  await page.setInputFiles('#file', { name: 'test-12.pdf', mimeType: 'application/pdf', buffer: await numberedPdf(12) });
  // Busy indicator; no second selection possible while processing
  await expect(page.getByRole('status')).toContainText(/Updating the processing environment|Processing/);
  await expect(page.getByRole('button', { name: 'Choose PDF' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Processing …', { timeout: 120_000 });

  await expect(page.getByRole('status')).toContainText('Done: 12 pages', { timeout: 120_000 });
  const imgs = page.locator('ol.pages img');
  await expect(imgs).toHaveCount(12);
  for (let i = 0; i < 12; i++) {
    await expect(imgs.nth(i)).toHaveAttribute('alt', `Page ${i + 1}`);
    await expect(imgs.nth(i)).toHaveAttribute('src', /^blob:/);
  }
  await expect(page.locator('figcaption').nth(11)).toContainText('Page 12 of 12');
  // Images are actually decoded (from the JPEGs)
  await imgs.nth(11).scrollIntoViewIfNeeded();
  await expect.poll(() => imgs.nth(11).evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(1000);

  // Single JPEG download (page 3)
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Download JPG' }).nth(2).click()]);
  expect(dl.suggestedFilename()).toBe('page-003.jpg');
  const jpg = await readFile((await dl.path())!);
  expect(jpg.subarray(0, 3).toString('hex')).toBe('ffd8ff');
  expect(decodePageNumber(jpg)).toBe(3);

  // ZIP built from the same result
  const [zdl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download all as ZIP' }).click()]);
  expect(zdl.suggestedFilename()).toBe('pages.zip');
  const entries = unzipSync(new Uint8Array(await readFile((await zdl.path())!)));
  const names = Object.keys(entries).sort();
  expect(names).toHaveLength(12);
  expect(names[0]).toBe('page-001.jpg');
  expect(decodePageNumber(Buffer.from(entries['page-012.jpg']!))).toBe(12);

  // Nothing is stored in the browser
  const storage = await page.evaluate(async () => ({
    ls: localStorage.length,
    ss: sessionStorage.length,
    idb: (await indexedDB.databases()).length,
    caches: (await caches.keys()).length,
    sw: (await navigator.serviceWorker.getRegistrations()).length,
  }));
  expect(storage).toEqual({ ls: 0, ss: 0, idb: 0, caches: 0, sw: 0 });

  // New PDF: the result is discarded and all object URLs are released
  await page.getByRole('button', { name: 'New PDF' }).click();
  await expect(imgs).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Choose PDF' })).toBeVisible();
  const counts = await page.evaluate(() => {
    const w = window as unknown as { __created: number; __revoked: number };
    return { created: w.__created, revoked: w.__revoked };
  });
  expect(counts.revoked).toBe(counts.created);
});

test('German UI via language switch: errors (wrong file, encrypted PDF), then a successful retry', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('group', { name: 'Language' }).getByRole('button', { name: 'DE', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'PDF zu JPG' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  await expect(page).toHaveURL(/[?&]lang=de/);
  await expect(page.getByRole('button', { name: 'PDF auswählen' })).toBeVisible();

  await page.setInputFiles('#file', { name: 'not-a-pdf.pdf', mimeType: 'application/pdf', buffer: notAPdf() });
  await expect(page.getByRole('alert')).toContainText('keine PDF-Datei');
  // Switching the language also translates a message that is already shown
  await page.getByRole('button', { name: 'EN', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('The file is not a PDF.');
  await page.getByRole('button', { name: 'DE', exact: true }).click();

  await page.setInputFiles('#file', { name: 'secret.pdf', mimeType: 'application/pdf', buffer: await encryptedPdf('user') });
  await expect(page.getByRole('status')).toContainText(/Verarbeitungsumgebung wird aktualisiert|Verarbeitung läuft/);
  await expect(page.getByRole('alert')).toContainText('verschlüsselt oder passwortgeschützt', { timeout: 120_000 });
  await expect(page.locator('body')).not.toContainText(/stack|Error:|poppler|docker/i);

  await page.setInputFiles('#file', { name: 'ok.pdf', mimeType: 'application/pdf', buffer: await numberedPdf(1) });
  await expect(page.getByRole('status')).toContainText('Fertig: 1 Seite', { timeout: 120_000 });
  await expect(page.getByRole('link', { name: 'JPG herunterladen' })).toBeVisible();

  // Language from the URL survives a reload
  await page.reload();
  await expect(page.getByRole('heading', { name: 'PDF zu JPG' })).toBeVisible();
});

test('mobile and keyboard: select via keyboard, drag & drop, no horizontal scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const noHScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
  expect(await noHScroll()).toBe(true);

  // Keyboard: Tab to the button, Enter opens the file chooser
  let focused = '';
  for (let i = 0; i < 6 && focused !== 'Choose PDF'; i++) {
    await page.keyboard.press('Tab');
    focused = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? '');
  }
  expect(focused).toBe('Choose PDF');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('Enter')]);
  expect(chooser.isMultiple()).toBe(false);
  await chooser.setFiles({ name: 'two.pdf', mimeType: 'application/pdf', buffer: await numberedPdf(2) });
  await expect(page.getByRole('status')).toContainText('Done: 2 pages', { timeout: 120_000 });
  expect(await noHScroll()).toBe(true);
  await page.getByRole('button', { name: 'New PDF' }).focus();
  await page.keyboard.press('Enter');

  // Drag & drop a file onto the drop zone
  const bytes = Array.from(await numberedPdf(3));
  const dt = await page.evaluateHandle((b) => {
    const d = new DataTransfer();
    d.items.add(new File([new Uint8Array(b)], 'three.pdf', { type: 'application/pdf' }));
    return d;
  }, bytes);
  await page.dispatchEvent('[data-testid="dropzone"]', 'drop', { dataTransfer: dt });
  await expect(page.getByRole('status')).toContainText('Done: 3 pages', { timeout: 120_000 });
});

test('enlarged view: open, toggle 1:1, close (X/Esc), focus returns, downloads keep working', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 700 });
  let converts = 0;
  page.on('request', (r) => {
    if (r.url().includes('/api/convert')) converts++;
  });
  await page.goto('/');
  await page.setInputFiles('#file', { name: 'two.pdf', mimeType: 'application/pdf', buffer: await numberedPdf(2) });
  await expect(page.getByRole('status')).toContainText('Done: 2 pages', { timeout: 120_000 });
  const thumbSrc = await page.locator('ol.pages img').nth(1).getAttribute('src');

  // Open by click
  const thumb2 = page.getByRole('button', { name: 'Show page 2 enlarged' });
  await thumb2.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading')).toHaveText('Page 2 of 2');
  const big = dialog.locator('img');
  await expect(big).toHaveAttribute('src', thumbSrc!); // same JPEG / object URL
  // Fit to screen: fits completely into the image area
  const fit = await big.evaluate((el: HTMLImageElement) => {
    const b = el.parentElement!;
    return { w: el.clientWidth, h: el.clientHeight, bw: b.clientWidth, bh: b.clientHeight, sh: b.scrollHeight, ch: b.clientHeight };
  });
  expect(fit.w).toBeLessThanOrEqual(fit.bw);
  expect(fit.h).toBeLessThanOrEqual(fit.bh);
  expect(fit.sh).toBeLessThanOrEqual(fit.ch + 1);
  // 1:1 – natural pixel size, image area scrollable
  await dialog.getByRole('button', { name: 'Actual size (1:1)' }).click();
  await expect(dialog.getByRole('button', { name: 'Fit to screen' })).toHaveAttribute('aria-pressed', 'true');
  const actual = await big.evaluate((el: HTMLImageElement) => ({
    w: el.clientWidth,
    nw: el.naturalWidth,
    scroll: el.parentElement!.scrollHeight > el.parentElement!.clientHeight,
  }));
  expect(actual.w).toBe(actual.nw);
  expect(actual.scroll).toBe(true);
  // Download inside the dialog
  const [dl] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('link', { name: 'Download JPG' }).click()]);
  expect(dl.suggestedFilename()).toBe('page-002.jpg');
  expect(decodePageNumber(await readFile((await dl.path())!))).toBe(2);
  // Close with X, focus returns to the preview
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();
  await expect(thumb2).toBeFocused();

  // Keyboard: Enter opens, Escape closes, focus returns
  const thumb1 = page.getByRole('button', { name: 'Show page 1 enlarged' });
  await thumb1.focus();
  await page.keyboard.press('Enter');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading')).toHaveText('Page 1 of 2');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(thumb1).toBeFocused();

  // Regression: closing and reopening within one task (before the async 'close' event fires)
  // must keep the newly opened view intact
  await thumb2.click();
  await expect(dialog.getByRole('heading')).toHaveText('Page 2 of 2');
  await page.evaluate(() => {
    document.querySelector<HTMLButtonElement>('dialog .close')!.click();
    document.querySelectorAll<HTMLButtonElement>('ol.pages .thumb')[0]!.click();
  });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading')).toHaveText('Page 1 of 2');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(thumb1).toBeFocused();

  // Download in the overview still works; no new conversion happened
  const [dl1] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Download JPG' }).first().click()]);
  expect(dl1.suggestedFilename()).toBe('page-001.jpg');
  expect(decodePageNumber(await readFile((await dl1.path())!))).toBe(1);
  expect(converts).toBe(1);
});
