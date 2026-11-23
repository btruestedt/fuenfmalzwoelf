import './style.css';
import * as G from './game.js';
import { DiceView } from './dice3d.js';
import * as sound from './sound.js';
import { enableShake, setShakeHandler } from './shake.js';
import { Net } from './net.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const store = {
  get: (k) => {
    try {
      return localStorage.getItem(`wuerfel.${k}`);
    } catch {
      return null;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(`wuerfel.${k}`, v);
    } catch {}
  },
};
const randomId = () => Math.random().toString(36).slice(2, 10);
const randomCode = () =>
  Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');
function rollDie() {
  const buf = new Uint8Array(1);
  do crypto.getRandomValues(buf);
  while (buf[0] >= 252); // 252 = 6 * 42: ohne Verzerrung
  return (buf[0] % 6) + 1;
}

const app = {
  mode: null, // 'local' | 'online'
  state: null,
  myId: store.get('pid') || randomId(),
  name: store.get('name') || '',
  room: null,
  net: null,
  connected: false,
  peers: [],
  pending: null, // zuletzt gesendete, noch nicht bestätigte Aktion
  viewPid: null, // angetippter Spieler, dessen Blatt gezeigt wird
  shake: false,
  overview: false, // Spiele-Übersicht eingeblendet
};
store.set('pid', app.myId);

/** Punkte mit Vorzeichen (echtes Minuszeichen). */
const pts = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0');

// ---------- Zwischenspeichern im Browser ----------
// Lokale Spiele leben nur hier; Online-Spiele liegen zusätzlich auf dem Server.

function persist() {
  if (app.mode === 'local') store.set('local', JSON.stringify(app.state));
  else if (app.mode === 'online') store.set('online', JSON.stringify({ room: app.room, state: app.state }));
}

function savedOnline(code) {
  try {
    const o = JSON.parse(store.get('online'));
    return o?.room === code ? o.state : null;
  } catch {
    return null;
  }
}

let invited = ''; // Raumcode aus dem Einladungslink
let view = null;
let viewFresh = true;

// ---------- Zustandsänderungen ----------

/** Wendet eine Spielaktion an, schickt das Ergebnis ggf. an die Mitspieler und zeigt es an. */
function dispatch(fn, anim = null) {
  if (app.mode === 'online' && !app.connected) return;
  const next = structuredClone(app.state);
  if (fn(next) === false) return;
  next.v = app.state.v + 1;
  if (app.mode === 'online') {
    app.pending = { fn };
    app.net.send({ t: 'state', state: next, anim });
  }
  enqueue({ state: next, anim });
}

// Eingehende Stände werden nacheinander abgearbeitet, damit Wurf-Animationen
// vollständig laufen, bevor das Ergebnis im Blatt erscheint.
const queue = [];
let pumping = false;

function enqueue(item) {
  queue.push(item);
  pump();
}

async function pump() {
  if (pumping) return;
  pumping = true;
  document.body.classList.add('busy');
  while (queue.length) {
    const it = queue.shift();
    if (!it.force && app.state && it.state.v <= app.state.v) continue;
    if (it.anim && view) {
      if (it.anim.solo) view.showOnly(it.anim.ids);
      await view.roll(it.anim.ids, it.anim.values);
    }
    if (app.state?.current !== it.state.current) app.viewPid = null;
    app.state = it.state;
    persist();
    render();
    if (!it.force) announce(it.state);
    it.then?.();
    maybeJoin();
  }
  pumping = false;
  document.body.classList.remove('busy');
}

/** Online: Wer den Raum betritt, trägt sich selbst in die Spielerliste ein. */
function maybeJoin() {
  const s = app.state;
  if (app.mode !== 'online' || app.pending || s.phase !== 'lobby') return;
  if (s.players.some((p) => p.id === app.myId)) return;
  dispatch((st) => G.join(st, app.myId, app.name));
}

// ---------- Netzwerk ----------

