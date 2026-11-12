# Betriebsleitfaden

[English](DEPLOYMENT.md) · **Deutsch**

Dieser Leitfaden beschreibt den Betrieb auf einem Linux-Server als systemd-Dienst hinter einem Reverse Proxy.
Er beruht auf der lokal getesteten Version; mit **⚠** markierte Punkte hängen von der Umgebung ab und müssen bei der Installation entschieden oder geprüft werden.

## 1. Architektur

```
Browser ──HTTPS──> Reverse Proxy ──HTTP 127.0.0.1:8080──> Node.js-Backend (systemd-Dienst)
                                                           │ docker CLI (ohne Shell)
                                                           ▼
                                        Docker Engine: pro Auftrag ein neuer Worker-Container
                                        (kein Netzwerk, read-only, kein root, Limits)
```

- Das Backend läuft **direkt auf dem Host**, nicht im Container, und liefert auch das gebaute Frontend aus.
- Vor **jedem** Auftrag baut das Backend das Worker-Image neu (`docker build --pull --no-cache`) und startet einen neuen Container mit genau dieser Image-ID.
- Die Anwendung hat **keine Anmeldung**. Der Zugriff muss auf Netzwerk- oder Proxy-Ebene eingeschränkt werden (siehe 5).

## 2. Voraussetzungen

| Komponente | Anforderung |
| --- | --- |
| Betriebssystem | Linux x86_64 mit systemd |
| Docker Engine | Aktuelle stabile Version, BuildKit (Standard), cgroup v2 empfohlen (für `--memory`, `--cpus`, `--pids-limit`) |
| Node.js | 24 LTS (siehe `.nvmrc`) mit npm |
| Ausgehendes Netzwerk | Docker Hub (`registry-1.docker.io` u. a.) und Debian-Spiegel (`deb.debian.org`, `security.debian.org`) – **bei jedem Auftrag** |
| Ressourcen | Ein Auftrag gleichzeitig: Worker 1 CPU / 512 MiB; Backend bis ca. 300 MiB Spitze; Platte siehe Abschnitt 7 |

**⚠ Ausgehender Zugriff / HTTP-Proxy:** Ohne Zugang zu Registry und Spiegeln schlägt jeder Auftrag bewusst fehl („Verarbeitungsumgebung konnte nicht aktualisiert werden“).
Hinter einem Unternehmens-Proxy an zwei Stellen konfigurieren:
- Docker-Daemon (Laden des Basis-Images): `proxies` in `/etc/docker/daemon.json` oder ein systemd-Drop-in für `docker.service`.
- Builds (`apt-get` im Dockerfile): `proxies.default` in `~/.docker/config.json` des Dienstbenutzers; die Docker-CLI reicht ihn als Build-Argumente weiter.

**⚠ Interner Registry-Spiegel:** `WORKER_BASE_IMAGE` setzen (z. B. `registry.example.com/library/debian:trixie-slim`). Die Aktualisierung pro Auftrag ist nur sinnvoll, wenn der Spiegel selbst aktuell gehalten wird.

## 3. Installation

```bash
# Dienstbenutzer (Name frei wählbar)
sudo useradd --system --create-home --home-dir /opt/pdf-to-jpg-sandbox --shell /usr/sbin/nologin pdf2jpg
sudo usermod -aG docker pdf2jpg          # ⚠ siehe Sicherheitshinweis unten

# Code holen und bauen
sudo -u pdf2jpg -H bash -c '
  cd /opt/pdf-to-jpg-sandbox &&
  git clone https://github.com/devzoltan/pdf-to-jpg-sandbox.git app && cd app &&
  npm ci &&
  npm run build &&
  npm run worker:update        # baut und prüft das Worker-Image (Image-ID, UID 10001, Poppler-Version)
'
```

**⚠ Docker-Zugriff:** Mitglieder der Gruppe `docker` haben auf dem Host faktisch root-Rechte. Das Backend braucht Docker-Zugriff, um Worker zu bauen und zu starten,
übergibt aber nie Anfragedaten an Docker-Optionen (feste Argumentliste, keine Shell). Rootless Docker für den Dienstbenutzer oder ein Docker-API-Proxy, der nur die nötigen Aufrufe
erlaubt, sind mögliche Alternativen, **aber nicht getestet** – insbesondere `--memory`/`--cpus`/`--pids-limit` (cgroup-v2-Delegation) und die tmpfs-Option `uid=10001` müssen dann geprüft werden.

`npm ci` installiert auch die Entwicklungsabhängigkeiten; sie werden für `npm run build`, `npm run worker:update` und die Tests benötigt.

## 4. systemd-Dienst

