# Fünf mal Zwölf

Würfelspiel als PWA: 3D-Würfel auf grünem Samt, Würfeln per Schütteln, gemeinsames Spielen über einen
Raumcode. „Fünf mal Zwölf“ ist nur ein Arbeitstitel (steht in `index.html`, `public/manifest.webmanifest`
und `src/main.js`).

## Regeln

Jeder sammelt die Zahlen 1–12 je fünfmal. Gewürfelt wird mit sechs Würfeln; eine Zahl zählt als
einzelner Würfel oder als Summe von zwei Würfeln. Nach dem ersten Wurf legt man sich auf eine Zahl fest,
alle Treffer werden herausgelegt, mit dem Rest wird weitergewürfelt. Sind alle Würfel verbraucht, geht es
wieder mit sechs weiter. Ist eine Zahl voll, wählt man aus den Restwürfeln (ohne neuen Wurf) die nächste.
Kein Treffer: Der Nächste ist dran, Gesammeltes bleibt. Wer zuerst alles voll hat, gewinnt sofort.

Wertung: Die Verlierer zählen ihre fehlenden Augen zusammen (jede fehlende Zahl mit ihrem Wert) und
bekommen sie als Minuspunkte, der Gewinner erhält die Summe als Pluspunkte. Über mehrere Runden im
selben Raum wird ein Gesamtstand mitgeführt.

Die Regeln stehen vollständig in `src/game.js`, die Grenzfälle sind in `test/game.test.js` festgehalten.

## Entwickeln

```bash
npm install
npm run server   # Relay auf Port 8787
npm run dev      # Client auf Port 5273 (leitet /ws an das Relay weiter)
npm test
```

„An einem Gerät spielen“ funktioniert ohne Relay.

## Aufbau

| Datei | Aufgabe |
|---|---|
| `src/game.js` | Spielregeln, reiner JSON-Zustand, ohne DOM und Netzwerk |
| `src/dice3d.js` | Three.js-Szene und Physik (cannon-es); der Wurf wird vorab simuliert und auf das feststehende Ergebnis „umetikettiert“ |
| `src/sound.js` | Synthetisierte Klänge (Web Audio), keine Audiodateien |
| `src/shake.js` | Schüttel-Erkennung (`devicemotion`, auf iOS mit Erlaubnis-Abfrage) |
| `src/net.js`, `server/server.js` | Raum-Relay über WebSocket; der Server kennt keine Regeln und merkt sich nur den letzten Stand |
| `src/main.js` | Oberfläche und Ablaufsteuerung |

## Auf den VPS bringen

Die App läuft als Docker-Container `fmz` hinter dem zentralen Caddy (Netz `edge`), erreichbar unter
`https://fmz.truestedt.de`. Der Caddy-Eintrag steht im Infra-Repo (`proxy/Caddyfile`).

Erstes Einrichten auf dem Server:

```bash
git clone https://github.com/btruestedt/fuenfmalzwoelf.git /srv/noeaux/fmz
cd /srv/noeaux/fmz
docker compose up -d --build
```

Aktualisieren:

```bash
cd /srv/noeaux/fmz && git pull && docker compose up -d --build
```

Ein Neustart beendet laufende Verbindungen nur kurz: Die Geräte verbinden sich neu und bringen den
Spielstand wieder mit.

HTTPS ist Pflicht: Ohne gibt es weder Bewegungssensor noch Installation als App.

Soll der Client woanders liegen (z. B. statisch auf dem PHP-Hosting), beim Bauen die Relay-Adresse angeben:
`VITE_WS_URL=wss://example.org/ws npm run build`.