function startOnline(code, create) {
  app.mode = 'online';
  app.room = code;
  history.replaceState(null, '', `#${code}`);
  store.set('room', code);
  app.net = new Net({
    room: code,
    pid: app.myId,
    create,
    getState: () => app.state ?? savedOnline(code),
    onStatus: (up) => {
      app.connected = up;
      if (up) checkVersion(); // nach einem Server-Neustart liegt oft eine neue Version bereit
      render();
    },
    on: onNet,
  });
  render();
}

function onNet(m) {
  switch (m.t) {
    case 'joined':
      app.pending = null; // eine unbestätigte Aktion ging mit der alten Verbindung verloren
      if (!m.state) {
        const s = G.newGame();
        G.addPlayer(s, app.myId, app.name);
        s.v = 1;
        app.net.send({ t: 'state', state: s });
        enqueue({ state: s, force: true });
      } else {
        // Der Server hat recht, auch wenn hier schon ein nie angekommener Stand angezeigt wird.
        enqueue({ state: m.state, force: true });
      }
      break;
    case 'state':
      enqueue({ state: m.state, anim: m.anim });
      break;
    case 'ok':
      app.pending = null;
      break;
    case 'reject': {
      // Jemand war schneller (z. B. beim gleichzeitigen Startwurf): auf dessen Stand aufsetzen.
      const p = app.pending;
      app.pending = null;
      enqueue({ state: m.state, force: true, then: () => p && dispatch(p.fn) });
      break;
    }
    case 'peers':
      app.peers = m.pids;
      render();
      break;
    case 'error':
      if (m.code === 'exists') {
        app.net.close();
        startOnline(randomCode(), true);
      } else {
        if (m.code === 'noroom' && store.get('room') === app.room) store.set('room', '');
        leave(m.code === 'noroom' ? `Raum ${app.room} gibt es nicht (mehr).` : 'Beitritt nicht möglich.');
      }
      break;
  }
}

function leave(error = '') {
  app.net?.close();
  Object.assign(app, { mode: null, state: null, room: null, net: null, connected: false, peers: [], pending: null });
  queue.length = 0;
  app.overview = false;
  invited = '';
  history.replaceState(null, '', location.pathname);
  $('#home-error').textContent = error;
  $('#home-error').hidden = !error;
  render();
}

// ---------- Wer darf gerade handeln? ----------

const isLocal = () => app.mode === 'local';
const playerName = (pid) => app.state.players.find((p) => p.id === pid)?.name ?? '?';
const isMe = (pid) => !isLocal() && pid === app.myId;

/** ID des Spielers, für den dieses Gerät jetzt handeln darf – oder null. */
function actor() {
  const s = app.state;
  if (!s) return null;
  if (s.phase === 'start') {
    const waiting = s.start.contenders.filter((id) => s.start.rolls[id] == null);
    return isLocal() ? waiting[0] ?? null : waiting.includes(app.myId) ? app.myId : null;
  }
  if (s.phase === 'play') {
    const cur = G.currentPlayer(s).id;
    return isLocal() || cur === app.myId ? cur : null;
  }
  return null;
}

function doRoll() {
  const s = app.state;
  const pid = actor();
  if (!pid || pumping) return;
  if (s.phase === 'start') {
    const v = rollDie();
    dispatch((st) => G.startRoll(st, pid, v), { ids: [0], values: [v], solo: true });
  } else if (s.turn.step === 'roll') {
    const ids = G.activeDice(s.turn).map((d) => d.id);
    const values = ids.map(rollDie);
    dispatch((st) => G.roll(st, values), { ids, values });
  }
}

// ---------- Meldungen und Klänge ----------

