# Deployment guide

**English** · [Deutsch](DEPLOYMENT.de.md)

This guide describes how to run the app on a Linux server as a systemd service behind a reverse proxy.
It is based on the locally tested version; items marked **⚠** depend on your environment and must be decided or verified during installation.

## 1. Architecture

```
Browser ──HTTPS──> Reverse proxy ──HTTP 127.0.0.1:8080──> Node.js backend (systemd service)
                                                            │ docker CLI (no shell)
                                                            ▼
                                         Docker Engine: a new worker container per job
                                         (no network, read-only, non-root, limits)
```

- The backend runs **directly on the host**, not in a container, and also serves the built frontend.
- Before **every** job the backend rebuilds the worker image (`docker build --pull --no-cache`) and starts a new container with exactly that image ID.
- The app has **no login**. Access must be restricted at network or proxy level (see 5).

## 2. Requirements

| Component | Requirement |
| --- | --- |
| OS | Linux x86_64 with systemd |
| Docker Engine | Current stable release, BuildKit (default), cgroup v2 recommended (for `--memory`, `--cpus`, `--pids-limit`) |
| Node.js | 24 LTS (see `.nvmrc`) with npm |
| Outbound network | Docker Hub (`registry-1.docker.io` etc.) and Debian mirrors (`deb.debian.org`, `security.debian.org`) – **for every job** |
| Resources | One job at a time: worker 1 CPU / 512 MiB; backend up to ~300 MiB peak; disk see section 7 |

**⚠ Outbound access / HTTP proxy:** Without registry and mirror access every job fails on purpose ("processing environment could not be updated").
Behind a corporate proxy configure it twice:
- Docker daemon (pulling the base image): `proxies` in `/etc/docker/daemon.json` or a systemd drop-in for `docker.service`.
- Builds (`apt-get` inside the Dockerfile): `proxies.default` in `~/.docker/config.json` of the service user; the Docker CLI passes it on as build arguments.

**⚠ Internal registry mirror:** set `WORKER_BASE_IMAGE` (e.g. `registry.example.com/library/debian:trixie-slim`). The per-job update is only meaningful if the mirror itself is kept up to date.

## 3. Installation

```bash
# Service user (name is up to you)
sudo useradd --system --create-home --home-dir /opt/pdf-to-jpg-sandbox --shell /usr/sbin/nologin pdf2jpg
sudo usermod -aG docker pdf2jpg          # ⚠ see the security note below

# Get the code and build it
sudo -u pdf2jpg -H bash -c '
  cd /opt/pdf-to-jpg-sandbox &&
  git clone https://github.com/devzoltan/pdf-to-jpg-sandbox.git app && cd app &&
  npm ci &&
  npm run build &&
  npm run worker:update        # builds and self-tests the worker image (image ID, UID 10001, Poppler version)
'
```

**⚠ Docker access:** members of the `docker` group are effectively root on the host. The backend needs Docker access to build and start workers,
but it never passes request data into Docker options (fixed argument list, no shell). Rootless Docker for the service user or a Docker API proxy that only allows
the required calls are possible alternatives **but not tested** – in particular `--memory`/`--cpus`/`--pids-limit` (cgroup v2 delegation) and the tmpfs option `uid=10001` must then be verified.

`npm ci` installs dev dependencies too; they are needed for `npm run build`, `npm run worker:update` and the tests.

## 4. systemd service

`/etc/systemd/system/pdf-to-jpg-sandbox.service` (example):

```ini
[Unit]
Description=PDF to JPG Sandbox
After=network-online.target docker.service
Wants=network-online.target
Requires=docker.service

[Service]
User=pdf2jpg
Group=pdf2jpg
WorkingDirectory=/opt/pdf-to-jpg-sandbox/app
Environment=NODE_ENV=production
Environment=PORT=8080
# HOST stays 127.0.0.1 (default); remote access only through the reverse proxy
# Environment=WORKER_BASE_IMAGE=registry.example.com/library/debian:trixie-slim
ExecStart=/usr/bin/node dist/server/index.js
# Graceful stop: a running job is aborted and its worker removed
KillSignal=SIGTERM
TimeoutStopSec=30
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now pdf-to-jpg-sandbox
curl -s http://127.0.0.1:8080/api/health     # {"ok":true,"busy":false}
journalctl -u pdf-to-jpg-sandbox -f          # JSON logs: job ID, phase, duration, error code – no file names or content
```

