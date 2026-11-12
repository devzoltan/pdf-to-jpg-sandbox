import { spawn } from 'node:child_process';
import { Transform } from 'node:stream';
import tar from 'tar-stream';
import { Config } from './config.js';
import { removeWorkerContainers, workerRunArgs } from './docker.js';
import { jpegSize } from './jpeg.js';

export type JobErrorCode =
  | 'INVALID_PDF'
  | 'ENCRYPTED'
  | 'TOO_MANY_PAGES'
  | 'OUTPUT_TOO_LARGE'
  | 'IMAGE_TOO_LARGE'
  | 'TOO_LARGE'
  | 'TIMEOUT'
  | 'WORKER_FAILED'
  | 'ABORTED';

export class JobError extends Error {
  constructor(public code: JobErrorCode, detail = '') {
    super(detail || code);
  }
}

export interface RenderedPage {
  page: number;
  width: number;
  height: number;
  data: Buffer;
}

const EXIT_CODES: Record<number, JobErrorCode> = {
  10: 'INVALID_PDF',
  11: 'ENCRYPTED',
  12: 'TOO_MANY_PAGES',
  13: 'OUTPUT_TOO_LARGE',
  14: 'INVALID_PDF',
  15: 'TOO_LARGE',
  16: 'WORKER_FAILED',
};

/**
 * Starts a fresh worker container for exactly this job, passes the PDF via stdin and reads the
 * size-limited tar result from stdout. The container is always removed afterwards.
 */
export async function renderPdf(
  cfg: Config,
  imageId: string,
  jobId: string,
  pdf: Buffer,
  signal: AbortSignal,
  onStarted?: () => void,
): Promise<RenderedPage[]> {
  const child = spawn(cfg.dockerBin, workerRunArgs(cfg, jobId, imageId), {
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  onStarted?.();

  let failure: JobError | undefined;
  const fail = (e: JobError) => {
    if (!failure) failure = e;
    child.kill('SIGKILL');
    // Drain remaining output so the process can finish ('close' waits for empty pipes)
    child.stdout.unpipe();
    child.stdout.resume();
  };

  const timer = setTimeout(() => fail(new JobError('TIMEOUT')), cfg.renderTimeoutMs);
  const onAbort = () => fail(new JobError('ABORTED'));
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();

  let stderrTail = '';
  child.stderr.on('data', (d: Buffer) => {
    stderrTail = (stderrTail + d.toString('utf8')).slice(-2000);
  });
  child.stdin.on('error', () => undefined); // the worker may close stdin early (e.g. size limit)
  child.stdin.end(pdf);

  // Byte limit on the raw stream (sum of JPEGs + tar overhead)
  const streamLimit = cfg.maxOutputBytes + (cfg.maxPages + 2) * 1024 + 10240;
  let seen = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      seen += chunk.length;
      if (seen > streamLimit) {
        fail(new JobError('OUTPUT_TOO_LARGE', 'stdout limit'));
        cb();
        return;
      }
      cb(null, chunk);
    },
  });

  const pages: RenderedPage[] = [];
  const extract = tar.extract();
  const parse = (async () => {
    let total = 0;
    for await (const entry of extract) {
      const h = entry.header;
      const expected = `page-${String(pages.length + 1).padStart(3, '0')}.jpg`;
      if (h.type !== 'file' || h.name !== expected) throw new JobError('WORKER_FAILED', 'unexpected entry');
      if (pages.length + 1 > cfg.maxPages) throw new JobError('TOO_MANY_PAGES');
      if ((h.size ?? 0) > cfg.maxOutputBytes || total + (h.size ?? 0) > cfg.maxOutputBytes) {
        throw new JobError('OUTPUT_TOO_LARGE');
      }
      const chunks: Buffer[] = [];
      let len = 0;
      for await (const c of entry as AsyncIterable<Buffer>) {
        len += c.length;
        if (total + len > cfg.maxOutputBytes) throw new JobError('OUTPUT_TOO_LARGE');
        chunks.push(c);
      }
      total += len;
      const data = Buffer.concat(chunks, len);
      const dim = jpegSize(data);
      if (!dim) throw new JobError('WORKER_FAILED', 'not a jpeg');
      if (dim.width > cfg.maxLongSidePx || dim.height > cfg.maxLongSidePx) throw new JobError('IMAGE_TOO_LARGE');
      pages.push({ page: pages.length + 1, width: dim.width, height: dim.height, data });
    }
  })();
  parse.catch((e: unknown) => fail(e instanceof JobError ? e : new JobError('WORKER_FAILED', 'invalid tar')));

  child.stdout.pipe(limiter).pipe(extract);
  child.stdout.on('error', () => undefined);

  const exit = await new Promise<{ code: number | null; sig: NodeJS.Signals | null }>((resolve) => {
    child.on('error', () => resolve({ code: null, sig: null }));
    child.on('close', (code, sig) => resolve({ code, sig }));
  });

  try {
    if (failure) throw failure;
    if (exit.code !== 0) {
      const mapped = exit.code !== null ? EXIT_CODES[exit.code] : undefined;
      if (mapped) throw new JobError(mapped);
      // 137 = killed inside the container (memory limit or hard runtime limit)
      throw new JobError('WORKER_FAILED', `exit ${exit.code} ${exit.sig ?? ''} ${stderrTail.replace(/\s+/g, ' ').slice(0, 200)}`);
    }
    try {
      await parse;
    } catch (e) {
      if (failure) throw failure;
      if (e instanceof JobError) throw e;
      throw new JobError('WORKER_FAILED', 'invalid tar');
    }
    if (failure) throw failure;
    if (pages.length === 0) throw new JobError('WORKER_FAILED', 'no pages');
    return pages;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
    extract.destroy();
    // Remove the container and verify it is gone (killing the CLI process alone is not enough)
    await removeWorkerContainers(cfg, jobId);
  }
}
