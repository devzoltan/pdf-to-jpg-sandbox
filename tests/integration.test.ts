// Integration tests with a real Docker worker and a real HTTP server (no mocks).
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { buildApp } from '../server/app.js';
import { Config, defaultConfig } from '../server/config.js';
import { buildWorkerImage, workerRunArgs } from '../server/docker.js';
import {
  encryptedPdf,
  extremeGeometryPdf,
  fakePdfHeader,
  noisyPdf,
  notAPdf,
  numberedPdf,
  truncatedPdf,
} from './fixtures.js';
import { convert, decodeJpeg, decodePageNumber, dockerOut, ourContainers, waitFor } from './helpers.js';

let imageId = '';
const apps: { close: () => Promise<unknown> }[] = [];

/** Starts an app instance on a random loopback port. Test limits live only here, never in the defaults. */
async function startApp(over: Partial<Config> = {}, deps: Parameters<typeof buildApp>[1] = {}) {
  const cfg = { ...defaultConfig(), port: 0, ...over };
  const app = buildApp(cfg, { logger: false, prepareImage: async () => imageId, ...deps });
  await app.listen({ host: '127.0.0.1', port: 0 });
  apps.push(app);
  const port = (app.server.address() as AddressInfo).port;
  return { app, base: `http://127.0.0.1:${port}`, cfg };
}

beforeAll(async () => {
  // Build once with the real update function; dedicated tests verify the rebuild per job.
  imageId = (await buildWorkerImage(defaultConfig())).imageId;
});

afterEach(async () => {
  expect(await waitFor(() => ourContainers().length === 0, 15_000)).toBe(true);
});

afterAll(async () => {
  for (const a of apps) await a.close();
});

describe('Regular conversion', () => {
  it('1: single-page PDF yields a valid JPEG (A4 @150 DPI)', async () => {
    const { base } = await startApp();
    const r = await convert(base, await numberedPdf(1));
    expect(r.error).toBeUndefined();
    expect(r.phases).toEqual(['preparing', 'rendering']);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.pages).toHaveLength(1);
    const p = r.pages![0]!;
    expect(p.data.subarray(0, 3).toString('hex')).toBe('ffd8ff');
    const img = decodeJpeg(p.data);
    expect([img.width, img.height]).toEqual([p.width, p.height]);
    expect(Math.abs(p.width - 1240)).toBeLessThanOrEqual(2);
    expect(Math.abs(p.height - 1754)).toBeLessThanOrEqual(2);
    expect(decodePageNumber(p.data)).toBe(1);
  });

  it('2: 15-page PDF – count, content and order are correct', async () => {
    const { base } = await startApp();
    const r = await convert(base, await numberedPdf(15));
    expect(r.error).toBeUndefined();
    expect(r.pages!.map((p) => p.page)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
    expect(r.pages!.map((p) => decodePageNumber(p.data))).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
  });

  it('6a: extreme page geometry is scaled proportionally to <= 2000 px (no cropping)', async () => {
    const { base } = await startApp();
    const r = await convert(base, await extremeGeometryPdf());
    expect(r.error).toBeUndefined();
    const sizes: [number, number][] = [
      [14400, 14400],
      [14400, 300],
      [200, 14400],
    ];
    r.pages!.forEach((p, i) => {
      expect(Math.max(p.width, p.height)).toBeLessThanOrEqual(2000);
      expect(Math.max(p.width, p.height)).toBeGreaterThanOrEqual(1990);
      const [w, h] = sizes[i]!;
      expect(Math.abs(p.width / p.height - w / h) / (w / h)).toBeLessThan(0.05);
    });
  });

  it('6b: a smaller image limit (test configuration) is respected', async () => {
    const { base } = await startApp({ maxLongSidePx: 400 });
    const r = await convert(base, await numberedPdf(2));
    expect(r.pages!.every((p) => Math.max(p.width, p.height) <= 400)).toBe(true);
  });
});