let toastTimer = null;
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function announce(s) {
  const msgs = [];
  for (const e of s.events || []) {
    if (e.kind === 'take') {
      msgs.push(e.done ? `${e.count} × ${e.n} – die ${e.n} ist komplett!` : `${e.count} × ${e.n}`);
      e.done ? sound.complete() : sound.hit(e.count);
    } else if (e.kind === 'allUsed') {
      msgs.push('Alle Würfel verbraucht – wieder mit sechs');
    } else if (e.kind === 'end') {
      msgs.push(
        e.reason === 'bust'
          ? 'Kein Treffer'
          : e.reason === 'hopeless'
            ? `Ein Würfel reicht nicht für die ${e.n}`
            : 'Keine offene Zahl in den Restwürfeln',
      );
      if (s.players.length > 1) msgs.push(`${G.currentPlayer(s).name} ist dran`);
      sound.bust();
    } else if (e.kind === 'starter') {
      msgs.push(`${playerName(e.pid)} beginnt`);
    } else if (e.kind === 'tie') {
      msgs.push('Gleichstand – Stechen!');
    } else if (e.kind === 'win') {
      sound.win();
    }
  }
  if (msgs.length) toast(msgs.join(' · '));
}

// ---------- Darstellung ----------

function miniDie(v) {
  const on = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] }[v];
  return `<span class="md">${Array.from({ length: 9 }, (_, i) => `<i${on.includes(i) ? ' class="on"' : ''}></i>`).join('')}</span>`;
}

function render() {
  const s = app.state;
  const screen = !app.mode ? 'home' : !s ? 'wait' : s.phase === 'lobby' ? 'lobby' : 'game';
  for (const id of ['home', 'wait', 'lobby', 'game']) $(`#${id}`).hidden = id !== screen;
  if (screen === 'wait') $('#wait-title').textContent = `Verbinde mit Raum ${app.room} …`;
  if (screen === 'home') renderHome();
  if (screen === 'lobby') renderLobby(s);
  if (screen === 'game') renderGame(s);
  renderOverview(screen === 'game' ? s : null);
}

const rounds = (n) => (n === 1 ? 'einer Runde' : `${n} Runden`);

/** Spiele-Übersicht: je Spiel die Punkte, die Runden des Gewinners und wer wann die 12 voll hatte. */
function renderOverview(s) {
  const el = $('#overview');
  el.hidden = !s || !app.overview;
  if (el.hidden) return;
  const scrolled = el.querySelector('.ovwrap')?.scrollTop || 0;
  const games = s.history || [];
  const head = s.players.map((p) => `<th>${esc(p.name)}</th>`).join('');
  const body = games
    .map((h) => {
      const cells = s.players
        .map((p) => {
          const at = h.at12?.[p.id];
          if (h.scores[p.id] == null) return '<td>–</td>'; // war in diesem Spiel noch nicht dabei
          return `<td class="${p.id === h.winner ? 'win' : ''}">
              <b>${pts(h.scores[p.id])}</b>
              <small>${at ? `12 in R. ${at}` : '12 offen'}</small>
            </td>`;
        })
        .join('');
      return `<tr><td>${h.round}</td><td>${h.turns || '–'}</td>${cells}</tr>`;
    })
    .join('');
  const sum = s.players.map((p) => `<td><b>${pts(p.total || 0)}</b></td>`).join('');
  el.innerHTML = `<div class="card">
      <h2>Spiele-Übersicht</h2>
      ${
        games.length
          ? `<div class="ovwrap"><table class="ov">
              <tr><th>Spiel</th><th>Runden</th>${head}</tr>
              ${body}
              <tr class="sum"><td colspan="2">Gesamt</td>${sum}</tr>
            </table></div>
            <p class="hint">Runden: so oft war der Gewinner an der Reihe. Klein darunter steht, in welcher eigenen Runde ein Spieler die 12 voll hatte.</p>`
          : '<p class="hint">Noch ist kein Spiel dieser Folge beendet.</p>'
      }
      <button class="btn ghost small" data-act="overview">Schließen</button>
    </div>`;
  const wrap = el.querySelector('.ovwrap');
  if (wrap) wrap.scrollTop = scrolled;
}

