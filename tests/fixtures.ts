// Deterministic generator for harmless, synthetic test PDFs.
import { PDFDocument, StandardFonts, rgb } from '@cantoo/pdf-lib';

const FIXED_DATE = new Date('2026-01-01T00:00:00Z');

/** Bit pattern for the page number: 6 cells, black = 1. Positions relative to the page (0..1). */
export const CODE_BITS = 6;
export function codeCells(): { x: number; y: number; size: number }[] {
  // relative coordinates (from top left); cells are square relative to the page width
  return Array.from({ length: CODE_BITS }, (_, b) => ({ x: 0.1 + b * 0.13, y: 0.6, size: 0.1 }));
}

async function newDoc(): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  doc.setCreationDate(FIXED_DATE);
  doc.setModificationDate(FIXED_DATE);
  doc.setProducer('pdf-to-jpg-sandbox test fixtures');
  doc.setCreator('pdf-to-jpg-sandbox test fixtures');
  return doc;
}

/** Multi-page PDF: every page shows "Page N" plus a machine-readable code for N. */
export async function numberedPdf(pages: number, size: [number, number] = [595.28, 841.89]): Promise<Buffer> {
  const doc = await newDoc();
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  for (let n = 1; n <= pages; n++) {
    const page = doc.addPage(size);
    const [w, h] = size;
    page.drawText(`Page ${n}`, { x: w * 0.1, y: h * 0.8, size: Math.min(w, h) * 0.1, font, color: rgb(0.1, 0.2, 0.6) });
    for (const [b, c] of codeCells().entries()) {
      const bit = (n >> (CODE_BITS - 1 - b)) & 1;
      const s = c.size * w;
      page.drawRectangle({
        x: c.x * w,
        y: h - c.y * h - s,
        width: s,
        height: s,
        color: bit ? rgb(0, 0, 0) : rgb(1, 1, 1),
        borderColor: rgb(0.6, 0.6, 0.6),
        borderWidth: 1,
      });
    }
  }
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

/** Pages with extreme geometry (very large or very narrow). */
export async function extremeGeometryPdf(): Promise<Buffer> {
  const doc = await newDoc();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const sizes: [number, number][] = [
    [14400, 14400],
    [14400, 300],
    [200, 14400],
  ];
  for (const [w, h] of sizes) {
    const p = doc.addPage([w, h]);
    p.drawRectangle({ x: 0, y: 0, width: w, height: h, borderColor: rgb(1, 0, 0), borderWidth: Math.max(w, h) / 200 });
    p.drawText('Edge', { x: 10, y: 10, size: Math.min(w, h) / 4, font });
  }
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

/** Encrypted PDF: with an open (user) password or with an owner password only. */
export async function encryptedPdf(kind: 'user' | 'owner-only'): Promise<Buffer> {
  const doc = await newDoc();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([595.28, 841.89]).drawText('Confidential (test)', { x: 50, y: 700, size: 30, font });
  // @cantoo/pdf-lib: AES-256 standard security handler
  await (doc as unknown as { encrypt(o: object): Promise<void> | void }).encrypt({
    userPassword: kind === 'user' ? 'secret' : '',
    ownerPassword: 'owner',
    permissions: { printing: 'highResolution', copying: false, modifying: false },
  });
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

/** Pages full of noise: large JPEGs (for output limits and long render times). */
export async function noisyPdf(pages: number): Promise<Buffer> {
  const doc = await newDoc();
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let n = 0; n < pages; n++) {
    const p = doc.addPage([595.28, 841.89]);
    for (let i = 0; i < 1500; i++) {
      p.drawRectangle({ x: rnd() * 580, y: rnd() * 830, width: 4 + rnd() * 12, height: 4 + rnd() * 12, color: rgb(rnd(), rnd(), rnd()) });
    }
  }
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

export const notAPdf = (): Buffer => Buffer.from('This is a text file, not a PDF.\n'.repeat(20), 'utf8');
export const fakePdfHeader = (): Buffer => Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(4096, 0x41)]);
export async function truncatedPdf(): Promise<Buffer> {
  const full = await numberedPdf(3);
  return full.subarray(0, Math.floor(full.length / 3));
}
