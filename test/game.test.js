import test from 'node:test';
import assert from 'node:assert/strict';
import * as G from '../src/game.js';

/** Partie mit Spieler A am Zug (A gewinnt den Startwurf). */
function started(names = ['A', 'B']) {
  const s = G.newGame();
  names.forEach((n) => G.addPlayer(s, n, n));
  G.begin(s);
  if (names.length > 1) names.forEach((n, i) => G.startRoll(s, n, 6 - i));
  return s;
}

test('Startwurf: höchste Zahl beginnt, bei Gleichstand würfeln nur die Besten erneut', () => {
  const s = G.newGame();
  ['A', 'B', 'C'].forEach((n) => G.addPlayer(s, n, n));
  G.begin(s);
  G.startRoll(s, 'A', 5);
  G.startRoll(s, 'B', 5);
  G.startRoll(s, 'C', 2);
  assert.equal(s.phase, 'start');
  assert.deepEqual(s.start.contenders, ['A', 'B']);
  assert.equal(G.startRoll(s, 'C', 6), false);
  G.startRoll(s, 'A', 1);
  G.startRoll(s, 'B', 3);
  assert.equal(s.phase, 'play');
  assert.equal(G.currentPlayer(s).id, 'B');
});

test('Beispiel aus den Regeln: 1,2,6,3,5,2 und 8er sammeln', () => {
  const s = started();
  G.roll(s, [1, 2, 6, 3, 5, 2]);
  assert.equal(s.turn.step, 'chooseNumber');
  assert.equal(s.turn.options.find((o) => o.n === 8).hits, 2);
  G.chooseNumber(s, 8);
  assert.equal(s.players[0].sheet[8], 2);
  assert.equal(s.turn.step, 'roll');
  assert.equal(G.activeDice(s.turn).length, 2);

  // Mit den zwei Restwürfeln ein weiterer 8er: alle verbraucht -> wieder sechs, Ziel bleibt.
  G.roll(s, [4, 4]);
  assert.equal(s.players[0].sheet[8], 3);
  assert.equal(s.turn.target, 8);
  assert.equal(G.activeDice(s.turn).length, 6);

  // Kein Treffer: der Nächste ist dran, Gesammeltes bleibt.
  G.roll(s, [1, 1, 1, 1, 1, 1]);
  assert.equal(s.current, 1);
  assert.equal(s.players[0].sheet[8], 3);
});

test('Alle Treffer müssen genommen werden (Einzelwürfel und Paare)', () => {
  const s = started();
  G.roll(s, [6, 3, 3, 1, 5, 2]);
  G.chooseNumber(s, 6); // 6, 3+3, 1+5
  assert.equal(s.players[0].sheet[6], 3);
  assert.equal(G.activeDice(s.turn).length, 1);
  assert.equal(s.turn.step, 'roll'); // Ziel 6 geht auch mit einem Würfel
});

test('Zahl fertig und alle Würfel verbraucht: neu würfeln mit freier Wahl', () => {
  const s = started();
  s.players[0].sheet[8] = 2;
  G.roll(s, [6, 2, 5, 3, 4, 4]);
  G.chooseNumber(s, 8);
  assert.equal(s.players[0].sheet[8], 5);
  assert.equal(s.turn.target, null);
  assert.equal(s.turn.step, 'roll');
  assert.equal(G.activeDice(s.turn).length, 6);
});

test('Überschuss gleicher Sorte: nur der nötige Treffer zählt, Rest bleibt für neue Zahl', () => {
  const s = started();
  s.players[0].sheet[8] = 4;
  G.roll(s, [6, 2, 6, 2, 1, 1]);
  G.chooseNumber(s, 8);
  assert.equal(s.players[0].sheet[8], 5);
  assert.equal(s.turn.step, 'chooseNumber');
  assert.equal(G.activeDice(s.turn).length, 4);
  assert.ok(!s.turn.options.some((o) => o.n === 8));
});

test('Überschuss verschiedener Sorten: Rückfrage; danach ein Restwürfel für Ziel > 6 beendet den Zug', () => {
  const s = started();
  s.players[0].sheet[3] = 4;
  G.roll(s, [3, 6, 2, 1, 4, 4]);
  G.chooseNumber(s, 3); // einzelne 3 oder 1+2, aber nur einer wird gebraucht
  assert.equal(s.turn.step, 'chooseHits');
  assert.equal(s.turn.options.length, 2);
  G.chooseHits(s, 0); // die einzelne 3
  assert.equal(s.players[0].sheet[3], 5);
  assert.equal(s.turn.step, 'chooseNumber');
  G.chooseNumber(s, 8); // 6+2 und 4+4 -> Rest: eine 1
  assert.equal(s.players[0].sheet[8], 2);
  assert.equal(s.current, 1);
  assert.equal(s.events.at(-1).reason, 'hopeless');
});