**⚠** Adjust the path to `node` (`which node`; differs between distro packages, NodeSource and nvm).
**⚠ Only one instance per Docker host:** on startup the backend removes all worker containers labelled `pdf-to-jpg-sandbox.managed=true`.

## 5. Reverse proxy (nginx example)

What the proxy needs to know about the app:
- Uploads up to 20 MiB (`application/pdf` request body).
- The response is a **stream** (NDJSON): status lines first, then the result (up to ~70 MiB, base64). Disable buffering, otherwise users see no status.
- Long requests are possible: image update up to 5 min + rendering up to 60 s.

```nginx
server {
    listen 443 ssl;
    server_name pdf.example.com;              # ⚠ adjust
    # ssl_certificate ... / ssl_certificate_key ...

    # ⚠ Restrict access – the app has no login
    # allow 10.0.0.0/8; deny all;   or   auth_basic / SSO in front of the proxy

    client_max_body_size 21m;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_buffering off;
        proxy_read_timeout 420s;
        proxy_send_timeout 420s;
    }
}
```

The app sets `Cache-Control: no-store`, a Content-Security-Policy and further security headers itself; the proxy should not override them.

## 6. Security summary

See [SECURITY.md](../SECURITY.md). Most important for operators: **no authentication** in the app, and the backend's Docker access is root-equivalent.

## 7. Disk space and Docker housekeeping

- The worker image is ~210 MB. After each successful rebuild the app removes older images of this project itself.
- **⚠ The build cache grows:** every rebuild adds build cache entries (locally ~2.9 GB after about 20 builds).
  The app deliberately does **not** run `docker system prune` / `builder prune`, because that would affect other projects on the same host.
  Limit BuildKit's garbage collection in `/etc/docker/daemon.json`, for example:

  ```json
  { "builder": { "gc": { "enabled": true, "defaultKeepStorage": "5GB" } } }
  ```

  (Choose the value with other workloads on the host in mind.)
- After a base image update an old, untagged `debian` image may remain (it has no project label and is not removed automatically).

## 8. Updating the app

```bash
sudo -u pdf2jpg -H bash -c 'cd /opt/pdf-to-jpg-sandbox/app && git pull && npm ci && npm run build'
sudo systemctl restart pdf-to-jpg-sandbox
```

## 9. Verification after installation

```bash
sudo -u pdf2jpg -H bash -c 'cd /opt/pdf-to-jpg-sandbox/app && npm run worker:update'   # image build and self-test
sudo -u pdf2jpg -H bash -c 'cd /opt/pdf-to-jpg-sandbox/app && npm test'                # integration tests with real Docker (~3–5 min)
# Optional browser tests need Chromium system libraries (root):  npx playwright install --with-deps chromium
```

**⚠** `npm test` starts its own worker containers and a test instance – do not run it while users are converting files (see "only one instance").

## 10. Uninstall

```bash
sudo systemctl disable --now pdf-to-jpg-sandbox && sudo rm /etc/systemd/system/pdf-to-jpg-sandbox.service
docker image ls --filter label=pdf-to-jpg-sandbox.managed=true -q | xargs -r docker image rm
sudo userdel -r pdf2jpg
```

## Checklist

- [ ] Outbound access to Docker Hub and Debian mirrors (proxy for daemon **and** build if needed) or an internal mirror (`WORKER_BASE_IMAGE`)
- [ ] Docker access of the service user decided consciously (`docker` group vs. rootless / API proxy – the latter needs testing)
- [ ] cgroup v2 available and limits effective (`npm test` checks the worker settings via `docker inspect`)
- [ ] Reverse proxy with HTTPS, 21 MiB uploads, buffering off, timeouts ≥ 7 min
- [ ] Access control (network / SSO / basic auth), since the app has no login
- [ ] BuildKit GC or disk monitoring for the build cache
- [ ] Only one instance per Docker host
- [ ] Logs (journald) and health check `/api/health` added to monitoring