describe('Invalid and rejected input', () => {
  it('4a: empty file', async () => {
    const { base } = await startApp();
    const r = await convert(base, Buffer.alloc(0));
    expect([r.status, r.error]).toEqual([400, 'EMPTY']);
  });

  it('4b: renamed text file', async () => {
    const { base } = await startApp();
    const r = await convert(base, notAPdf());
    expect([r.status, r.error]).toEqual([415, 'NOT_PDF']);
  });

  it('4c: PDF header followed by garbage is rejected by the worker', async () => {
    const { base } = await startApp();
    const r = await convert(base, fakePdfHeader());
    expect(r.phases).toContain('rendering');
    expect(r.error).toBe('INVALID_PDF');
  });

  it('4d: truncated PDF is handled gracefully', async () => {
    const { base } = await startApp();
    const r = await convert(base, await truncatedPdf());
    expect(r.error).toBe('INVALID_PDF');
  });

  it('5: encrypted PDFs (user password and owner password only) are rejected', async () => {
    const { base } = await startApp();
    expect((await convert(base, await encryptedPdf('user'))).error).toBe('ENCRYPTED');
    expect((await convert(base, await encryptedPdf('owner-only'))).error).toBe('ENCRYPTED');
  });

  it('6c: input over 20 MiB is rejected while reading (also chunked)', async () => {
    const { base } = await startApp();
    const big = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(20 * 1024 * 1024)]);
    expect((await convert(base, big)).status).toBe(413);
    const stream = new ReadableStream({
      start(c) {
        for (let i = 0; i < 21; i++) c.enqueue(new Uint8Array(1024 * 1024));
        c.close();
      },
    });
    const r = await convert(base, stream, { chunked: true }).catch((e: Error) => ({ status: -1, error: e.message }));
    expect([413, -1]).toContain(r.status);
  });

  it('6d: more than 50 pages are rejected in the worker before rendering', async () => {
    const { base } = await startApp();
    const r = await convert(base, await numberedPdf(51));
    expect(r.error).toBe('TOO_MANY_PAGES');
  });

  it('6e: output limit in the worker and in the backend (test configuration)', async () => {
    const pdf = await noisyPdf(4);
    const w = await startApp({ workerMaxOutputBytes: 150_000 });
    expect((await convert(w.base, pdf)).error).toBe('OUTPUT_TOO_LARGE');
    const b = await startApp({ maxOutputBytes: 150_000 });
    expect((await convert(b.base, pdf)).error).toBe('OUTPUT_TOO_LARGE');
  });
});