`/etc/systemd/system/pdf-to-jpg-sandbox.service` (Beispiel):

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
# HOST bleibt 127.0.0.1 (Standard); Zugriff von außen nur über den Reverse Proxy
# Environment=WORKER_BASE_IMAGE=registry.example.com/library/debian:trixie-slim
ExecStart=/usr/bin/node dist/server/index.js
# Geordnetes Beenden: laufender Auftrag wird abgebrochen, Worker entfernt
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
journalctl -u pdf-to-jpg-sandbox -f          # JSON-Logs: Auftrags-ID, Phase, Dauer, Fehlercode – keine Dateinamen oder Inhalte
```

**⚠** Pfad zu `node` anpassen (`which node`; unterscheidet sich bei Distributionspaketen, NodeSource und nvm).
**⚠ Nur eine Instanz pro Docker-Host:** Beim Start entfernt das Backend alle Worker-Container mit dem Label `pdf-to-jpg-sandbox.managed=true`.

## 5. Reverse Proxy (Beispiel nginx)

Was der Proxy über die Anwendung wissen muss:
- Uploads bis 20 MiB (Anfragekörper `application/pdf`).
- Die Antwort ist ein **Strom** (NDJSON): zuerst Statuszeilen, dann das Ergebnis (bis ca. 70 MiB, Base64). Pufferung abschalten, sonst sehen Nutzer keinen Status.
- Lange Anfragen sind möglich: Image-Aktualisierung bis 5 min + Rendern bis 60 s.

```nginx
server {
    listen 443 ssl;
    server_name pdf.example.com;              # ⚠ anpassen
    # ssl_certificate ... / ssl_certificate_key ...

    # ⚠ Zugriff einschränken – die Anwendung hat keine Anmeldung
    # allow 10.0.0.0/8; deny all;   oder   auth_basic / SSO vor dem Proxy

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

Die Anwendung setzt `Cache-Control: no-store`, eine Content-Security-Policy und weitere Sicherheitsheader selbst; der Proxy sollte sie nicht überschreiben.

## 6. Sicherheit in Kürze

Siehe [SECURITY.de.md](../SECURITY.de.md). Für den Betrieb am wichtigsten: **keine Authentifizierung** in der Anwendung, und der Docker-Zugriff des Backends entspricht root-Rechten.

## 7. Plattenplatz und Docker-Aufräumen

- Das Worker-Image ist ca. 210 MB groß. Nach jedem erfolgreichen Neubau entfernt die Anwendung ältere Images dieses Projekts selbst.
- **⚠ Der Build-Cache wächst:** Jeder Neubau erzeugt neue Build-Cache-Einträge (lokal ca. 2,9 GB nach rund 20 Builds).
  Die Anwendung führt bewusst **kein** `docker system prune` / `builder prune` aus, weil das andere Projekte auf demselben Host beträfe.
  Die Garbage Collection von BuildKit in `/etc/docker/daemon.json` begrenzen, zum Beispiel:

  ```json
  { "builder": { "gc": { "enabled": true, "defaultKeepStorage": "5GB" } } }
  ```

  (Den Wert mit Blick auf andere Anwendungen auf dem Host festlegen.)
- Nach einer Aktualisierung des Basis-Images kann ein altes, unbenanntes `debian`-Image zurückbleiben (ohne Projekt-Label, wird nicht automatisch entfernt).

## 8. Anwendung aktualisieren

```bash
sudo -u pdf2jpg -H bash -c 'cd /opt/pdf-to-jpg-sandbox/app && git pull && npm ci && npm run build'
sudo systemctl restart pdf-to-jpg-sandbox
```

## 9. Prüfung nach der Installation

```bash
sudo -u pdf2jpg -H bash -c 'cd /opt/pdf-to-jpg-sandbox/app && npm run worker:update'   # Image-Build und Selbsttest
sudo -u pdf2jpg -H bash -c 'cd /opt/pdf-to-jpg-sandbox/app && npm test'                # Integrationstests mit echtem Docker (ca. 3–5 min)
# Optionale Browsertests benötigen Chromium-Systembibliotheken (root):  npx playwright install --with-deps chromium
```

**⚠** `npm test` startet eigene Worker-Container und eine Testinstanz – nicht ausführen, während Nutzer Dateien umwandeln (siehe „nur eine Instanz“).

## 10. Deinstallation

```bash
sudo systemctl disable --now pdf-to-jpg-sandbox && sudo rm /etc/systemd/system/pdf-to-jpg-sandbox.service
docker image ls --filter label=pdf-to-jpg-sandbox.managed=true -q | xargs -r docker image rm
sudo userdel -r pdf2jpg
```

## Checkliste

- [ ] Ausgehender Zugriff auf Docker Hub und Debian-Spiegel (ggf. Proxy für Daemon **und** Build) oder interner Spiegel (`WORKER_BASE_IMAGE`)
- [ ] Docker-Zugriff des Dienstbenutzers bewusst entschieden (`docker`-Gruppe vs. rootless / API-Proxy – letzteres testen)
- [ ] cgroup v2 vorhanden und Limits wirksam (`npm test` prüft die Worker-Einstellungen per `docker inspect`)
- [ ] Reverse Proxy mit HTTPS, 21 MiB Upload, Pufferung aus, Timeouts ≥ 7 min
- [ ] Zugriffskontrolle (Netzwerk / SSO / Basic Auth), da die Anwendung keine Anmeldung hat
- [ ] BuildKit-GC bzw. Plattenüberwachung für den Build-Cache
- [ ] Nur eine Instanz pro Docker-Host
- [ ] Logs (journald) und Health-Check `/api/health` ins Monitoring aufnehmen
