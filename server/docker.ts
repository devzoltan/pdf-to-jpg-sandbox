import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  Config,
  CONTAINER_PREFIX,
  IMAGE_TAG,
  LABEL_BUILD,
  LABEL_JOB,
  LABEL_MANAGED,
  LABEL_ROLE,
} from './config.js';

export interface ExecResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
}

/** Runs `docker` with an argument list (never through a shell). Output is buffered up to a cap. */
export function docker(
  cfg: Pick<Config, 'dockerBin'>,
  args: string[],
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cfg.dockerBin, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    const cap = 256 * 1024;
    child.stdout.on('data', (d: Buffer) => {
      if (stdout.length < cap) stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < cap) stderr += d.toString('utf8');
    });
    const kill = () => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 3000).unref();
    };
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          kill();
        }, opts.timeoutMs)
      : undefined;
    const onAbort = () => {
      aborted = true;
      kill();
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ code, signal, stdout, stderr, timedOut, aborted });
    });
  });
}

export class UpdateError extends Error {
  constructor(public code: 'UPDATE_FAILED' | 'UPDATE_TIMEOUT' | 'ABORTED', detail: string) {
    super(detail);
  }
}

export interface BuiltImage {
  imageId: string;
  buildId: string;
  durationMs: number;
}

/**
 * Rebuilds the worker image: fresh base image (--pull) and no build cache (--no-cache).
 * Returns the image ID of exactly this build; jobs are started with that ID only.
 */
export async function buildWorkerImage(cfg: Config, signal?: AbortSignal): Promise<BuiltImage> {
  const buildId = randomUUID();
  const started = Date.now();
  const res = await docker(
    cfg,
    [
      'build',
      '--pull',
      '--no-cache',
      '--quiet',
      '--build-arg',
      `BASE_IMAGE=${cfg.baseImage}`,
      '--label',
      `${LABEL_MANAGED}=true`,
      '--label',
      `${LABEL_ROLE}=worker-image`,
      '--label',
      `${LABEL_BUILD}=${buildId}`,
      '--tag',
      IMAGE_TAG,
      cfg.workerContext,
    ],
    { timeoutMs: cfg.updateTimeoutMs, signal },
  );
  if (res.aborted) throw new UpdateError('ABORTED', 'build aborted');
  if (res.timedOut) throw new UpdateError('UPDATE_TIMEOUT', 'build timed out');
  const id = res.stdout.trim().split(/\s+/).pop() ?? '';
  if (res.code !== 0 || !/^sha256:[0-9a-f]{64}$/.test(id)) {
    throw new UpdateError('UPDATE_FAILED', `build failed (exit ${res.code}): ${res.stderr.slice(-2000)}`);
  }
  // Double-check that the image carries the build ID of this run
  const insp = await docker(cfg, ['image', 'inspect', '--format', `{{index .Config.Labels "${LABEL_BUILD}"}}`, id]);
  if (insp.code !== 0 || insp.stdout.trim() !== buildId) {
    throw new UpdateError('UPDATE_FAILED', 'built image does not carry expected build id');
  }
  await removeOldWorkerImages(cfg, id);
  return { imageId: id, buildId, durationMs: Date.now() - started };
}

/** Removes older worker images of this project (found by label only). */
export async function removeOldWorkerImages(cfg: Config, keepId: string): Promise<void> {
  const ls = await docker(cfg, [
    'image',
    'ls',
    '--no-trunc',
    '--quiet',
    '--filter',
    `label=${LABEL_MANAGED}=true`,
    '--filter',
    `label=${LABEL_ROLE}=worker-image`,
  ]);
  const ids = [...new Set(ls.stdout.split(/\s+/).filter((s) => s.startsWith('sha256:') && s !== keepId))];
  for (const id of ids) {
    await docker(cfg, ['image', 'rm', id]).catch(() => undefined);
  }
}

export function containerName(jobId: string): string {
  return `${CONTAINER_PREFIX}${jobId}`;
}