describe('Runtime, cancellation, concurrency', () => {
  it('7a: timeout stops the worker; a regular job works afterwards', async () => {
    const { base } = await startApp({ renderTimeoutMs: 1500 });
    const r = await convert(base, await noisyPdf(40));
    expect(r.error).toBe('TIMEOUT');
    expect(ourContainers()).toEqual([]);
    const ok = await startApp();
    expect((await convert(ok.base, await numberedPdf(1))).pages).toHaveLength(1);
  });

  it('7b: worker failure (out of memory) is reported and cleaned up', async () => {
    const { base } = await startApp({ workerMemoryMiB: 12, workerTmpfsMiB: 8 });
    const r = await convert(base, await noisyPdf(20));
    expect(r.error).toBe('WORKER_FAILED');
    expect(ourContainers()).toEqual([]);
  });

  it('8: client cancellation stops and removes the worker', async () => {
    let started = false;
    const { base } = await startApp({}, { onWorkerStarted: () => (started = true) });
    const ctrl = new AbortController();
    const p = convert(base, await noisyPdf(40), { signal: ctrl.signal }).catch((e: Error) => e);
    expect(await waitFor(() => started && ourContainers().length === 1, 20_000)).toBe(true);
    ctrl.abort();
    await p;
    expect(await waitFor(() => ourContainers().length === 0, 10_000)).toBe(true);
    // the slot is released only after verified cleanup
    for (let i = 0; i < 50; i++) {
      const h = (await (await fetch(`${base}/api/health`)).json()) as { busy: boolean };
      if (!h.busy) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    const r = await convert(base, await numberedPdf(1));
    expect(r.pages).toHaveLength(1);
  });

  it('9: a second concurrent request gets 409 BUSY, results do not mix', async () => {
    const { base } = await startApp();
    const [a, b] = await Promise.all([convert(base, await numberedPdf(12)), convert(base, await numberedPdf(3))]);
    const busy = [a, b].filter((r) => r.status === 409);
    const ok = [a, b].filter((r) => r.status === 200);
    expect(busy).toHaveLength(1);
    expect(busy[0]!.error).toBe('BUSY');
    expect(ok).toHaveLength(1);
    expect(ok[0]!.pages!.map((p) => decodePageNumber(p.data))).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
  });
});

describe('Worker hardening and update', () => {
  it('10a: a running worker has the expected Docker settings', async () => {
    let inspected: Record<string, any> | undefined;
    const { base } = await startApp({}, {
      onWorkerStarted: (jobId) => {
        void waitFor(() => dockerOut(['ps', '-q', '--filter', `label=pdf-to-jpg-sandbox.job=${jobId}`]) !== '', 10_000, 50).then(() => {
          const raw = dockerOut(['inspect', `pdf-to-jpg-sandbox-worker-${jobId}`]);
          if (raw) inspected = JSON.parse(raw)[0];
        });
      },
    });
    await convert(base, await noisyPdf(30));
    expect(inspected).toBeDefined();
    const hc = inspected!.HostConfig;
    expect(hc.NetworkMode).toBe('none');
    expect(hc.ReadonlyRootfs).toBe(true);
    expect(hc.Privileged).toBe(false);
    expect(hc.CapDrop).toContain('ALL');
    expect(hc.SecurityOpt).toContain('no-new-privileges');
    expect(hc.Memory).toBe(512 * 1024 * 1024);
    expect(hc.MemorySwap).toBe(512 * 1024 * 1024);
    expect(hc.NanoCpus).toBe(1e9);
    expect(hc.PidsLimit).toBe(64);
    expect(hc.LogConfig.Type).toBe('none');
    expect(hc.AutoRemove).toBe(true);
    expect(hc.Binds ?? []).toEqual([]);
    expect(inspected!.Mounts ?? []).toEqual([]);
    expect(Object.keys(hc.Tmpfs)).toEqual(['/work']);
    expect(inspected!.Config.User).toBe('10001:10001');
    expect(inspected!.Image).toBe(imageId);
  });

  it('10b: functional probe with the same run options: non-root, read-only, only tmpfs writable, no network', () => {
    const probe = [
      'id -u',
      'touch /probe 2>/dev/null && echo ROOTFS_WRITABLE || echo ROOTFS_READONLY',
      'touch /work/x && echo WORK_WRITABLE',
      'echo "NET:$(ls /sys/class/net | tr "\\n" " ")"',
    ].join('; ');
    const args = workerRunArgs(defaultConfig(), 'feedfacefeedface0001', imageId, { entrypoint: '/bin/sh', cmd: ['-c', probe] });
    const r = spawnSync('docker', args, { encoding: 'utf8', input: '' });
    const out = r.stdout.trim().split('\n');
    expect(out[0]).toBe('10001');
    expect(out).toContain('ROOTFS_READONLY');
    expect(out).toContain('WORK_WRITABLE');
    expect(out[3]!.trim()).toBe('NET:lo');
    // 200 MiB do not fit into the 128 MiB tmpfs
    const sizeCheck = spawnSync('docker', workerRunArgs(defaultConfig(), 'feedfacefeedface0002', imageId, { entrypoint: '/bin/sh', cmd: ['-c', 'dd if=/dev/zero of=/work/big bs=1M count=200 2>/dev/null; du -m /work/big | cut -f1'] }), { encoding: 'utf8', input: '' });
    expect(Number(sizeCheck.stdout.trim())).toBeLessThanOrEqual(128);
  });

  it('10c: the image is rebuilt before the job and exactly this image is used', async () => {
    let usedImage = '';
    let builtImage = '';
    const { base } = await startApp({}, {
      prepareImage: async (c, signal) => (builtImage = (await buildWorkerImage(c, signal)).imageId),
      onWorkerStarted: (_j, img) => (usedImage = img),
    });
    const r = await convert(base, await numberedPdf(2));
    expect(r.pages).toHaveLength(2);
    expect(builtImage).toMatch(/^sha256:/);
    expect(builtImage).not.toBe(imageId);
    expect(usedImage).toBe(builtImage);
    const created = Date.parse(dockerOut(['image', 'inspect', '--format', '{{.Created}}', builtImage]));
    expect(Date.now() - created).toBeLessThan(5 * 60_000);
    imageId = builtImage; // older own images are removed by the rebuild
  });

  it('10d: failed update => clear error, no worker with an old image', async () => {
    let started = false;
    const { base } = await startApp({ baseImage: 'pdf-to-jpg-sandbox-test/does-not-exist:none' }, {
      prepareImage: async (c, signal) => (await buildWorkerImage(c, signal)).imageId,
      onWorkerStarted: () => (started = true),
    });
    const r = await convert(base, await numberedPdf(1));
    expect(r.error).toBe('UPDATE_FAILED');
    expect(r.phases).toEqual(['preparing']);
    expect(started).toBe(false);
  });

  it('10e: update time limit', async () => {
    const { base } = await startApp({ updateTimeoutMs: 300 }, {
      prepareImage: async (c, signal) => (await buildWorkerImage(c, signal)).imageId,
    });
    const r = await convert(base, await numberedPdf(1));
    expect(r.error).toBe('UPDATE_TIMEOUT');
  });
});