function renderHome() {
  const items = [];
  const room = store.get('room');
  if (room) items.push(`<button class="btn" data-act="resume-room">Raum ${esc(room)} fortsetzen</button>`);
  if (store.get('local')) items.push('<button class="btn" data-act="resume-local">Spiel an diesem Gerät fortsetzen</button>');
  $('#resume').innerHTML = items.join('');
  // Über einen Einladungslink gekommen: Beitreten ist die Hauptsache, nicht ein eigenes Spiel.
  const inv = invited && invited !== room ? invited : '';
  $('#invite').innerHTML = inv ? `<button class="btn" data-act="join">Raum ${esc(inv)} beitreten</button>` : '';
  $('#create').classList.toggle('ghost', !!inv);
}

const COUNT = ['', '', 'zweit', 'dritt', 'viert', 'fünft', 'sechst', 'siebt', 'acht'];

function renderLobby(s) {
  const online = app.mode === 'online';
  const list = s.players
    .map(
      (p) => `<li>
        <span class="dot ${online && !app.peers.includes(p.id) ? 'off' : ''}"></span>
        <span class="nm">${esc(p.name)}</span>
        ${isMe(p.id) ? '<span class="tag">du</span>' : ''}
        ${!online && s.players.length > 1 ? `<button class="icon" data-act="remove" data-pid="${esc(p.id)}" aria-label="Entfernen">×</button>` : ''}
      </li>`,
    )
    .join('');
  const head = online
    ? `<p class="eyebrow">Raumcode</p>
       <div class="roomcode">${esc(app.room)}</div>
       <button class="btn ghost small" data-act="share">Einladungslink teilen</button>`
    : `<h2>Wer spielt mit?</h2>`;
  const add =
    !online && s.players.length < G.MAX_PLAYERS
      ? `<div class="join">
           <input id="add-name" maxlength="14" placeholder="Weiterer Name" />
           <button class="btn ghost small" data-act="add">Hinzufügen</button>
         </div>`
      : '';
  $('#lobby').innerHTML = `<div class="card">
      ${head}
      <ul class="plist">${list}</ul>
      ${add}
      <div class="seg" role="group" aria-label="Anzahl Spiele">
        <span class="lbl">Spiele in Folge</span>
        ${[1, 5, 10, 20]
          .map((n) => `<button class="${(s.series || 1) === n ? 'on' : ''}" data-act="series" data-n="${n}">${n}</button>`)
          .join('')}
      </div>
      <button class="btn" data-act="start">${online && s.players.length === 1 ? 'Allein starten' : s.players.length > 1 ? `Zu ${COUNT[s.players.length]} starten` : 'Spiel starten'}</button>
      <p class="hint">${
        online
          ? 'Bis zu acht Spieler. Wartet am besten, bis alle in der Liste stehen; dann kann jeder das Spiel starten. Der Stand bleibt gespeichert: Ihr könnt jederzeit pausieren und mit demselben Raumcode weiterspielen.'
          : 'Das Gerät wird reihum weitergegeben. Auch alleine spielbar. Der Stand bleibt auf diesem Gerät gespeichert.'
      }</p>
      <button class="btn ghost small" data-act="leave">Zurück</button>
    </div>`;
}

