// Minimaler Relay-Server: Räume, letzter Spielstand pro Raum, Weiterreichen an alle.
// Keine Spielregeln, keine Datenbank: Die Spielstände liegen in einer JSON-Datei
// (data/rooms.json), damit Spielfolgen Pausen und Neustarts überstehen.
// Liefert nebenbei den gebauten Client aus (dist/), sodass ein einziger Prozess genügt.
//
//   PORT=8787 DATA_DIR=./data node server/server.js

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT || 8787);
const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const DATA_DIR = process.env.DATA_DIR || path.join(DIST, '..', 'data');
const ROOMS_FILE = path.join(DATA_DIR, 'rooms.json');
const ROOM_TTL = 90 * 24 * 60 * 60 * 1000; // unbenutzte Räume nach 90 Tagen vergessen
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let file = path.normalize(path.join(DIST, decodeURIComponent(url.pathname)));
  if (!file.startsWith(DIST)) return res.writeHead(403).end();
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  fs.readFile(file, (err, data) => {
    if (err) return res.writeHead(404).end('Client nicht gebaut (npm run build).');
    const immutable = file.includes(`${path.sep}assets${path.sep}`);
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    res.end(data);
  });
});

/** @type {Map<string, {state: object|null, updated: number, clients: Map<import('ws').WebSocket, string>}>} */
const rooms = new Map();

// ---------- Speichern in einer JSON-Datei ----------

try {
  const saved = JSON.parse(fs.readFileSync(ROOMS_FILE, 'utf8'));
  for (const [code, r] of Object.entries(saved)) rooms.set(code, { state: r.state, updated: r.updated, clients: new Map() });
  console.log(`${rooms.size} Räume geladen`);
} catch (err) {
  if (err.code !== 'ENOENT') console.error('Spielstände nicht lesbar:', err.message);
}

const snapshot = () => {
  const out = {};
  for (const [code, r] of rooms) if (r.state) out[code] = { state: r.state, updated: r.updated };
  return JSON.stringify(out);
};

let saveTimer = null;
/** Schreibt gebündelt (höchstens einmal pro Sekunde) und atomar über eine Zwischendatei. */
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFile(`${ROOMS_FILE}.tmp`, snapshot(), (err) => {
      if (err) return console.error('Speichern fehlgeschlagen:', err.message);
      fs.rename(`${ROOMS_FILE}.tmp`, ROOMS_FILE, () => {});
    });
  }, 1000);
}

// Beim Beenden (docker stop) den letzten Stand sofort sichern.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(ROOMS_FILE, snapshot());
    } catch (err) {
      console.error('Speichern fehlgeschlagen:', err.message);
    }
    process.exit(0);
  });
}

setInterval(() => {
  const limit = Date.now() - ROOM_TTL;
  for (const [code, r] of rooms) {
    if (!r.clients.size && r.updated < limit) {
      rooms.delete(code);
      save();
    }
  }
}, 60 * 60 * 1000);

// ---------- Räume ----------
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 256 * 1024 });

const send = (ws, msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg));
const broadcast = (room, msg, except) => {
  for (const ws of room.clients.keys()) if (ws !== except) send(ws, msg);
};
const peers = (room) => [...new Set(room.clients.values())];

wss.on('connection', (ws) => {
  ws.alive = true;
  ws.on('pong', () => (ws.alive = true));

  ws.on('message', (raw) => {
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }

    if (m.t === 'join') {
      const code = String(m.room || '').toUpperCase();
      if (!/^[A-Z0-9]{4,8}$/.test(code) || typeof m.pid !== 'string') return send(ws, { t: 'error', code: 'bad' });
      let room = rooms.get(code);
      if (room && m.create) return send(ws, { t: 'error', code: 'exists' });
      if (!room) {
        if (!m.create && !m.resume) return send(ws, { t: 'error', code: 'noroom' });
        room = { state: m.resume || null, updated: Date.now(), clients: new Map() };
        rooms.set(code, room);
        if (room.state) save();
      }
      leave(ws);
      ws.room = room;
      ws.code = code;
      room.clients.set(ws, m.pid);
      send(ws, { t: 'joined', state: room.state });
      broadcast(room, { t: 'peers', pids: peers(room) });
      return;
    }

    const room = ws.room;
    if (m.t === 'state' && room && m.state && typeof m.state.v === 'number') {
      // Optimistische Nebenläufigkeit: Nur der direkte Nachfolger des gespeicherten Stands
      // wird angenommen. Wer zu spät kommt, erhält den aktuellen Stand und versucht es erneut.
      if (room.state && m.state.v !== room.state.v + 1) return send(ws, { t: 'reject', state: room.state });
      room.state = m.state;
      room.updated = Date.now();
      save();
      send(ws, { t: 'ok', v: m.state.v });
      broadcast(room, { t: 'state', state: m.state, anim: m.anim || null }, ws);
    }
  });

  ws.on('close', () => leave(ws));
});

function leave(ws) {
  const room = ws.room;
  if (!room) return;
  room.clients.delete(ws);
  ws.room = null;
  broadcast(room, { t: 'peers', pids: peers(room) });
  if (!room.clients.size && !room.state) rooms.delete(ws.code); // nie benutzter Raum
}

// Tote Verbindungen erkennen und Proxys am Schließen der Leitung hindern.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) {
      ws.terminate();
      continue;
    }
    ws.alive = false;
    ws.ping();
  }
}, 25000);

server.listen(PORT, () => console.log(`Würfel-Relay läuft auf Port ${PORT}`));
