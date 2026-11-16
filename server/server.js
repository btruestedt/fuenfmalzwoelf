// Minimaler Relay-Server: Räume, letzter Spielstand pro Raum, Weiterreichen an alle.
// Keine Spielregeln, keine Datenbank. Liefert nebenbei den gebauten Client aus (dist/),
// sodass auf dem VPS ein einziger Prozess genügt.
//
//   PORT=8787 node server/server.js

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT || 8787);
const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const ROOM_TTL = 12 * 60 * 60 * 1000; // leere Räume nach 12 h vergessen
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

/** @type {Map<string, {state: object|null, clients: Map<import('ws').WebSocket, string>, timer: any}>} */
const rooms = new Map();
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
        room = { state: m.resume || null, clients: new Map(), timer: null };
        rooms.set(code, room);
      }
      clearTimeout(room.timer);
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
  if (!room.clients.size) room.timer = setTimeout(() => rooms.delete(ws.code), ROOM_TTL);
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