function renderGame(s) {
  const online = app.mode === 'online';
  const cur = s.phase === 'start' ? null : s.phase === 'over' ? s.winner : G.currentPlayer(s).id;
  const viewed =
    s.players.find((p) => p.id === app.viewPid) ||
    s.players.find((p) => p.id === (cur ?? app.myId)) ||
    s.players[0];
  const target = s.phase === 'play' && viewed.id === cur ? s.turn.target : null;

  const multi = (s.series || 1) > 1;
  const showTotals = multi && (s.round > 1 || s.phase === 'over');
  const chips = s.players
    .map((p) => {
      const got = p.sheet.slice(1).reduce((a, c) => a + Math.min(c, G.NEED), 0);
      const cls = [
        'chip',
        p.id === cur ? 'turn' : '',
        p.id === viewed.id ? 'viewed' : '',
        online && !app.peers.includes(p.id) ? 'off' : '',
      ].join(' ');
      return `<button class="${cls}" data-act="view" data-pid="${esc(p.id)}">
          <span class="nm">${esc(p.name)}${showTotals ? ` <em>${pts(p.total || 0)}</em>` : ''}</span>
          <span class="pg"><i style="width:${(got / (G.MAXN * G.NEED)) * 100}%"></i></span>
        </button>`;
    })
    .join('');
  const cells = Array.from({ length: G.MAXN }, (_, i) => {
    const n = i + 1;
    const c = Math.min(viewed.sheet[n], G.NEED);
    return `<div class="cell ${c >= G.NEED ? 'done' : ''} ${n === target ? 'target' : ''}">
        <b>${n}</b>
        <span class="pips">${'<i class="on"></i>'.repeat(c)}${'<i></i>'.repeat(G.NEED - c)}</span>
      </div>`;
  }).join('');
  $('#score').innerHTML = `<div class="bar">
      <div class="chips">${chips}</div>
      ${multi ? `<button class="round" data-act="overview" aria-label="Spiele-Übersicht">${s.round}/${s.series}</button>` : ''}
      <button class="icon ${sound.isMuted() ? 'off' : ''}" data-act="mute" aria-label="Ton">♪</button>
      <button class="icon" data-act="leave" aria-label="Spiel verlassen">×</button>
    </div>
    <div class="sheet">${cells}</div>`;
  // Passen nicht alle Spieler in die Leiste, wird sie geschoben: der Spieler am Zug bleibt sichtbar.
  const chipsEl = $('#score .chips');
  const turnChip = chipsEl.querySelector('.chip.turn');
  if (turnChip) chipsEl.scrollLeft = Math.max(0, turnChip.offsetLeft + turnChip.offsetWidth - chipsEl.clientWidth + 2);

  $('#controls').innerHTML = controlsHTML(s);
  $('#offline').hidden = !online || app.connected;

  if (!view && $('#table').clientWidth) {
    view = new DiceView($('#table'), { onImpact: sound.impact });
    viewFresh = true;
  }
  if (view) {
    if (s.phase === 'start') view.showOnly([0]);
    else {
      view.showAll();
      view.layout(s.turn, !viewFresh);
    }
    viewFresh = false;
  }
}

function controlsHTML(s) {
  const main = turnControlsHTML(s);
  const waiting = s.waiting || [];
  if (!waiting.length || !s.players.some((p) => isLocal() || p.id === app.myId)) return main;
  const names = waiting.map((w) => esc(w.name)).join(', ');
  const verb = waiting.length > 1 ? 'warten' : 'wartet';
  return s.phase === 'over'
    ? `${main}<p class="sub">Neu dabei im nächsten Spiel: ${names}</p>`
    : `${main}<p class="sub">${names} ${verb} auf das nächste Spiel · <button class="link" data-act="restart">jetzt neu beginnen</button></p>`;
}

