// Reine Spiellogik – ohne DOM, ohne Netzwerk. Der Zustand ist reines JSON,
// damit er unverändert zwischen den Geräten verschickt werden kann.
// Alle Aktionen verändern den übergebenen Zustand und liefern false,
// wenn sie im aktuellen Zustand nicht erlaubt sind.

export const NEED = 5; // so oft muss jede Zahl gesammelt werden
export const MAXN = 12; // Zahlen 1..12
export const NDICE = 6;
export const MAX_PLAYERS = 8;

const emptySheet = () => Array(MAXN + 1).fill(0); // Index 0 bleibt ungenutzt
const freshDice = () =>
  Array.from({ length: NDICE }, (_, id) => ({ id, v: null, taken: false, g: null }));
const freshTurn = () => ({ dice: freshDice(), target: null, step: 'roll', options: null, groups: 0 });

export function newGame() {
  return {
    v: 0,
    phase: 'lobby',
    players: [],
    series: 5, // so viele Spiele umfasst eine Spielfolge
    round: 0, // laufendes Spiel innerhalb der Folge (1-basiert, 0 = noch nicht begonnen)
    current: 0,
    start: null,
    turn: null,
    events: [],
    winner: null,
    waiting: [], // Spätankömmlinge { id, name }, die ab dem nächsten Spiel mitspielen
    history: [], // beendete Spiele der laufenden Folge, siehe scoreRound()
  };
}

export function setSeries(s, n) {
  if (s.phase !== 'lobby' || !Number.isInteger(n) || n < 1 || n > 99) return false;
  s.series = n;
  return true;
}

/** Ist das letzte Spiel der Folge gespielt? */
export const seriesDone = (s) => (s.round || 0) >= (s.series || 1);

/** Nach dem Ende einer Folge: Gesamtpunkte zurücksetzen und von vorn beginnen. */
export function newSeries(s) {
  if (s.phase !== 'over') return false;
  s.players.forEach((p) => (p.total = 0));
  s.round = 0;
  s.history = [];
  return begin(s);
}

export function addPlayer(s, id, name) {
  if (s.phase !== 'lobby' || s.players.length >= MAX_PLAYERS) return false;
  if (s.players.some((p) => p.id === id)) return false;
  s.players.push(newPlayer(s, id, name));
  return true;
}

/** Neuer Spieler; gleiche Namen werden durchnummeriert („Spieler“, „Spieler 2“ …). */
function newPlayer(s, id, name) {
  const taken = (n) => s.players.some((p) => p.name === n);
  let unique = name;
  for (let i = 2; taken(unique); i++) unique = `${name} ${i}`;
  return { id, name: unique, sheet: emptySheet(), total: 0, turns: 0, at12: null };
}

/**
 * Wie kann jemand jetzt noch einsteigen? 'now' = sofort (Lobby, Startwurf, erste Runde),
 * 'next' = ab dem nächsten Spiel, null = gar nicht (schon dabei oder voll).
 */
export function joinMode(s, id) {
  const waiting = s.waiting || [];
  if (s.players.some((p) => p.id === id) || waiting.some((w) => w.id === id)) return null;
  if (s.players.length + waiting.length >= MAX_PLAYERS) return null;
  if (s.phase === 'lobby' || s.phase === 'start') return 'now';
  return s.phase === 'play' && s.players.every((p) => (p.turns || 0) <= 1) ? 'now' : 'next';
}

/** Einsteigen, auch wenn das Spiel schon läuft. */
export function join(s, id, name) {
  const mode = joinMode(s, id);
  if (!mode) return false;
  if (s.phase === 'lobby') return addPlayer(s, id, name);
  s.events = [];
  if (mode === 'next') {
    (s.waiting ||= []).push({ id, name });
    return true;
  }
  const p = newPlayer(s, id, name);
  if (s.phase === 'start') {
    // Läuft noch kein Stechen, darf der Neue beim Startwurf mitmachen.
    if (s.start.contenders.length === s.players.length) s.start.contenders.push(id);
    s.players.push(p);
  } else {
    s.players.splice(s.current + 1, 0, p); // kommt als Nächster dran
  }
  return true;
}

export function leaveWaiting(s, id) {
  const i = (s.waiting || []).findIndex((w) => w.id === id);
  if (i < 0) return false;
  s.waiting.splice(i, 1);
  s.events = [];
  return true;
}

/** Laufendes Spiel verwerfen und mit den Wartenden neu beginnen (zählt nicht als eigenes Spiel). */
export function restart(s) {
  if ((s.phase !== 'play' && s.phase !== 'start') || !s.waiting?.length) return false;
  s.round--;
  return setup(s);
}

/** Fehlende Augen eines Blatts: jede noch fehlende Zahl zählt mit ihrem Wert. */
export const missingPoints = (sheet) =>
  sheet.reduce((sum, count, n) => sum + (n ? Math.max(0, NEED - count) * n : 0), 0);

