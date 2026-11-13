'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const G = require('../src/game');

function setup() {
  const db = openDb(':memory:');
  const now = Date.now();
  const round = G.currentRound(db, now);
  const mk = (name, city = 'Chicago') => {
    const uid = db.run('INSERT INTO users (username, pass_hash, salt, created_at) VALUES (?, ?, ?, ?)', name, 'x', 'y', now).lastInsertRowid;
    return G.createPlayer(db, round, uid, name, city, now);
  };
  const fresh = (p) => db.get('SELECT * FROM players WHERE id = ?', p.id);
  return { db, now, round, mk, fresh };
}

test('turns accrue every interval and cap out', () => {
  const { db, now, mk, fresh } = setup();
  const p = mk('Tony');
  G.accrueTurns(db, p, now + 35 * 60 * 1000);
  assert.equal(fresh(p).turns, G.CONFIG.startTurns + 3 * G.CONFIG.turnsPerInterval);
  G.accrueTurns(db, p, now + 365 * 24 * G.HOUR);
  assert.equal(fresh(p).turns, G.CONFIG.maxTurns);
});

test('collecting pays cash and burns supplies; hiring costs cash and turns', () => {
  const { db, mk, fresh } = setup();
  let p = mk('Tony');
  const before = p.cash;
  G.work(db, p, 'collect', 10);
  p = fresh(p);
  assert.ok(p.cash > before, 'earned cash');
  assert.equal(p.turns, G.CONFIG.startTurns - 10);
  assert.ok(p.alcohol < G.START_KIT.alcohol, 'used alcohol');
  G.hire(db, p, 'hitman', 25);
  p = fresh(p);
  assert.equal(p.hitman, 25);
  assert.equal(p.turns, G.CONFIG.startTurns - 13);
  assert.throws(() => G.hire(db, p, 'card_dealer', 1e6), G.GameError);
});

test('safebox is capped at a quarter of net worth', () => {
  const { db, mk, fresh } = setup();
  let p = mk('Tony');
  const msg = G.deposit(db, p, p.cash);
  p = fresh(p);
  assert.equal(p.bank, G.bankCap(p) > p.bank ? p.bank : G.bankCap(p));
  assert.ok(p.bank <= Math.max(50000, G.networth(p) * 0.25));
  assert.match(msg, /safebox/);
});

test('attacks need the same city, no protection, and range', () => {
  const { db, now, mk, fresh } = setup();
  const a = mk('Tony'), b = mk('Sal'), c = mk('Vic', 'Miami');
  assert.throws(() => G.attack(db, a, b, 'raid', now), /protection/);
  G.leaveProtection(db, a, now); G.leaveProtection(db, b, now); G.leaveProtection(db, c, now);
  assert.throws(() => G.attack(db, fresh(a), fresh(c), 'raid', now), /Miami/);
  assert.throws(() => G.attack(db, fresh(a), fresh(b), 'driveby', now), /cars/);
  const r = G.attack(db, fresh(a), fresh(b), 'raid', now + 1);
  assert.match(r.report, /raid on Sal/);
  const news = db.all('SELECT * FROM events WHERE player_id = ?', b.id);
  assert.ok(news.some((e) => e.body.includes('Tony hit you')));
  assert.ok(G.isRevenge(db, fresh(b), fresh(a), now + 2));
});

test('a strong raid wins, steals cash and respects the hourly max', () => {
  const { db, now, mk, fresh } = setup();
  let a = mk('Tony'), b = mk('Sal');
  G.leaveProtection(db, a, now); G.leaveProtection(db, b, now);
  db.run('UPDATE players SET hitman = 200, ak47 = 200 WHERE id = ?', a.id);
  db.run('UPDATE players SET cash = 400000, bank = 1500000 WHERE id = ?', b.id);
  b = fresh(b);
  const nw = G.networth(b);
  const r = G.attack(db, fresh(a), b, 'raid', now + 1);
  assert.equal(r.won, true);
  b = fresh(b);
  const taken = db.get('SELECT SUM(nw_taken) AS s FROM attacks').s;
  assert.ok(taken > 0 && taken <= nw * G.CONFIG.maxHourlyLoss + 1, `took ${taken} of ${nw}`);
  // Keep hitting until maxed; then only drive-bys are allowed.
  for (let i = 0; i < 20 && G.hourlyAllowance(db, fresh(b), now + 2) > 0; i++) G.attack(db, fresh(a), fresh(b), 'raid', now + 2);
  assert.throws(() => G.attack(db, fresh(a), fresh(b), 'raid', now + 3), /maxed/);
  db.run('UPDATE players SET limo = 5 WHERE id = ?', a.id);
  assert.doesNotThrow(() => G.attack(db, fresh(a), fresh(b), 'driveby', now + 3));
});

test('families: create, request, accept, no friendly fire, boss hands over on leaving', () => {
  const { db, now, mk, fresh } = setup();
  const a = mk('Tony'), b = mk('Sal');
  db.run('UPDATE players SET cash = 500000 WHERE id = ?', a.id);
  G.createFamily(db, fresh(a), 'Corvo', now);
  const fam = db.get('SELECT * FROM families');
  G.requestJoin(db, b, fam.id, now);
  G.answerRequest(db, fresh(a), b.id, true, now);
  assert.equal(fresh(b).family_id, fam.id);
  G.leaveProtection(db, fresh(a), now); G.leaveProtection(db, fresh(b), now);
  assert.throws(() => G.attack(db, fresh(a), fresh(b), 'raid', now), /family/);
  G.leaveFamily(db, fresh(a), now);
  assert.equal(db.get('SELECT boss_id FROM families').boss_id, b.id);
  G.leaveFamily(db, fresh(b), now);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM families').n, 0);
});

test('a round that runs out is recorded and replaced', () => {
  const { db, now, round, mk } = setup();
  mk('Tony');
  const next = G.currentRound(db, round.ends_at + 1);
  assert.notEqual(next.id, round.id);
  const res = db.get('SELECT * FROM round_results WHERE round_id = ?', round.id);
  assert.equal(res.name, 'Tony');
  assert.ok(now < next.started_at);
});
