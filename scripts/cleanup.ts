// Removes leftover worker containers of this project (by label pdf-to-jpg-sandbox.managed=true only).
import { defaultConfig } from '../server/config.js';
import { removeWorkerContainers } from '../server/docker.js';

const n = await removeWorkerContainers(defaultConfig());
console.log(n ? `${n} worker container(s) removed.` : 'No worker containers found.');
