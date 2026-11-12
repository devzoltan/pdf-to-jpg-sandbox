# Testing

**English** · [Deutsch](TESTING.de.md)

The critical path is tested **without mocks**: tests start the real HTTP server, build the real worker image and run real Docker containers.
All test data is synthetic and generated deterministically by [`tests/fixtures.ts`](../tests/fixtures.ts) – no real documents.

## Running the tests

```bash
npm run typecheck   # server, frontend, tests and scripts
npm test            # Vitest: integration + lifecycle tests with a real Docker worker (~3 min)
npm run test:e2e    # Playwright/Chromium against the built server, image rebuild per job (~3 min)
```

Requirements: Docker, Node.js 24, internet access (image rebuild). For the browser tests: `npx playwright install chromium`
(on CI/servers `--with-deps` to install the system libraries). The same steps run in [GitHub Actions](../.github/workflows/ci.yml) on every push.

## How content and order are verified

Every page of the generated test PDFs carries a large "Page N" label **and** a 6-bit black/white pattern encoding N.
The tests decode each rendered JPEG ([`jpeg-js`](https://github.com/jpeg-js/jpeg-js)) and read the pattern back, so they check the actual pixels and the page order – without OCR.

## Coverage

| Area | What is checked | Where |
| --- | --- | --- |
| Regular conversion | 1 page → valid JPEG (A4 → 1241×1754 px at 150 DPI); 15 pages → count, content and order | `integration` 1, 2 |
| Page geometry | 14400×14400, 14400×300 and 200×14400 pt pages → longest side ≤ 2000 px, aspect ratio kept (proportional, no cropping); smaller limit via test config | `integration` 6a, 6b |
| Invalid input | empty file (400), renamed text file (415), `%PDF-` header + garbage and truncated PDF (rejected **by the worker**) | `integration` 4a–4d, `e2e` |
| Encryption | user-password and owner-password-only PDFs → rejected | `integration` 5, `e2e` |
| Limits | > 20 MiB (also chunked) → 413; 51 pages → rejected before rendering; output limit in the worker **and** separately in the backend | `integration` 6c–6e |
| Failures | render timeout → container gone, next job succeeds; out of memory in the worker → reported and cleaned up | `integration` 7a, 7b |
| Cancellation & lifecycle | client abort → worker removed, slot free again; backend `SIGTERM` during a job → worker removed before exit; backend `SIGKILL` → restart removes the leftover but leaves a foreign container untouched | `integration` 8, `lifecycle` 8b, 8c |
| Concurrency | two parallel requests → one `409 BUSY`, the other correct | `integration` 9 |
| Sandbox | `docker inspect` of a running worker (network `none`, read-only, not privileged, `CapDrop ALL`, `no-new-privileges`, memory/swap, CPU, PIDs, log driver `none`, auto-remove, no mounts, only tmpfs `/work`, user 10001, image = ID of the fresh build); functional probe with the same options (UID 10001, `/` not writable, `/work` writable, only `lo`, tmpfs capped) | `integration` 10a, 10b |
| Image update | new image per job and the worker uses exactly that ID; invalid base image → `UPDATE_FAILED` without starting a worker; update timeout | `integration` 10c–10e |
| Browser | file picker, keyboard and drag & drop; status and no double start; previews from `blob:` JPEGs; JPEG and ZIP downloads with pixel check; "New PDF" revokes all object URLs; nothing in local/session storage, IndexedDB, Cache Storage or service workers; `no-store` headers; mobile width without horizontal scrolling; enlarged view (fit / 1:1, X and Esc, focus return, no re-conversion); EN/DE switch incl. URL parameter and reload | `e2e` (4 tests) |

After every test the suite asserts that no container with the project label is left over.

Test-only settings (short timeouts, small limits, a pre-built image) are passed to `buildApp()` **in code**; `npm start` always uses the defaults and rebuilds the image before every job.

## Latest local run (2026-11-12)

Environment: WSL2 (Ubuntu 22.04), Docker Desktop 29.9.3 (cgroup v2), Node.js 24, Chromium via Playwright 1.65.

| Command | Result |
| --- | --- |
| `npm run typecheck` | passed, 0 errors |
| `npm test` | **23 / 23 passed** (146 s) |
| `npm run test:e2e` | **4 / 4 passed** (2.5 min) |

Measured: worker image rebuild ~22–28 s; rendering 3 A4 pages ~1 s; a full job in the browser (rebuild + 12 pages) ~25 s.

Not covered: browsers other than Chromium, real mobile devices, rootless Docker / alternative container runtimes.
