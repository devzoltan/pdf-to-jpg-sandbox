// Captures screenshots of the running app for the documentation (docs/screenshots/<lang>/).
// Requires a running server (`npm start`, default http://127.0.0.1:8080) and `npm run samples`.
import { chromium, Page } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';

const base = process.env.BASE_URL ?? 'http://127.0.0.1:8080';
const sample = 'samples/02-twelve-pages.pdf';

const UI = {
  en: { choose: 'Choose PDF', preparing: 'Updating the processing environment', rendering: 'Processing', done: 'Done', enlarge: 'Show page 1 enlarged', actual: 'Actual size (1:1)', fit: 'Fit to screen' },
  de: { choose: 'PDF auswählen', preparing: 'Verarbeitungsumgebung wird aktualisiert', rendering: 'Verarbeitung läuft', done: 'Fertig', enlarge: 'Seite 1 vergrößert anzeigen', actual: 'Originalgröße (1:1)', fit: 'An Bildschirm anpassen' },
} as const;

const pdf = await readFile(sample);
const browser = await chromium.launch();

async function capture(lang: keyof typeof UI) {
  const ui = UI[lang];
  const out = `docs/screenshots/${lang}`;
  await mkdir(out, { recursive: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: lang === 'de' ? 'de-DE' : 'en-US', colorScheme: 'light' });
  const page: Page = await ctx.newPage();
  const shot = async (name: string, fullPage = false) => {
    await page.screenshot({ path: `${out}/${name}`, fullPage });
    console.log(`${out}/${name}`);
  };

  await page.goto(lang === 'de' ? `${base}/?lang=de` : base);
  await page.getByRole('button', { name: ui.choose }).waitFor();
  await shot('01-start.png');

  // A file is dragged over the drop zone (before dropping)
  const dt = await page.evaluateHandle(
    ({ bytes, name }) => {
      const d = new DataTransfer();
      d.items.add(new File([new Uint8Array(bytes)], name, { type: 'application/pdf' }));
      return d;
    },
    { bytes: Array.from(pdf), name: '02-twelve-pages.pdf' },
  );
  await page.dispatchEvent('[data-testid="dropzone"]', 'dragover', { dataTransfer: dt });
  await page.locator('.drop.over').waitFor();
  await shot('02-drag-over.png');

  // Dropped: preparation and processing
  await page.dispatchEvent('[data-testid="dropzone"]', 'drop', { dataTransfer: dt });
  await page.getByRole('status').getByText(ui.preparing, { exact: false }).waitFor();
  await shot('03-preparing.png');
  try {
    await page.getByRole('status').getByText(ui.rendering, { exact: false }).waitFor({ timeout: 120_000 });
    await shot('04-processing.png');
  } catch {
    console.log('The processing phase was too short for a screenshot.');
  }

  // Result
  await page.getByRole('status').getByText(ui.done, { exact: false }).waitFor({ timeout: 120_000 });
  await page.locator('ol.pages img').last().scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>('ol.pages img')].every((i) => i.complete && i.naturalWidth > 0));
  await shot('05-result.png');
  await shot('05-result-full-page.png', true);

  // Enlarged view
  await page.getByRole('button', { name: ui.enlarge }).click();
  await page.getByRole('dialog').waitFor();
  await shot('06-viewer-fit.png');
  await page.getByRole('button', { name: ui.actual }).click();
  await page.getByRole('button', { name: ui.fit }).waitFor();
  await shot('07-viewer-actual-size.png');
  await page.keyboard.press('Escape');
  await ctx.close();
}

try {
  const langs = (process.env.LANGS ?? 'en,de').split(',') as (keyof typeof UI)[];
  for (const lang of langs) await capture(lang);
} finally {
  await browser.close();
}
