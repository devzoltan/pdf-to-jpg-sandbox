import { spawnSync } from 'node:child_process';
import jpeg from 'jpeg-js';
import { codeCells } from './fixtures.js';

export interface ConvertOutcome {
  status: number;
  phases: string[];
  error?: string;
  pages?: { page: number; width: number; height: number; data: Buffer }[];
  headers: Headers;
}

/** Calls /api/convert like the browser does and evaluates the NDJSON stream. */
export async function convert(base: string, body: BodyInit | Buffer, opts: { signal?: AbortSignal; onPhase?: (p: string) => void; chunked?: boolean } = {}): Promise<ConvertOutcome> {
  const res = await fetch(`${base}/api/convert`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/pdf' },
    body: body as BodyInit,
    signal: opts.signal,
    ...(opts.chunked ? { duplex: 'half' } : {}),
  } as RequestInit);
  const out: ConvertOutcome = { status: res.status, phases: [], headers: res.headers };
  const text = await res.text();
  if (!res.ok) {
    try {
      out.error = (JSON.parse(text) as { error: string }).error;
    } catch {
      out.error = `HTTP${res.status}`;
    }
    return out;
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.phase) {
      out.phases.push(msg.phase);
      opts.onPhase?.(msg.phase);
    }
    if (msg.error) out.error = msg.error;
    if (msg.result) {
      out.pages = msg.result.pages.map((p: { page: number; width: number; height: number; jpeg: string }) => ({
        page: p.page,
        width: p.width,
        height: p.height,
        data: Buffer.from(p.jpeg, 'base64'),
      }));
    }
  }
  return out;
}

/** Reads the page number from the bit pattern in a rendered JPEG. */
export function decodePageNumber(data: Buffer): number {
  const img = jpeg.decode(data, { useTArray: true });
  let n = 0;
  for (const c of codeCells()) {
    const cx = Math.round((c.x + c.size / 2) * img.width);
    // cells are square relative to the width; y from the relative height
    const cy = Math.round(c.y * img.height + (c.size * img.width) / 2);
    const i = (cy * img.width + cx) * 4;
    const lum = (img.data[i]! + img.data[i + 1]! + img.data[i + 2]!) / 3;
    n = (n << 1) | (lum < 100 ? 1 : 0);
  }
  return n;
}

export function decodeJpeg(data: Buffer) {
  return jpeg.decode(data, { useTArray: true });
}

export function dockerOut(args: string[]): string {
  const r = spawnSync('docker', args, { encoding: 'utf8' });
  return (r.stdout ?? '').trim();
}

export function ourContainers(): string[] {
  return dockerOut(['ps', '-a', '-q', '--filter', 'label=pdf-to-jpg-sandbox.managed=true', '--filter', 'label=pdf-to-jpg-sandbox.role=worker'])
    .split(/\s+/)
    .filter(Boolean);
}

export async function waitFor(fn: () => boolean, timeoutMs: number, stepMs = 200): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return fn();
}