/** Fixed, hardened run options for the worker. None of them comes from the HTTP request. */
export function workerRunArgs(cfg: Config, jobId: string, imageId: string, extra: { entrypoint?: string; cmd?: string[] } = {}): string[] {
  if (!/^[a-f0-9]{16,64}$/.test(jobId)) throw new Error('invalid job id');
  if (!/^sha256:[0-9a-f]{64}$/.test(imageId)) throw new Error('invalid image id');
  const args = [
    'run',
    '-i',
    '--rm',
    '--name',
    containerName(jobId),
    '--label',
    `${LABEL_MANAGED}=true`,
    '--label',
    `${LABEL_ROLE}=worker`,
    '--label',
    `${LABEL_JOB}=${jobId}`,
    '--network',
    'none',
    '--read-only',
    '--user',
    '10001:10001',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--tmpfs',
    `/work:rw,noexec,nosuid,nodev,size=${cfg.workerTmpfsMiB}m,mode=0700,uid=10001,gid=10001`,
    '--memory',
    `${cfg.workerMemoryMiB}m`,
    '--memory-swap',
    `${cfg.workerMemoryMiB}m`,
    '--cpus',
    String(cfg.workerCpus),
    '--pids-limit',
    String(cfg.workerPids),
    '--ulimit',
    'nofile=256:256',
    '--ulimit',
    'core=0',
    // Keep image data that passes through stdout out of Docker's on-disk logs
    '--log-driver',
    'none',
    '--env',
    `PDF2JPG_MAX_INPUT_BYTES=${cfg.maxInputBytes}`,
    '--env',
    `PDF2JPG_MAX_PAGES=${cfg.maxPages}`,
    '--env',
    `PDF2JPG_DPI=${cfg.dpi}`,
    '--env',
    `PDF2JPG_MAX_PX=${cfg.maxLongSidePx}`,
    '--env',
    `PDF2JPG_JPEG_QUALITY=${cfg.jpegQuality}`,
    '--env',
    `PDF2JPG_MAX_OUTPUT_BYTES=${cfg.workerMaxOutputBytes}`,
    '--env',
    `PDF2JPG_HARD_TIMEOUT_S=${cfg.workerHardTimeoutS}`,
  ];
  if (extra.entrypoint) args.push('--entrypoint', extra.entrypoint);
  args.push(imageId, ...(extra.cmd ?? []));
  return args;
}

/** Lists this project's worker containers (optionally of a single job). */
export async function listWorkerContainers(cfg: Config, jobId?: string): Promise<string[]> {
  const args = ['ps', '-a', '--quiet', '--no-trunc', '--filter', `label=${LABEL_MANAGED}=true`, '--filter', `label=${LABEL_ROLE}=worker`];
  if (jobId) args.push('--filter', `label=${LABEL_JOB}=${jobId}`);
  const res = await docker(cfg, args, { timeoutMs: 20_000 });
  if (res.code !== 0) throw new Error(`docker ps failed: ${res.stderr.slice(0, 500)}`);
  return res.stdout.split(/\s+/).filter(Boolean);
}

/** Removes the containers of a job (or all own workers) and verifies that they are really gone. */
export async function removeWorkerContainers(cfg: Config, jobId?: string): Promise<number> {
  let removed = 0;
  for (let attempt = 0; attempt < 20; attempt++) {
    const ids = await listWorkerContainers(cfg, jobId);
    if (ids.length === 0) {
      // Check once more in case an aborted `docker run` is still creating the container
      if (attempt > 0) return removed;
      await new Promise((r) => setTimeout(r, 250));
      continue;
    }
    await docker(cfg, ['rm', '-f', ...ids], { timeoutMs: 20_000 });
    removed += ids.length;
    await new Promise((r) => setTimeout(r, 250));
  }
  const left = await listWorkerContainers(cfg, jobId);
  if (left.length) throw new Error(`worker containers still present: ${left.length}`);
  return removed;
}