/**
 * Wertung am Spielende: Verlierer bekommen ihre fehlenden Augen als Minuspunkte,
 * der Gewinner die Summe davon als Pluspunkte. `total` läuft über mehrere Runden mit.
 */
function scoreRound(s) {
  const scores = {};
  let pot = 0;
  for (const p of s.players) {
    if (p.id === s.winner) continue;
    const m = missingPoints(p.sheet);
    scores[p.id] = -m;
    pot += m;
  }
  scores[s.winner] = pot;
  for (const p of s.players) p.total = (p.total || 0) + scores[p.id];
  s.scores = scores;
  // Für die Spiele-Übersicht: Runden des Gewinners und wer die 12 in welcher Runde voll hatte.
  const at12 = {};
  for (const p of s.players) at12[p.id] = p.at12 ?? null;
  (s.history ||= []).push({
    round: s.round,
    winner: s.winner,
    turns: s.players.find((p) => p.id === s.winner).turns || 0,
    at12,
    scores,
  });
}

export function removePlayer(s, id) {
  if (s.phase !== 'lobby') return false;
  const i = s.players.findIndex((p) => p.id === id);
  if (i < 0) return false;
  s.players.splice(i, 1);
  return true;
}

/** Startet eine (neue) Partie: Bögen leeren, Startwurf ansetzen. */
export function begin(s) {
  if (!s.players.length || s.phase === 'start' || s.phase === 'play') return false;
  if (s.phase === 'over' && seriesDone(s)) return false; // dann nur noch newSeries()
  return setup(s);
}

function setup(s) {
  for (const w of s.waiting || []) s.players.push(newPlayer(s, w.id, w.name));
  s.waiting = [];
  s.players.forEach((p) => {
    p.sheet = emptySheet();
    p.turns = 0; // so oft war der Spieler in diesem Spiel an der Reihe („Runden“)
    p.at12 = null; // Runde, in der die 12 voll wurde
  });
  s.winner = null;
  s.scores = null;
  s.round = (s.round || 0) + 1;
  s.events = [];
  if (s.players.length === 1) {
    s.phase = 'play';
    s.current = 0;
    s.start = null;
    s.turn = freshTurn();
  } else {
    s.phase = 'start';
    s.turn = null;
    s.start = { contenders: s.players.map((p) => p.id), rolls: {}, shown: {} };
  }
  return true;
}

/** Startwurf mit einem Würfel; bei Gleichstand würfeln nur die Besten erneut. */
export function startRoll(s, pid, value) {
  if (s.phase !== 'start') return false;
  const st = s.start;
  if (!st.contenders.includes(pid) || st.rolls[pid] != null) return false;
  s.events = [];
  st.rolls[pid] = value;
  st.shown[pid] = value;
  if (st.contenders.every((id) => st.rolls[id] != null)) {
    const max = Math.max(...st.contenders.map((id) => st.rolls[id]));
    const top = st.contenders.filter((id) => st.rolls[id] === max);
    if (top.length === 1) {
      s.current = s.players.findIndex((p) => p.id === top[0]);
      s.phase = 'play';
      s.turn = freshTurn();
      s.events.push({ kind: 'starter', pid: top[0] });
    } else {
      st.contenders = top;
      st.rolls = {};
      s.events.push({ kind: 'tie', pids: top });
    }
  }
  return true;
}

/**
 * Alle Treffer für eine Zielzahl: einzelne Würfel (nur 1–6) und Zweierpaare.
 * Einzelwürfel und die verschiedenen Paar-Typen nutzen jeweils andere Augenzahlen,
 * deshalb ist die maximale Trefferzahl eindeutig.
 */
export function hitGroups(dice, target) {
  const by = {};
  for (const d of dice) (by[d.v] ||= []).push(d.id);
  const out = [];
  if (target <= 6) for (const id of by[target] || []) out.push({ key: `${target}`, ids: [id] });
  for (let a = 1; a <= target / 2; a++) {
    const b = target - a;
    if (b > 6) continue;
    const A = by[a] || [];
    const B = by[b] || [];
    if (a === b) {
      for (let i = 0; i + 1 < A.length; i += 2) out.push({ key: `${a}+${b}`, ids: [A[i], A[i + 1]] });
    } else {
      for (let i = 0; i < Math.min(A.length, B.length); i++) out.push({ key: `${a}+${b}`, ids: [A[i], B[i]] });
    }
  }
  return out;
}

/** Offene Zahlen, die sich mit den gegebenen Würfeln sammeln lassen. */
export function numberOptions(sheet, dice) {
  const out = [];
  for (let n = 1; n <= MAXN; n++) {
    if (sheet[n] >= NEED) continue;
    const g = hitGroups(dice, n).length;
    if (g) out.push({ n, hits: Math.min(g, NEED - sheet[n]) });
  }
  return out;
}

