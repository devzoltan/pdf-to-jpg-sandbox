# Security

**English** · [Deutsch](SECURITY.de.md)

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's private vulnerability reporting instead:
**Security** tab → **Report a vulnerability**. Include steps to reproduce and, if possible, a synthetic sample file.
Only the latest version on `main` is supported.

## Threat model

The input – an uploaded PDF – is considered **untrusted**. PDF parsers have a long history of memory-safety bugs, so the design goal is
that a malicious PDF can at most crash or slow down a disposable worker, never reach the host, the network, other jobs or stored data.

| Risk | Mitigation |
| --- | --- |
| Exploit in the PDF parser (Poppler) | Parsing and rendering happen **only** inside the worker container: no network, read-only root FS, non-root UID 10001, all capabilities dropped, `no-new-privileges`, Docker's default seccomp profile. The backend never parses the PDF. |
| Outdated parser with known CVEs | The worker image is rebuilt **before every job** from a freshly pulled base image with `apt-get upgrade`, without build cache. A failed update stops the job instead of falling back to an old image. |
| Resource exhaustion (decompression bombs, huge pages, endless rendering) | Input ≤ 20 MiB (checked while streaming), ≤ 50 pages, longest side ≤ 2000 px (proportional DPI per page), 512 MiB RAM without swap, 1 CPU, 64 PIDs, 128 MiB tmpfs, 60 s backend timeout + hard 75 s limit in the container, output ≤ 50 MiB checked in the worker and in the backend, one job at a time. |
| Malicious worker output | The backend treats the worker's stdout as untrusted: byte limit on the raw stream, only `page-NNN.jpg` entries in order, JPEG signature and dimensions validated. |
| Command / option injection | Docker is started with a fixed argument list via `spawn` without a shell. File names, request data or PDF content never reach image names, commands or Docker options. The original file name is not even sent to the server. |
| Data leakage / persistence | No database, no files on disk (PDF and images only in memory and in the worker's tmpfs), `--log-driver none`, no browser storage, `Cache-Control: no-store`, no retrievable result URLs. Logs contain only a random job ID, phase, duration and error code. |
| Leftover containers | Every exit path removes the container and verifies its removal; leftovers from crashes are removed on startup (only containers carrying this project's label). |
| Browser-side injection | Strict Content-Security-Policy (`default-src 'self'`, no inline scripts/styles), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `frame-ancestors 'none'`. |

## Limitations – please read before deploying

- **No authentication or authorization.** Anyone who can reach the HTTP port can use the service. Keep it on `127.0.0.1` and put a reverse proxy with access control in front of it.
- **The backend needs access to the Docker daemon**, which is effectively root on the host. The backend is the trusted component; protect it accordingly. Rootless Docker or a restricted Docker API proxy may reduce this risk but are not tested.
- **Containers share the host kernel.** A kernel or container-runtime escape is outside what this project can prevent. For higher assurance, consider a sandboxed runtime such as gVisor (not tested).
- **Not an antivirus.** The rendered preview says nothing about whether the original PDF is harmless.
- **Availability:** one job at a time means a single slow PDF delays other users (by at most the timeouts above).
- Encrypted PDFs are rejected on purpose (no password handling).
