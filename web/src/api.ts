export type Phase = 'uploading' | 'preparing' | 'rendering';

export interface PageImage {
  page: number;
  width: number;
  height: number;
  blob: Blob;
  url: string;
}

export class ConvertError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

function decodeBase64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Uploads the PDF, follows the phases (NDJSON stream) and returns the JPEG pages as Blobs. */
export async function convertPdf(file: File, signal: AbortSignal, onPhase: (p: Phase) => void): Promise<PageImage[]> {
  onPhase('uploading');
  let res: Response;
  try {
    res = await fetch('/api/convert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/pdf' },
      body: file,
      signal,
      cache: 'no-store',
    });
  } catch (e) {
    if (signal.aborted) throw new ConvertError('ABORTED');
    throw new ConvertError('NETWORK');
  }
  if (!res.ok || !res.body) {
    let code = 'WORKER_FAILED';
    try {
      code = ((await res.json()) as { error?: string }).error ?? code;
    } catch {
      /* ignore */
    }
    throw new ConvertError(code);
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buf += value;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line) as {
          phase?: Phase;
          error?: string;
          result?: { pages: { page: number; width: number; height: number; jpeg: string }[] };
        };
        if (msg.phase) onPhase(msg.phase);
        if (msg.error) throw new ConvertError(msg.error);
        if (msg.result) {
          return msg.result.pages
            .slice()
            .sort((a, b) => a.page - b.page)
            .map((p) => {
              const blob = new Blob([decodeBase64(p.jpeg)], { type: 'image/jpeg' });
              return { page: p.page, width: p.width, height: p.height, blob, url: URL.createObjectURL(blob) };
            });
        }
      }
      if (done) break;
    }
  } catch (e) {
    if (e instanceof ConvertError) throw e;
    if (signal.aborted) throw new ConvertError('ABORTED');
    throw new ConvertError('NETWORK');
  }
  throw new ConvertError('WORKER_FAILED');
}
