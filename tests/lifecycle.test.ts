// Lifecycle of the real backend process: graceful shutdown, hard kill and restart.
import { afterAll, describe, expect, it } from 'vitest';
import { ChildProcess, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { noisyPdf } from './fixtures.js';
import { dockerOut, ourContainers, waitFor } from './helpers.js';

const PORT = 8095;
const base = `http://127.0.0.1:${PORT}`;
const procs: ChildProcess[] = [];

async function startServer(): Promise<ChildProcess> {
  const p = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  procs.push(p);
  const up = await waitFor(() => {
    const r = spawnSync('curl', ['-fsS', `${base}/api/health`], { encoding: 'utf8' });
    return r.status === 0;
  }, 30_000, 300);
  expect(up).toBe(true);
  return p;
}

function startJob(): Promise<unknown> {
  return noisyPdf(45).then((pdf) =>
    fetch(`${base}/api/convert`, { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: pdf as unknown as BodyInit })
      .then((r) => r.text())
      .catch((e: Error) => e),
  );
}

afterAll(() => {
  for (const p of procs) if (p.exitCode === null) p.kill('SIGKILL');
});

describe('Backend lifecycle', () => {
  it('8b: SIGTERM during processing removes the worker before the process exits', async () => {
    const srv = await startServer();
    const job = startJob();
    expect(await waitFor(() => ourContainers().length === 1, 120_000, 100)).toBe(true);
    const exited = new Promise((r) => srv.once('exit', r));
    srv.kill('SIGTERM');
    await exited;
    expect(ourContainers()).toEqual([]);
    await job;
  });

  it('8c: after a hard kill (SIGKILL) the restart cleans up only its own leftovers', async () => {
    const foreign = `p2j-test-foreign-${randomBytes(4).toString('hex')}`;
    const srv = await startServer();
    const job = startJob();
    expect(await waitFor(() => ourContainers().length === 1, 120_000, 100)).toBe(true);
    // A foreign container without the project label must not be touched
    const img = dockerOut(['image', 'ls', '-q', 'pdf-to-jpg-sandbox/worker:latest']);
    spawnSync('docker', ['run', '-d', '--rm', '--name', foreign, '--label', 'other.project=1', '--network', 'none', '--entrypoint', 'sleep', img, '120']);
    srv.kill('SIGKILL');
    await job;
    // The worker keeps running after the backend vanished (until its hard time limit)
    expect(ourContainers().length).toBe(1);
    const srv2 = await startServer();
    expect(await waitFor(() => ourContainers().length === 0, 15_000)).toBe(true);
    expect(dockerOut(['ps', '-q', '--filter', `name=${foreign}`])).not.toBe('');
    spawnSync('docker', ['rm', '-f', foreign]);
    const exited = new Promise((r) => srv2.once('exit', r));
    srv2.kill('SIGTERM');
    await exited;
  });
});