function turnControlsHTML(s) {
  const me = actor();
  const shakeHint = app.shake ? '<p class="sub">oder Handy schütteln</p>' : '';

  // Online im laufenden Spiel, aber kein Mitspieler: zuschauen oder einen verwaisten Platz übernehmen.
  if (app.mode === 'online' && !s.players.some((p) => p.id === app.myId)) {
    const mode = G.joinMode(s, app.myId);
    if ((s.waiting || []).some((w) => w.id === app.myId)) {
      return '<p class="status">Du bist ab dem nächsten Spiel dabei</p><p class="sub">Bis dahin schaust du zu.</p>';
    }
    const free = s.players.filter((p) => !app.peers.includes(p.id));
    const seats = free
      .map((p) => `<button class="opt" data-act="seat" data-pid="${esc(p.id)}">${esc(p.name)}</button>`)
      .join('');
    const joinBtn = mode
      ? `<button class="btn" data-act="enter">${mode === 'now' ? 'Mitspielen' : 'Ab dem nächsten Spiel mitspielen'}</button>`
      : '';
    return `<p class="status">Das Spiel läuft schon</p>${joinBtn}${
      free.length ? `<p class="sub">Warst du schon dabei? Dann übernimm deinen Platz:</p><div class="choices">${seats}</div>` : ''
    }`;
  }

  if (s.phase === 'start') {
    const st = s.start;
    const rows = s.players
      .map((p) => {
        const need = st.contenders.includes(p.id) && st.rolls[p.id] == null;
        const shown = st.shown[p.id];
        return `<span class="${need ? 'need' : ''}">${esc(p.name)} ${shown ? miniDie(shown) : '–'}</span>`;
      })
      .join('');
    const action = me
      ? `<button class="btn" data-act="roll">${isLocal() ? `${esc(playerName(me))} würfelt` : 'Würfeln'}</button>${shakeHint}`
      : '<p class="sub">Warte auf die anderen …</p>';
    return `<p class="status">Wer beginnt? Die höchste Zahl fängt an.</p>
      <div class="start-list">${rows}</div>${action}`;
  }

  if (s.phase === 'over') {
    const mine = isMe(s.winner);
    const multi = (s.series || 1) > 1;
    const done = G.seriesDone(s);
    const showTotal = multi;
    const rank = (p) => (done && multi ? p.total || 0 : s.scores[p.id]);
    const rows = s.scores
      ? [...s.players]
          .sort((a, b) => rank(b) - rank(a))
          .map(
            (p) => `<tr class="${p.id === s.winner ? 'win' : ''}">
              <td>${esc(p.name)}</td>
              <td>${pts(s.scores[p.id])}</td>
              ${showTotal ? `<td>${pts(p.total || 0)}</td>` : ''}
              <td>${p.at12 ? `R. ${p.at12}` : '–'}</td>
            </tr>`,
          )
          .join('')
      : '';
    const table =
      rows && s.players.length > 1
        ? `<table class="scores">
            <tr><th></th><th>${showTotal ? 'Spiel' : 'Punkte'}</th>${showTotal ? '<th>Gesamt</th>' : ''}<th>12 voll</th></tr>
            ${rows}
          </table>`
        : '';
    const turns = s.players.find((p) => p.id === s.winner)?.turns;
    const inRounds = turns ? ` in ${rounds(turns)}` : '';
    const gameLine = `${mine ? 'Du hast' : `${esc(playerName(s.winner))} hat`}${inRounds} gewonnen`;
    let headline = `${gameLine}!`;
    let extra = '';
    if (done && multi && s.players.length > 1) {
      const best = Math.max(...s.players.map((p) => p.total || 0));
      const champs = s.players.filter((p) => (p.total || 0) === best);
      headline =
        champs.length > 1
          ? 'Die Spielfolge endet unentschieden!'
          : isMe(champs[0].id)
            ? 'Du gewinnst die Spielfolge!'
            : `${esc(champs[0].name)} gewinnt die Spielfolge!`;
      extra = `<p class="sub">Letztes Spiel: ${gameLine}</p>`;
    }
    return `${multi ? `<p class="sub">Spiel ${s.round} von ${s.series}${done ? ' – Folge beendet' : ''}</p>` : ''}
      <p class="status"><b>${headline}</b></p>
      ${extra}
      ${table}
      ${multi ? '<button class="link" data-act="overview">Spiele-Übersicht</button>' : ''}
      <div class="row">
        <button class="btn" data-act="again">${done ? (multi ? 'Neue Spielfolge' : 'Neues Spiel') : 'Nächstes Spiel'}</button>
        <button class="btn ghost" data-act="leave">${done ? 'Beenden' : 'Pause'}</button>
      </div>`;
  }

  const t = s.turn;
  const cur = G.currentPlayer(s);
  const series = (s.series || 1) > 1 ? `Spiel ${s.round} von ${s.series} · ` : '';
  const info = `<p class="sub">${series}<b class="rnd">Runde ${G.currentRound(s)}</b></p>`;
  const who = isMe(cur.id) ? 'Du' : esc(cur.name);
  const verb = (du, er) => (isMe(cur.id) ? du : er);
  if (t.step === 'roll') {
    const n = G.activeDice(t).length;
    const status =
      t.target != null
        ? `${who} ${verb('sammelst', 'sammelt')} die <b>${t.target}</b>`
        : `${who} ${verb('bist', 'ist')} dran – freie Wahl nach dem Wurf`;
    const action = me
      ? `<button class="btn" data-act="roll">${n === 6 ? 'Würfeln' : `Mit ${n === 1 ? 'einem Würfel' : `${n} Würfeln`} würfeln`}</button>${shakeHint}`
      : `<p class="sub">${who} würfelt mit ${n === 1 ? 'einem Würfel' : `${n} Würfeln`} …</p>`;
    return `${info}<p class="status">${status}</p>${action}`;
  }
  if (t.step === 'chooseNumber') {
    if (!me) return `${info}<p class="status">${who} wählt eine Zahl …</p>`;
    const btns = t.options
      .map((o) => `<button class="num" data-act="num" data-n="${o.n}">${o.n}<small>×${o.hits}</small></button>`)
      .join('');
    return `${info}<p class="status">Welche Zahl sammeln?</p><div class="choices">${btns}</div>`;
  }
  if (t.step === 'chooseHits') {
    if (!me) return `${info}<p class="status">${who} wählt die Würfel …</p>`;
    const btns = t.options
      .map((o, i) => {
        const groups = o.groups.map((ids) => ids.map((id) => miniDie(t.dice[id].v)).join('+')).join(' &nbsp; ');
        return `<button class="opt" data-act="hits" data-i="${i}">${groups}</button>`;
      })
      .join('');
    return `${info}<p class="status">Mehr Treffer als nötig – welche Würfel nehmen?</p><div class="choices">${btns}</div>`;
  }
  return '';
}