test('Keine offene Zahl aus den Restwürfeln: Zug endet', () => {
  const s = started();
  const sheet = s.players[0].sheet;
  sheet[8] = 3;
  sheet[1] = 5;
  sheet[2] = 5;
  G.roll(s, [6, 2, 5, 3, 1, 1]);
  G.chooseNumber(s, 8); // fertig, Rest 1,1 -> weder 1 noch 2 offen
  assert.equal(sheet[8], 5);
  assert.equal(s.current, 1);
  assert.equal(s.events.at(-1).reason, 'noOption');
});

test('Erster Wurf ohne offene Zahl: Zug sofort vorbei', () => {
  const s = started();
  const sheet = s.players[0].sheet;
  for (let n = 1; n <= 12; n++) sheet[n] = 5;
  sheet[12] = 4;
  G.roll(s, [1, 2, 3, 4, 5, 6]);
  assert.equal(s.current, 1);
});

test('Sieg, sobald die letzte Zahl voll ist; danach neue Runde möglich', () => {
  const s = started();
  const sheet = s.players[0].sheet;
  for (let n = 1; n <= 12; n++) sheet[n] = 5;
  sheet[12] = 4;
  G.roll(s, [6, 6, 1, 2, 3, 4]);
  G.chooseNumber(s, 12);
  assert.equal(s.phase, 'over');
  assert.equal(s.winner, 'A');
  assert.equal(G.roll(s, [1, 2, 3, 4]), false);
  assert.equal(G.begin(s), true);
  assert.equal(s.phase, 'start');
  assert.equal(s.players[0].sheet[12], 0);
});

test('Wertung: fehlende Augen als Minuspunkte, der Gewinner bekommt die Summe', () => {
  const s = started(['A', 'B', 'C']);
  for (let n = 1; n <= 12; n++) s.players.forEach((p) => (p.sheet[n] = 5));
  s.players[0].sheet[12] = 4;
  s.players[1].sheet[7] = 3; // fehlen 2 × 7 = 14
  s.players[1].sheet[1] = 0; // fehlen 5 × 1 = 5
  s.players[2].sheet[12] = 4; // fehlt 1 × 12 = 12
  G.roll(s, [6, 6, 1, 2, 3, 4]);
  G.chooseNumber(s, 12);
  assert.deepEqual(s.scores, { A: 31, B: -19, C: -12 });

  // Die Gesamtpunkte laufen über mehrere Runden mit.
  G.begin(s);
  ['A', 'B', 'C'].forEach((id, i) => G.startRoll(s, id, 6 - i));
  assert.equal(s.scores, null);
  for (let n = 1; n <= 12; n++) s.players[0].sheet[n] = 5;
  s.players[0].sheet[12] = 4;
  G.roll(s, [6, 6, 1, 2, 3, 4]);
  G.chooseNumber(s, 12);
  const perLoser = 5 * (12 * 13) / 2; // leeres Blatt: 390
  assert.deepEqual(s.players.map((p) => p.total), [31 + 2 * perLoser, -19 - perLoser, -12 - perLoser]);
});

test('Spielfolge: nach dem letzten Spiel geht es nur mit einer neuen Folge weiter', () => {
  const s = G.newGame();
  ['A', 'B'].forEach((n) => G.addPlayer(s, n, n));
  assert.equal(G.setSeries(s, 2), true);
  const playOut = () => {
    ['A', 'B'].forEach((id, i) => G.startRoll(s, id, 6 - i));
    for (let n = 1; n <= 12; n++) s.players[0].sheet[n] = 5;
    s.players[0].sheet[12] = 4;
    G.roll(s, [6, 6, 1, 2, 3, 4]);
    G.chooseNumber(s, 12);
  };
  G.begin(s);
  assert.equal(G.setSeries(s, 5), false); // nur in der Lobby änderbar
  playOut();
  assert.equal(s.round, 1);
  assert.equal(G.seriesDone(s), false);
  G.begin(s);
  playOut();
  assert.equal(s.round, 2);
  assert.equal(G.seriesDone(s), true);
  assert.equal(s.players[0].total, 780);
  assert.equal(G.begin(s), false);
  assert.equal(G.newSeries(s), true);
  assert.equal(s.round, 1);
  assert.deepEqual(s.players.map((p) => p.total), [0, 0]);
  assert.equal(s.phase, 'start');
});

test('Solo-Spiel: kein Startwurf, nach Zugende wieder selbst dran', () => {
  const s = started(['Solo']);
  assert.equal(s.phase, 'play');
  G.roll(s, [1, 1, 1, 1, 1, 1]);
  G.chooseNumber(s, 1); // fünf 1er reichen, die sechste 1 ergibt keine offene Zahl
  assert.equal(s.players[0].sheet[1], 5);
  assert.equal(s.current, 0);
  assert.equal(s.turn.step, 'roll');
  assert.equal(G.activeDice(s.turn).length, 6);
});
