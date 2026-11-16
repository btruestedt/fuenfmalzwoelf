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
};
store.set('pid', app.myId);

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
  dispatch((st) => G.addPlayer(st, app.myId, app.name));
}

// ---------- Netzwerk ----------

function startOnline(code, create) {
  app.mode = 'online';
  app.room = code;
  history.replaceState(null, '', `#${code}`);
  app.net = new Net({
    room: code,
    pid: app.myId,
    create,
    getState: () => app.state,
    onStatus: (up) => {
      app.connected = up;
      render();
    },
    on: onNet,
  });
  render();
}

function onNet(m) {
  switch (m.t) {
    case 'joined':
      if (!m.state) {
        const s = G.newGame();
        G.addPlayer(s, app.myId, app.name);
        s.v = 1;
        app.net.send({ t: 'state', state: s });
        enqueue({ state: s, force: true });
      } else if (!app.state || m.state.v >= app.state.v) {
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
        leave(m.code === 'noroom' ? `Raum ${app.room} gibt es nicht (mehr).` : 'Beitritt nicht möglich.');
      }
      break;
  }
}

function leave(error = '') {
  app.net?.close();
  Object.assign(app, { mode: null, state: null, room: null, net: null, connected: false, peers: [], pending: null });
  queue.length = 0;
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
  if (screen === 'lobby') renderLobby(s);
  if (screen === 'game') renderGame(s);
}

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
      <button class="btn" data-act="start">Spiel starten</button>
      <p class="hint">${
        online
          ? 'Sobald alle da sind, kann jeder das Spiel starten.'
          : 'Das Gerät wird reihum weitergegeben. Auch alleine spielbar.'
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
          <span class="nm">${esc(p.name)}</span>
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
      <button class="icon ${sound.isMuted() ? 'off' : ''}" data-act="mute" aria-label="Ton">♪</button>
      <button class="icon" data-act="leave" aria-label="Spiel verlassen">×</button>
    </div>
    <div class="sheet">${cells}</div>`;

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
  const me = actor();
  const shakeHint = app.shake ? '<p class="sub">oder Handy schütteln</p>' : '';

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
    return `<p class="status"><b>${mine ? 'Du hast' : `${esc(playerName(s.winner))} hat`} gewonnen!</b></p>
      <div class="row">
        <button class="btn" data-act="again">Neue Runde</button>
        <button class="btn ghost" data-act="leave">Beenden</button>
      </div>`;
  }

  const t = s.turn;
  const cur = G.currentPlayer(s);
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
    return `<p class="status">${status}</p>${action}`;
  }
  if (t.step === 'chooseNumber') {
    if (!me) return `<p class="status">${who} wählt eine Zahl …</p>`;
    const btns = t.options
      .map((o) => `<button class="num" data-act="num" data-n="${o.n}">${o.n}<small>×${o.hits}</small></button>`)
      .join('');
    return `<p class="status">Welche Zahl sammeln?</p><div class="choices">${btns}</div>`;
  }
  if (t.step === 'chooseHits') {
    if (!me) return `<p class="status">${who} wählt die Würfel …</p>`;
    const btns = t.options
      .map((o, i) => {
        const groups = o.groups.map((ids) => ids.map((id) => miniDie(t.dice[id].v)).join('+')).join(' &nbsp; ');
        return `<button class="opt" data-act="hits" data-i="${i}">${groups}</button>`;
      })
      .join('');
    return `<p class="status">Mehr Treffer als nötig – welche Würfel nehmen?</p><div class="choices">${btns}</div>`;
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
  again: () => dispatch((s) => G.begin(s)),
  roll: doRoll,
  num: (el) => actor() && dispatch((s) => G.chooseNumber(s, Number(el.dataset.n))),
  hits: (el) => actor() && dispatch((s) => G.chooseHits(s, Number(el.dataset.i))),
  view(el) {
    app.viewPid = el.dataset.pid;
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
  leave() {
    const s = app.state;
    if (s && (s.phase === 'play' || s.phase === 'start') && !confirm('Spiel wirklich verlassen?')) return;
    leave();
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
  if (document.visibilityState === 'visible' && app.mode) navigator.wakeLock?.request('screen').catch(() => {});
});

// Start: Name und ggf. Raumcode aus dem Einladungslink vorbelegen.
$('#name').value = app.name;
const invited = location.hash.slice(1).toUpperCase();
if (/^[A-Z0-9]{4,8}$/.test(invited)) $('#code').value = invited;
render();

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