// ---------- Bedienung ----------

/** Alles, was eine Nutzergeste braucht: Ton, Bewegungssensor, Bildschirm wach halten. */
async function arm() {
  sound.unlock();
  navigator.wakeLock?.request('screen').catch(() => {});
  app.shake = await enableShake();
}

function readName() {
  app.name = $('#name').value.trim() || 'Spieler';
  store.set('name', app.name);
}

const actions = {
  async create() {
    readName();
    await arm();
    startOnline(randomCode(), true);
  },
  async join() {
    const code = $('#code').value.trim().toUpperCase();
    if (!/^[A-Z0-9]{4,8}$/.test(code)) return $('#code').focus();
    readName();
    await arm();
    startOnline(code, false);
  },
  async local() {
    readName();
    await arm();
    app.mode = 'local';
    const s = G.newGame();
    G.addPlayer(s, randomId(), app.name);
    enqueue({ state: s, force: true });
  },
  add() {
    const name = $('#add-name').value.trim();
    if (name) dispatch((s) => G.addPlayer(s, randomId(), name));
    $('#add-name')?.focus();
  },
  remove: (el) => dispatch((s) => G.removePlayer(s, el.dataset.pid)),
  start: () => dispatch((s) => G.begin(s)),
  /** Als Zuschauer ins laufende Spiel einsteigen. */
  enter: () => dispatch((s) => G.join(s, app.myId, app.name)),
  restart() {
    if (confirm('Das laufende Spiel verwerfen und mit allen neu beginnen?')) dispatch((s) => G.restart(s));
  },
  again: () => dispatch((s) => (G.seriesDone(s) ? G.newSeries(s) : G.begin(s))),
  roll: doRoll,
  num: (el) => actor() && dispatch((s) => G.chooseNumber(s, Number(el.dataset.n))),
  hits: (el) => actor() && dispatch((s) => G.chooseHits(s, Number(el.dataset.i))),
  view(el) {
    app.viewPid = el.dataset.pid;
    render();
  },
  update: applyUpdate,
  overview() {
    app.overview = !app.overview;
    render();
  },
  mute() {
    sound.setMuted(!sound.isMuted());
    render();
  },
  async share(el) {
    const url = `${location.origin}${location.pathname}#${app.room}`;
    try {
      if (navigator.share) await navigator.share({ title: 'Fünf mal Zwölf', text: `Würfel mit! Raum ${app.room}`, url });
      else {
        await navigator.clipboard.writeText(url);
        el.textContent = 'Link kopiert';
      }
    } catch {}
  },
  // Verlassen ist immer nur eine Pause: Der Stand bleibt gespeichert und lässt sich fortsetzen.
  leave: () => leave(),
  series: (el) => dispatch((s) => G.setSeries(s, Number(el.dataset.n))),
  async 'resume-room'() {
    readName();
    await arm();
    startOnline(store.get('room'), false);
  },
  async 'resume-local'() {
    await arm();
    try {
      const s = JSON.parse(store.get('local'));
      app.mode = 'local';
      enqueue({ state: s, force: true });
    } catch {
      store.set('local', '');
      render();
    }
  },
  /** Platz eines abwesenden Spielers übernehmen (neues Gerät, gelöschte Browserdaten). */
  seat(el) {
    dispatch((s) => G.leaveWaiting(s, app.myId));
    app.myId = el.dataset.pid;
    store.set('pid', app.myId);
    app.net.pid = app.myId;
    app.net.ws?.close(); // verbindet sich sofort unter der neuen Kennung wieder
  },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  sound.unlock();
  if (pumping && el.closest('#controls')) return;
  sound.tap();
  actions[el.dataset.act]?.(el);
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (e.target.id === 'add-name') actions.add();
  if (e.target.id === 'code') actions.join();
});

