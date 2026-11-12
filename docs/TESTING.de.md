# Tests

[English](TESTING.md) · **Deutsch**

Der kritische Pfad wird **ohne Mocks** getestet: Die Tests starten den echten HTTP-Server, bauen das echte Worker-Image und führen echte Docker-Container aus.
Alle Testdaten sind synthetisch und werden deterministisch von [`tests/fixtures.ts`](../tests/fixtures.ts) erzeugt – keine echten Dokumente.

## Tests ausführen

```bash
npm run typecheck   # Server, Frontend, Tests und Skripte
npm test            # Vitest: Integrations- und Lebenszyklustests mit echtem Docker-Worker (ca. 3 min)
npm run test:e2e    # Playwright/Chromium gegen den gebauten Server, Image-Neubau pro Auftrag (ca. 3 min)
```

Voraussetzungen: Docker, Node.js 24, Internetzugang (Image-Neubau). Für die Browsertests: `npx playwright install chromium`
(auf CI/Servern mit `--with-deps`, um die Systembibliotheken zu installieren). Dieselben Schritte laufen bei jedem Push in [GitHub Actions](../.github/workflows/ci.yml).

## Wie Inhalt und Reihenfolge geprüft werden

Jede Seite der erzeugten Test-PDFs trägt eine große Beschriftung „Page N“ **und** ein 6-Bit-Schwarz-Weiß-Muster, das N kodiert.
Die Tests dekodieren jedes erzeugte JPG ([`jpeg-js`](https://github.com/jpeg-js/jpeg-js)) und lesen das Muster zurück – so werden die tatsächlichen Pixel und die Seitenreihenfolge geprüft, ohne OCR.

## Abdeckung

| Bereich | Was geprüft wird | Wo |
| --- | --- | --- |
| Normale Umwandlung | 1 Seite → gültiges JPG (A4 → 1241×1754 px bei 150 DPI); 15 Seiten → Anzahl, Inhalt und Reihenfolge | `integration` 1, 2 |
| Seitengeometrie | Seiten mit 14400×14400, 14400×300 und 200×14400 pt → längste Seite ≤ 2000 px, Seitenverhältnis bleibt erhalten (proportional, kein Beschnitt); kleinere Grenze per Testkonfiguration | `integration` 6a, 6b |
| Ungültige Eingaben | leere Datei (400), umbenannte Textdatei (415), `%PDF-`-Kopf mit Datenmüll und abgeschnittene PDF (Ablehnung **durch den Worker**) | `integration` 4a–4d, `e2e` |
| Verschlüsselung | PDFs mit Öffnungspasswort und nur mit Besitzerpasswort → abgelehnt | `integration` 5, `e2e` |
| Grenzen | > 20 MiB (auch chunked) → 413; 51 Seiten → vor dem Rendern abgelehnt; Ausgabelimit im Worker **und** separat im Backend | `integration` 6c–6e |
| Fehler | Zeitüberschreitung beim Rendern → Container entfernt, nächster Auftrag erfolgreich; Speichermangel im Worker → gemeldet und bereinigt | `integration` 7a, 7b |
| Abbruch & Lebenszyklus | Abbruch durch den Client → Worker entfernt, Platz wieder frei; `SIGTERM` an das Backend während eines Auftrags → Worker vor Prozessende entfernt; `SIGKILL` → Neustart entfernt den Rest, ein fremder Container bleibt unberührt | `integration` 8, `lifecycle` 8b, 8c |
| Nebenläufigkeit | zwei parallele Anfragen → einmal `409 BUSY`, die andere korrekt | `integration` 9 |
| Abschottung | `docker inspect` eines laufenden Workers (Netzwerk `none`, read-only, nicht privilegiert, `CapDrop ALL`, `no-new-privileges`, Speicher/Swap, CPU, PIDs, Log-Treiber `none`, Auto-Remove, keine Mounts, nur tmpfs `/work`, Benutzer 10001, Image = ID des frischen Builds); funktionale Prüfung mit denselben Optionen (UID 10001, `/` nicht beschreibbar, `/work` beschreibbar, nur `lo`, tmpfs begrenzt) | `integration` 10a, 10b |
| Image-Aktualisierung | neues Image pro Auftrag, der Worker nutzt genau diese ID; ungültiges Basis-Image → `UPDATE_FAILED` ohne Worker-Start; Zeitlimit der Aktualisierung | `integration` 10c–10e |
| Browser | Dateiauswahl, Tastatur und Drag & Drop; Status und kein Doppelstart; Vorschau aus `blob:`-JPGs; JPG- und ZIP-Download mit Pixelprüfung; „Neue PDF“ gibt alle Object-URLs frei; nichts in Local/Session Storage, IndexedDB, Cache Storage oder Service Workern; `no-store`-Header; Mobilbreite ohne horizontales Scrollen; vergrößerte Ansicht (Bildschirm / 1:1, X und Esc, Fokus-Rückgabe, keine erneute Umwandlung); Umschaltung EN/DE inkl. URL-Parameter und Neuladen | `e2e` (4 Tests) |

Nach jedem Test wird geprüft, dass kein Container mit dem Projekt-Label übrig ist.

Testeinstellungen (kurze Zeitlimits, kleine Grenzen, vorgebautes Image) werden **im Code** an `buildApp()` übergeben; `npm start` verwendet immer die Standardwerte und baut das Image vor jedem Auftrag neu.

## Letzter lokaler Lauf (12.11.2026)

Umgebung: WSL2 (Ubuntu 22.04), Docker Desktop 29.9.3 (cgroup v2), Node.js 24, Chromium über Playwright 1.65.

| Befehl | Ergebnis |
| --- | --- |
| `npm run typecheck` | bestanden, 0 Fehler |
| `npm test` | **23 / 23 bestanden** (146 s) |
| `npm run test:e2e` | **4 / 4 bestanden** (2,5 min) |

Gemessen: Neubau des Worker-Images ca. 22–28 s; Rendern von 3 A4-Seiten ca. 1 s; ein vollständiger Auftrag im Browser (Neubau + 12 Seiten) ca. 25 s.

Nicht abgedeckt: andere Browser als Chromium, echte Mobilgeräte, rootless Docker / alternative Container-Runtimes.
