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
bekommen sie als Minuspunkte, der Gewinner erhält die Summe als Pluspunkte.

Spielfolge: In der Lobby legt man fest, wie viele Spiele eine Folge umfasst (1, 5, 10 oder 20; voreingestellt 5). Die
Punkte werden über die Folge addiert; wer am Ende vorn liegt, gewinnt die Folge.

Runden: Mitgezählt wird, wie oft jeder Spieler an der Reihe war. Am Spielende steht, in wie vielen Runden
der Gewinner fertig war und in welcher eigenen Runde jemand die 12 voll hatte. Die Spiele-Übersicht (Tipp
auf den Zähler „3/20“ oder am Spielende) zeigt das für alle Spiele der Folge.

## Später dazukommen

Bis zu acht Spieler. Wer beim Startwurf oder in der ersten Runde dazukommt, spielt sofort mit („Mitspielen“),
danach ab dem nächsten Spiel. Die Mitspieler können stattdessen das laufende Spiel mit allen neu beginnen.

## Spielernamen

Der zuletzt benutzte Name bleibt im Browser gespeichert und lässt sich auf der Startseite ändern; die Änderung
gilt beim nächsten Betreten des Raums auch im laufenden Spiel. Pro Raum ist jeder Name nur einmal erlaubt.

## Pausieren und Fortsetzen

Verlassen ist immer nur eine Pause, auch mitten in einem Spiel.

- **Online:** Der Server schreibt alle Räume in `data/rooms.json` (höchstens einmal pro Sekunde und beim
  Beenden). Räume, die 90 Tage niemand benutzt hat, werden gelöscht. Der Browser merkt sich den letzten
  Raum und bietet auf der Startseite „Raum … fortsetzen“ an; der Einladungslink funktioniert ebenfalls weiter.
- **An einem Gerät:** Der Stand liegt im `localStorage` des Browsers.
- **Anderes Gerät oder gelöschte Browserdaten:** Wer einen laufenden Raum betritt, ohne Mitspieler zu sein,
  kann einsteigen oder den Platz eines gerade abwesenden Spielers übernehmen. Eine Benutzerverwaltung gibt
  es bewusst nicht.

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
| `src/net.js`, `server/server.js` | Raum-Relay über WebSocket; der Server kennt keine Regeln und speichert pro Raum nur den letzten Stand |
| `src/main.js` | Oberfläche und Ablaufsteuerung |

## Auf den VPS bringen

Die App läuft als Docker-Container `fmz` hinter dem zentralen Caddy (Netz `edge`), erreichbar unter
`https://fmz.truestedt.de`. Der Caddy-Eintrag steht im Infra-Repo (`proxy/Caddyfile`).

Erstes Einrichten auf dem Server:

```bash
git clone https://github.com/btruestedt/fuenfmalzwoelf.git /srv/noeaux/fmz
cd /srv/noeaux/fmz
mkdir -p data          # für die Spielstände; muss dem Benutzer mit UID 1000 gehören
docker compose up -d --build
```

Aktualisieren:

```bash
cd /srv/noeaux/fmz && git pull && docker compose up -d --build
```

Ein Neustart beendet laufende Verbindungen nur kurz: Die Geräte verbinden sich neu, die Spielstände
kommen aus `data/rooms.json`.

HTTPS ist Pflicht: Ohne gibt es weder Bewegungssensor noch Installation als App.

Soll der Client woanders liegen (z. B. statisch auf dem PHP-Hosting), beim Bauen die Relay-Adresse angeben:
`VITE_WS_URL=wss://example.org/ws npm run build`.
