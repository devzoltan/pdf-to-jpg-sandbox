# Sicherheit

[English](SECURITY.md) · **Deutsch**

## Sicherheitslücken melden

Bitte **kein öffentliches Issue** für Sicherheitsprobleme anlegen, sondern die private Meldung von GitHub nutzen:
Reiter **Security** → **Report a vulnerability**. Bitte Schritte zur Reproduktion und, wenn möglich, eine synthetische Beispieldatei beifügen.
Unterstützt wird nur der aktuelle Stand auf `main`.

## Bedrohungsmodell

Die Eingabe – eine hochgeladene PDF – gilt als **nicht vertrauenswürdig**. PDF-Parser haben eine lange Geschichte von Speicherfehlern; Ziel ist daher,
dass eine bösartige PDF höchstens einen wegwerfbaren Worker abstürzen lässt oder verlangsamt, aber nie den Host, das Netzwerk, andere Aufträge oder gespeicherte Daten erreicht.

| Risiko | Gegenmaßnahme |
| --- | --- |
| Ausnutzung einer Lücke im PDF-Parser (Poppler) | Analyse und Rendern finden **ausschließlich** im Worker-Container statt: kein Netzwerk, schreibgeschütztes Root-Dateisystem, UID 10001 statt root, alle Capabilities entzogen, `no-new-privileges`, Standard-seccomp-Profil von Docker. Das Backend analysiert die PDF nie. |
| Veralteter Parser mit bekannten CVEs | Das Worker-Image wird **vor jedem Auftrag** aus einem frisch geladenen Basis-Image mit `apt-get upgrade` und ohne Build-Cache neu gebaut. Schlägt die Aktualisierung fehl, wird der Auftrag beendet statt mit einem alten Image zu arbeiten. |
| Ressourcenerschöpfung (Dekompressionsbomben, riesige Seiten, endloses Rendern) | Eingabe ≤ 20 MiB (beim Einlesen geprüft), ≤ 50 Seiten, längste Seite ≤ 2000 px (proportionale DPI je Seite), 512 MiB RAM ohne Swap, 1 CPU, 64 PIDs, 128 MiB tmpfs, 60 s Zeitlimit im Backend + harte Grenze von 75 s im Container, Ausgabe ≤ 50 MiB im Worker und im Backend geprüft, ein Auftrag gleichzeitig. |
| Bösartige Ausgabe des Workers | Das Backend behandelt stdout des Workers als nicht vertrauenswürdig: Byte-Grenze auf dem Rohstrom, nur Einträge `page-NNN.jpg` in Reihenfolge, JPEG-Signatur und Abmessungen werden geprüft. |
| Befehls- / Optionsinjektion | Docker wird mit fester Argumentliste über `spawn` ohne Shell gestartet. Dateinamen, Anfragedaten oder PDF-Inhalte gelangen nie in Image-Namen, Befehle oder Docker-Optionen. Der ursprüngliche Dateiname wird nicht einmal an den Server übertragen. |
| Datenabfluss / Speicherung | Keine Datenbank, keine Dateien auf der Platte (PDF und Bilder nur im Arbeitsspeicher und im tmpfs des Workers), `--log-driver none`, kein Browser-Speicher, `Cache-Control: no-store`, keine abrufbaren Ergebnis-URLs. Logs enthalten nur eine zufällige Auftrags-ID, Phase, Dauer und Fehlercode. |
| Zurückgebliebene Container | Jeder Ausstiegspfad entfernt den Container und prüft die Entfernung; Reste nach Abstürzen werden beim Start entfernt (nur Container mit dem Label dieses Projekts). |
| Injektion im Browser | Strenge Content-Security-Policy (`default-src 'self'`, keine Inline-Skripte/-Styles), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `frame-ancestors 'none'`. |

## Grenzen – vor dem Betrieb bitte lesen

- **Keine Authentifizierung oder Autorisierung.** Wer den HTTP-Port erreicht, kann den Dienst nutzen. Auf `127.0.0.1` belassen und einen Reverse Proxy mit Zugriffskontrolle vorschalten.
- **Das Backend benötigt Zugriff auf den Docker-Daemon**, was auf dem Host faktisch root-Rechten entspricht. Das Backend ist die vertrauenswürdige Komponente und entsprechend zu schützen. Rootless Docker oder ein eingeschränkter Docker-API-Proxy können das Risiko senken, sind aber nicht getestet.
- **Container teilen sich den Kernel des Hosts.** Ein Ausbruch über Kernel oder Container-Runtime liegt außerhalb dessen, was dieses Projekt verhindern kann. Für höhere Anforderungen kommt eine abgeschottete Runtime wie gVisor infrage (nicht getestet).
- **Kein Virenscanner.** Die Vorschau sagt nichts darüber aus, ob die ursprüngliche PDF unbedenklich ist.
- **Verfügbarkeit:** Da nur ein Auftrag gleichzeitig läuft, verzögert eine langsame PDF andere Nutzer (höchstens um die obigen Zeitgrenzen).
- Verschlüsselte PDFs werden bewusst abgelehnt (keine Passwortabfrage).