setShakeHandler(doRoll);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (app.mode) navigator.wakeLock?.request('screen').catch(() => {});
  checkVersion();
});

// ---------- Hinweis auf eine neue Version ----------
// Beim Bauen wird eine Kennung in den Code und in /version.json geschrieben. Weicht die Datei
// auf dem Server von der laufenden App ab, gibt es eine neuere Version.

const BUILD = __BUILD__;
let updateShown = false;

async function checkVersion() {
  if (import.meta.env.DEV || updateShown) return;
  try {
    const res = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' });
    const { build } = await res.json();
    if (!build || build === BUILD) return;
  } catch {
    return; // offline: später erneut versuchen
  }
  // Auf der Startseite geht nichts verloren: einmal still neu laden. Im Spiel nur hinweisen.
  let tried = null;
  try {
    tried = sessionStorage.getItem('wuerfel.reloaded');
    sessionStorage.setItem('wuerfel.reloaded', BUILD);
  } catch {}
  if (!app.mode && tried !== BUILD) return void applyUpdate();
  updateShown = true;
  $('#update').hidden = false;
}

async function applyUpdate() {
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    await reg?.update();
  } catch {}
  location.reload();
}

setInterval(checkVersion, 10 * 60 * 1000);
checkVersion();

// Start: Name und ggf. Raumcode aus dem Einladungslink vorbelegen.
$('#name').value = app.name;
$('#version').textContent = `Version ${BUILD}`;
function readInvite() {
  const code = location.hash.slice(1).toUpperCase();
  invited = /^[A-Z0-9]{4,8}$/.test(code) ? code : '';
  if (invited) $('#code').value = invited;
  render();
}
window.addEventListener('hashchange', () => !app.mode && readInvite());
readInvite();

// Nur im Entwicklungsmodus: Zugriff auf den Zustand, um Spielsituationen gezielt herzustellen.
if (import.meta.env.DEV) window.__dbg = { app, G, dispatch };

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