export const activeDice = (turn) => turn.dice.filter((d) => !d.taken);
export const currentPlayer = (s) => s.players[s.current];

/** Runde, in der sich der aktuelle Spieler gerade befindet (zählt ab seinem ersten Wurf). */
export const currentRound = (s) => (currentPlayer(s).turns || 0) + (s.turn.counted ? 0 : 1);

/** Wurf des aktuellen Spielers; values gehört zu den noch nicht herausgelegten Würfeln. */
export function roll(s, values) {
  if (s.phase !== 'play' || s.turn.step !== 'roll') return false;
  const act = activeDice(s.turn);
  if (values.length !== act.length) return false;
  s.events = [];
  if (!s.turn.counted) {
    // Erster Wurf dieses Zugs: Für den Spieler beginnt eine neue Runde.
    s.turn.counted = true;
    const p = currentPlayer(s);
    p.turns = (p.turns || 0) + 1;
  }
  act.forEach((d, i) => (d.v = values[i]));
  if (s.turn.target == null) return offerNumbers(s, 'bust');
  const groups = hitGroups(act, s.turn.target);
  if (!groups.length) return endTurn(s, 'bust');
  return take(s, groups);
}

export function chooseNumber(s, n) {
  if (s.phase !== 'play' || s.turn.step !== 'chooseNumber') return false;
  if (!s.turn.options.some((o) => o.n === n)) return false;
  s.events = [];
  s.turn.target = n;
  return take(s, hitGroups(activeDice(s.turn), n));
}

/** Nur nötig, wenn mehr Treffer liegen als noch gebraucht werden. */
export function chooseHits(s, index) {
  if (s.phase !== 'play' || s.turn.step !== 'chooseHits') return false;
  const opt = s.turn.options[index];
  if (!opt) return false;
  s.events = [];
  return commit(s, opt.groups.map((ids) => ({ ids })));
}

function offerNumbers(s, reasonIfNone) {
  const t = s.turn;
  const opts = numberOptions(currentPlayer(s).sheet, activeDice(t));
  if (!opts.length) return endTurn(s, reasonIfNone);
  t.target = null;
  t.step = 'chooseNumber';
  t.options = opts;
  return true;
}

function take(s, groups) {
  const t = s.turn;
  const need = NEED - currentPlayer(s).sheet[t.target];
  if (groups.length <= need) return commit(s, groups); // alle Treffer müssen genommen werden
  const cs = combos(groups, need);
  if (cs.length === 1) return commit(s, cs[0]);
  t.step = 'chooseHits';
  t.options = cs.map((c) => ({ groups: c.map((g) => g.ids) }));
  return true;
}

/** Alle unterscheidbaren Möglichkeiten, `need` Treffer aus den Gruppen zu wählen. */
function combos(groups, need) {
  const types = [];
  for (const g of groups) {
    const t = types.find((x) => x.key === g.key);
    if (t) t.list.push(g);
    else types.push({ key: g.key, list: [g] });
  }
  const out = [];
  const walk = (i, left, acc) => {
    if (left === 0) return void out.push(acc);
    if (i >= types.length) return;
    for (let k = Math.min(left, types[i].list.length); k >= 0; k--) {
      walk(i + 1, left - k, acc.concat(types[i].list.slice(0, k)));
    }
  };
  walk(0, need, []);
  return out;
}

function commit(s, groups) {
  const t = s.turn;
  const p = currentPlayer(s);
  for (const g of groups) {
    for (const id of g.ids) {
      t.dice[id].taken = true;
      t.dice[id].g = t.groups;
    }
    t.groups++;
  }
  p.sheet[t.target] += groups.length;
  const done = p.sheet[t.target] >= NEED;
  if (done && t.target === MAXN) p.at12 = p.turns;
  s.events.push({ kind: 'take', pid: p.id, n: t.target, count: groups.length, done });
  t.options = null;

  if (p.sheet.slice(1).every((c) => c >= NEED)) {
    s.phase = 'over';
    s.winner = p.id;
    t.step = 'done';
    scoreRound(s);
    s.events.push({ kind: 'win', pid: p.id });
    return true;
  }

  const left = activeDice(t);
  if (done) t.target = null;
  if (!left.length) {
    // Alle Würfel verbraucht: wieder mit allen sechs würfeln.
    t.dice = freshDice();
    t.groups = 0;
    t.step = 'roll';
    s.events.push({ kind: 'allUsed', pid: p.id });
    return true;
  }
  if (done) return offerNumbers(s, 'noOption'); // neue Zahl aus den Restwürfeln, ohne zu würfeln
  if (left.length === 1 && t.target > 6) return endTurn(s, 'hopeless');
  t.step = 'roll';
  return true;
}

function endTurn(s, reason) {
  s.events.push({ kind: 'end', pid: currentPlayer(s).id, reason, n: s.turn.target });
  s.current = (s.current + 1) % s.players.length;
  s.turn = freshTurn();
  return true;
}
