import { fileURLToPath } from 'node:url';
import path from 'node:path';

const MiB = 1024 * 1024;

/** Project root; works from dist/server/ (build) and server/ (tsx). */
export function resolveRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return here.includes(`${path.sep}dist${path.sep}`) ? path.resolve(here, '..', '..') : path.resolve(here, '..');
}

/** Docker labels/names used to identify (and only ever clean up) this project's own resources. */
export const LABEL_PREFIX = 'pdf-to-jpg-sandbox';
export const LABEL_MANAGED = `${LABEL_PREFIX}.managed`;
export const LABEL_ROLE = `${LABEL_PREFIX}.role`;
export const LABEL_JOB = `${LABEL_PREFIX}.job`;
export const LABEL_BUILD = `${LABEL_PREFIX}.build-id`;
export const IMAGE_TAG = 'pdf-to-jpg-sandbox/worker:latest';
export const CONTAINER_PREFIX = 'pdf-to-jpg-sandbox-worker-';

export interface Config {
  host: string;
  port: number;
  dockerBin: string;
  workerContext: string;
  baseImage: string;
  /** Maximum size of the uploaded PDF in bytes. */
  maxInputBytes: number;
  maxPages: number;
  dpi: number;
  maxLongSidePx: number;
  jpegQuality: number;
  /** Total JPEG bytes accepted by the backend. */
  maxOutputBytes: number;
  /** Total JPEG bytes allowed inside the worker. */
  workerMaxOutputBytes: number;
  renderTimeoutMs: number;
  updateTimeoutMs: number;
  workerHardTimeoutS: number;
  workerMemoryMiB: number;
  workerCpus: number;
  workerPids: number;
  workerTmpfsMiB: number;
}

export function defaultConfig(): Config {
  const root = resolveRoot();
  return {
    host: '127.0.0.1',
    port: 8080,
    dockerBin: 'docker',
    workerContext: path.join(root, 'worker'),
    baseImage: 'debian:trixie-slim',
    maxInputBytes: 20 * MiB,
    maxPages: 50,
    dpi: 150,
    maxLongSidePx: 2000,
    jpegQuality: 85,
    maxOutputBytes: 50 * MiB,
    workerMaxOutputBytes: 50 * MiB,
    renderTimeoutMs: 60_000,
    updateTimeoutMs: 5 * 60_000,
    workerHardTimeoutS: 75,
    workerMemoryMiB: 512,
    workerCpus: 1,
    workerPids: 64,
    workerTmpfsMiB: 128,
  };
}

/**
 * Runtime configuration. Only the listen address and the base image can be changed via the
 * environment; all limits stay at their defaults (tests pass their own values in code).
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const c = defaultConfig();
  if (env.PORT) {
    const p = Number(env.PORT);
    if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error('invalid PORT');
    c.port = p;
  }
  if (env.HOST) c.host = env.HOST;
  if (env.WORKER_BASE_IMAGE) {
    if (!/^[a-z0-9][a-z0-9._\-/:@]{0,254}$/i.test(env.WORKER_BASE_IMAGE)) throw new Error('invalid WORKER_BASE_IMAGE');
    c.baseImage = env.WORKER_BASE_IMAGE;
  }
  return c;
}
