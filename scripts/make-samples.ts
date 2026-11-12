// Writes harmless, synthetic sample files for manual testing to samples/ (not versioned).
import { mkdir, writeFile } from 'node:fs/promises';
import { encryptedPdf, extremeGeometryPdf, fakePdfHeader, notAPdf, numberedPdf } from '../tests/fixtures.js';

await mkdir('samples', { recursive: true });
const files: [string, Buffer][] = [
  ['01-single-page.pdf', await numberedPdf(1)],
  ['02-twelve-pages.pdf', await numberedPdf(12)],
  ['03-extreme-page-size.pdf', await extremeGeometryPdf()],
  ['04-password-protected.pdf', await encryptedPdf('user')],
  ['05-owner-password-only.pdf', await encryptedPdf('owner-only')],
  ['06-renamed-text-file.pdf', notAPdf()],
  ['07-broken.pdf', fakePdfHeader()],
  ['08-fifty-one-pages.pdf', await numberedPdf(51)],
];
for (const [name, data] of files) await writeFile(`samples/${name}`, data);
console.log(`${files.length} sample files written to samples/.`);
