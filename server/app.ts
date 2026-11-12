import Fastify, { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { PassThrough } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Config, resolveRoot } from './config.js';
import { buildWorkerImage, UpdateError } from './docker.js';
import { JobError, renderPdf } from './job.js';

export interface AppDeps {
  /** Prepares the worker image before every job and returns its ID. Default: real rebuild. */
  prepareImage?: (cfg: Config, signal: AbortSignal) => Promise<string>;
  /** Called after a worker container has been started (tests/observability only). */
  onWorkerStarted?: (jobId: string, imageId: string) => void;
  logger?: boolean;
}

interface ActiveJob {
  jobId: string;
  controller: AbortController;
  done: Promise<void>;
}

const CSP = [
  "default-src 'self'",
  "img-src 'self' blob:",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

export function buildApp(cfg: Config, deps: AppDeps = {}): FastifyInstance & { abortActiveJob: () => Promise<void> } {
  const app = Fastify({
    logger: deps.logger === false ? false : { level: 'info' },
    bodyLimit: cfg.maxInputBytes,
    forceCloseConnections: true,
  });
  const prepareImage =
    deps.prepareImage ?? (async (c: Config, signal: AbortSignal) => (await buildWorkerImage(c, signal)).imageId);

  // Exactly one job at a time; the slot is released only after cleanup has been verified.
  let slotBusy = false;
  let active: ActiveJob | undefined;

  app.addHook('onSend', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Content-Security-Policy', CSP);
  });

  app.removeAllContentTypeParsers();
  app.addContentTypeParser('application/pdf', { parseAs: 'buffer', bodyLimit: cfg.maxInputBytes }, (_req, body, done) =>
    done(null, body),
  );

  app.setErrorHandler((err: { code?: string; statusCode?: number }, _req, reply) => {
    if (err.code === 'FST_ERR_CTP_BODY_TOO_LARGE') return reply.code(413).send({ error: 'TOO_LARGE' });
    if (err.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') return reply.code(415).send({ error: 'NOT_PDF' });
    if (err.code === 'FST_ERR_CTP_EMPTY_TYPE') return reply.code(415).send({ error: 'NOT_PDF' });
    app.log.error({ code: err.code }, 'request error');
    return reply.code(err.statusCode && err.statusCode < 500 ? err.statusCode : 500).send({ error: 'INTERNAL' });
  });

  app.get('/api/health', async () => ({ ok: true, busy: slotBusy }));

  app.post(
    '/api/convert',
    {
      onRequest: async (req, reply) => {
        if (slotBusy) {
          reply.header('Connection', 'close');
          return reply.code(409).send({ error: 'BUSY' });
        }
        slotBusy = true;
        (req as unknown as { slotHeld: boolean }).slotHeld = true;
      },
      onResponse: async (req) => {
        // Release the slot if the handler never took it over (e.g. 413 while reading the body)
        const r = req as unknown as { slotHeld?: boolean; slotOwned?: boolean };
        if (r.slotHeld && !r.slotOwned) slotBusy = false;
      },
      onRequestAbort: async (req) => {
        const r = req as unknown as { slotHeld?: boolean; slotOwned?: boolean };
        if (r.slotHeld && !r.slotOwned) slotBusy = false;
      },
    },
    async (req, reply) => {
      const r = req as unknown as { slotOwned?: boolean };
      r.slotOwned = true;
      const body = req.body as Buffer | undefined;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        slotBusy = false;
        return reply.code(400).send({ error: 'EMPTY' });
      }
      if (!body.subarray(0, 1024).includes('%PDF-')) {
        slotBusy = false;
        return reply.code(415).send({ error: 'NOT_PDF' });
      }

      const jobId = randomBytes(12).toString('hex');
      const controller = new AbortController();
      const out = new PassThrough();
      const send = (obj: unknown) => {
        if (!out.writableEnded) out.write(JSON.stringify(obj) + '\n');
      };
      // Client disconnect => abort the job
      reply.raw.on('close', () => {
        if (!reply.raw.writableFinished) controller.abort();
      });

      let pdf: Buffer | undefined = body;
      const log = app.log.child({ jobId });
      const run = async () => {
        const t0 = Date.now();
        try {
          send({ phase: 'preparing' });
          let imageId: string;
          try {
            imageId = await prepareImage(cfg, controller.signal);
          } catch (e) {
            const code = e instanceof UpdateError ? e.code : 'UPDATE_FAILED';
            log.warn({ code, ms: Date.now() - t0 }, 'worker image update failed');
            if (e instanceof UpdateError) log.debug({ detail: e.message.slice(0, 500) });
            send({ error: code });
            return;
          }
          log.info({ ms: Date.now() - t0 }, 'worker image ready');
          if (controller.signal.aborted) throw new JobError('ABORTED');
          send({ phase: 'rendering' });
          const t1 = Date.now();
          const pages = await renderPdf(cfg, imageId, jobId, pdf!, controller.signal, () =>
            deps.onWorkerStarted?.(jobId, imageId),
          );
          pdf = undefined;
          log.info({ pages: pages.length, ms: Date.now() - t1 }, 'render ok');
          send({
            result: {
              pages: pages.map((p) => ({ page: p.page, width: p.width, height: p.height, jpeg: p.data.toString('base64') })),
            },
          });
        } catch (e) {
          const code = e instanceof JobError ? e.code : 'WORKER_FAILED';
          log.warn({ code, detail: e instanceof Error ? e.message.slice(0, 200) : '' }, 'job failed');
          send({ error: code });
        } finally {
          pdf = undefined;
          out.end();
        }
      };

      const done = run()
        .catch((e) => log.error({ err: String(e) }, 'cleanup failed'))
        .finally(() => {
          active = undefined;
          slotBusy = false;
        });
      active = { jobId, controller, done };

      reply.type('application/x-ndjson; charset=utf-8');
      return reply.send(out);
    },
  );

  const webRoot = path.join(resolveRoot(), 'dist', 'web');
  if (existsSync(webRoot)) {
    app.register(fastifyStatic, { root: webRoot, cacheControl: false, etag: false, lastModified: false });
  }

  const extended = app as unknown as FastifyInstance & { abortActiveJob: () => Promise<void> };
  extended.abortActiveJob = async () => {
    const a = active;
    if (!a) return;
    a.controller.abort();
    await a.done;
  };
  return extended;
}
