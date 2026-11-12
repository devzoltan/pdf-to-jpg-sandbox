// Rebuilds the worker image (same code path as before every job) and verifies it without network.
import { spawnSync } from 'node:child_process';
import { loadConfig } from '../server/config.js';
import { buildWorkerImage, workerRunArgs } from '../server/docker.js';

const cfg = loadConfig();
console.log(`Rebuilding worker image (base ${cfg.baseImage}, --pull --no-cache, timeout ${cfg.updateTimeoutMs / 1000} s) …`);
try {
  const img = await buildWorkerImage(cfg);
  console.log(`Image ID:   ${img.imageId}`);
  console.log(`Build ID:   ${img.buildId}`);
  console.log(`Duration:   ${(img.durationMs / 1000).toFixed(1)} s`);
  // Self-test with the same hardened run options, without network
  const probe = spawnSync(
    cfg.dockerBin,
    workerRunArgs(cfg, 'aaaaaaaaaaaaaaaa0000', img.imageId, {
      entrypoint: '/bin/sh',
      cmd: ['-c', 'echo "User:       $(id -u)"; pdftoppm -v 2>&1 | head -n 1 | sed "s/^/Poppler:    /"'],
    }),
    { encoding: 'utf8', input: '' },
  );
  process.stdout.write(probe.stdout);
  if (probe.status !== 0) throw new Error('self-test failed');
  console.log('Update successful.');
} catch (e) {
  console.error(`Update failed: ${(e as Error).message.slice(0, 1000)}`);
  process.exit(1);
}
