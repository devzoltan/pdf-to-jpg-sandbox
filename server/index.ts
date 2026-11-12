import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { removeWorkerContainers } from './docker.js';

const cfg = loadConfig();
const app = buildApp(cfg);

// Remove leftovers of earlier runs (only this project's labelled workers)
const leftovers = await removeWorkerContainers(cfg);
if (leftovers) app.log.warn({ removed: leftovers }, 'removed leftover worker containers');

let stopping = false;
async function shutdown(sig: string) {
  if (stopping) return;
  stopping = true;
  app.log.info({ sig }, 'shutting down');
  try {
    await app.abortActiveJob();
    await removeWorkerContainers(cfg);
    await app.close();
  } finally {
    process.exit(0);
  }
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: cfg.host, port: cfg.port });
app.log.info(`pdf-to-jpg-sandbox: http://${cfg.host === '127.0.0.1' ? 'localhost' : cfg.host}:${cfg.port}`);
