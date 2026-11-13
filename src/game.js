'use strict';
// Game rules. Every function that changes state takes the db handle and a fresh player row,
// and throws GameError with a player-facing message when an action isn't allowed.

const env = (k, d) => (process.env[k] !== undefined ? Number(process.env[k]) : d);

const CONFIG = {
  roundDays: env('ROUND_DAYS', 10),
  turnIntervalMin: env('TURN_INTERVAL_MIN', 10),
  turnsPerInterval: env('TURNS_PER_INTERVAL', 10),
  maxTurns: env('MAX_TURNS', 3000),
  startTurns: env('START_TURNS', 300),
  protectionHours: env('PROTECTION_HOURS', 12),
  maxHourlyLoss: env('MAX_HOURLY_LOSS', 0.1),   // share of a player's net worth others can take per hour
  familyCost: env('FAMILY_COST', 100000),
  familyMax: env('FAMILY_MAX', 10),
};

const HOUR = 3600 * 1000;

class GameError extends Error {}
const fail = (msg) => { throw new GameError(msg); };

const CITIES = ['New York', 'Chicago', 'Las Vegas', 'Miami', 'Atlantic City'];

// Crew. Operatives earn, muscle fights.
const UNITS = {
  card_dealer: { name: 'Card Dealer', plural: 'Card Dealers', price: 2500, kind: 'op', desc: 'Runs casino tables. Earns $45 per turn collected.' },
  hustler:     { name: 'Hustler',     plural: 'Hustlers',     price: 1000, kind: 'op', desc: 'Collects loan shark payments. Earns $30 per turn collected.' },
  punk:        { name: 'Punk',        plural: 'Punks',        price: 500,  kind: 'op', desc: 'Runs a gambling den. Earns $20 per turn collected.' },
  bootlegger:  { name: 'Bootlegger',  plural: 'Bootleggers',  price: 1500, kind: 'op', desc: 'Distills 3 alcohol per turn produced.' },
  hitman:      { name: 'Hitman',      plural: 'Hitmen',       price: 1000, kind: 'mus', atk: 12, def: 6, desc: 'Best attacker. Attack 12, defense 6.' },
  thug:        { name: 'Thug',        plural: 'Thugs',        price: 500,  kind: 'mus', atk: 5,  def: 5, desc: 'All-rounder that also cooks weed and coke in the lab. Attack 5, defense 5.' },
  bodyguard:   { name: 'Bodyguard',   plural: 'Bodyguards',   price: 300,  kind: 'mus', atk: 1,  def: 7, desc: 'Cheap and tough on defense, useless on offense. Attack 1, defense 7.' },
};
const OPS = Object.keys(UNITS).filter((k) => UNITS[k].kind === 'op');
const MUSCLE = Object.keys(UNITS).filter((k) => UNITS[k].kind === 'mus');

const WEAPONS = {
  ak47:    { name: 'AK-47',   price: 4000, mult: 4 },
  uzi:     { name: 'Uzi',     price: 2000, mult: 3 },
  shotgun: { name: 'Shotgun', price: 800,  mult: 2 },
  glock:   { name: 'Glock',   price: 400,  mult: 1.5 },
};
const UNARMED = 0.5;

const GOODS = {
  alcohol: { name: 'Alcohol', price: 3 },
  weed:    { name: 'Weed',    price: 6 },
  coke:    { name: 'Coke',    price: 15 },
};

const CARS = {
  sedan: { name: 'Sedan', price: 8000,  seats: 5 },
  limo:  { name: 'Limo',  price: 40000, seats: 10 },
};

const MARKET = { ...WEAPONS, ...GOODS, ...CARS };
const SELL_RATE = 0.5;

const ATTACKS = {
  raid:    { name: 'Raid headquarters', noun: 'raid', turns: 5, desc: 'Kill their muscle and steal the cash they carry.' },
  extort:  { name: 'Extort businesses', noun: 'shakedown', turns: 5, desc: 'Kill their muscle and their earners.' },
  armory:  { name: 'Hit the armory',    noun: 'armory hit', turns: 5, desc: 'Kill their muscle and take their guns.' },
  druglab: { name: 'Hit the drug lab',  noun: 'drug lab hit', turns: 5, desc: 'Kill their muscle and take their drugs.' },
  driveby: { name: 'Drive-by',          noun: 'drive-by', turns: 3, desc: 'Needs cars. Kills lots of muscle, steals nothing. Works even when they are maxed.' },
};

const RANKS = [
  [0, 'Street Rat'], [100000, 'Associate'], [250000, 'Soldier'], [750000, 'Enforcer'],
  [2000000, 'Capo'], [5000000, 'Underboss'], [15000000, 'Consigliere'], [40000000, 'Don'],
];

const START_KIT = {
  cash: 50000, punk: 30, hustler: 5, thug: 15, bodyguard: 15, glock: 20,
  alcohol: 300, weed: 150, coke: 80,
};

const PLAYER_COLUMNS = new Set([
  'city', 'cash', 'bank', 'turns', 'turns_at', 'protected_until', 'family_id', 'kills', 'losses',
  ...Object.keys(UNITS), ...Object.keys(WEAPONS), ...Object.keys(GOODS), ...Object.keys(CARS),
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const money = (n) => '$' + Math.floor(n).toLocaleString('en-US');
const num = (n) => Math.floor(n).toLocaleString('en-US');
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
let random = Math.random;
const setRandom = (fn) => { random = fn; };
const rand = (lo, hi) => lo + random() * (hi - lo);
// Rounds a fractional count up or down at random, so small crews still take losses fairly.
const roundRandom = (x) => Math.floor(x) + (random() < x - Math.floor(x) ? 1 : 0);

function int(v, what) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n <= 0) fail(`Enter how many ${what}.`);
  return n;
}

function save(db, p, fields) {
  const keys = Object.keys(fields);
  for (const k of keys) {
    if (!PLAYER_COLUMNS.has(k)) throw new Error(`bad column ${k}`);
    p[k] = fields[k];
  }
  if (!keys.length) return;
  db.run(`UPDATE players SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => fields[k]), p.id);
}

function spendTurns(p, n) {
  if (p.turns < n) fail(`That takes ${n} turns and you have ${p.turns}.`);
  return p.turns - n;
}

function addEvent(db, playerId, body, now = Date.now()) {
  db.run('INSERT INTO events (player_id, body, created_at) VALUES (?, ?, ?)', playerId, body, now);
}

// ---------------------------------------------------------------------------
// Net worth and ranks
// ---------------------------------------------------------------------------
function networth(p) {
  let nw = p.cash + p.bank;
  for (const k in UNITS) nw += p[k] * UNITS[k].price;
  for (const k in WEAPONS) nw += p[k] * WEAPONS[k].price * SELL_RATE;
  for (const k in CARS) nw += p[k] * CARS[k].price * SELL_RATE;
  for (const k in GOODS) nw += p[k] * GOODS[k].price * SELL_RATE;
  return Math.floor(nw);
}

function rankOf(nw) {
  let title = RANKS[0][1];
  for (const [min, t] of RANKS) if (nw >= min) title = t;
  return title;
}

function opCount(p) { return OPS.reduce((s, k) => s + p[k], 0); }
function muscleCount(p) { return MUSCLE.reduce((s, k) => s + p[k], 0); }
function weaponCount(p) { return Object.keys(WEAPONS).reduce((s, k) => s + p[k], 0); }

// ---------------------------------------------------------------------------
// Rounds
// ---------------------------------------------------------------------------
function currentRound(db, now = Date.now()) {
  let r = db.get('SELECT * FROM rounds WHERE finished = 0 ORDER BY id DESC LIMIT 1');
  if (r && r.ends_at <= now) {
    finishRound(db, r);
    r = null;
  }
  if (!r) r = startRound(db, now);
  return r;
}

function startRound(db, now = Date.now(), days = CONFIG.roundDays) {
  const info = db.run('INSERT INTO rounds (started_at, ends_at) VALUES (?, ?)', now, now + days * 24 * HOUR);
  return db.get('SELECT * FROM rounds WHERE id = ?', info.lastInsertRowid);
}

function finishRound(db, round) {
  const players = db.all(`SELECT p.*, f.name AS family_name FROM players p
    LEFT JOIN families f ON f.id = p.family_id WHERE p.round_id = ?`, round.id);
  players.sort((a, b) => networth(b) - networth(a));
  players.slice(0, 50).forEach((p, i) => {
    db.run('INSERT OR REPLACE INTO round_results (round_id, place, name, family, networth, kills) VALUES (?, ?, ?, ?, ?, ?)',
      round.id, i + 1, p.name, p.family_name, networth(p), p.kills);
  });
  db.run('UPDATE rounds SET finished = 1 WHERE id = ?', round.id);
}

// ---------------------------------------------------------------------------
// Players
// ---------------------------------------------------------------------------
function createPlayer(db, round, userId, name, city, now = Date.now()) {
  name = String(name || '').trim();
  if (!/^[A-Za-z0-9 _.'-]{3,20}$/.test(name)) fail('Pick a name of 3 to 20 letters, numbers or spaces.');
  if (!CITIES.includes(city)) fail('Pick a city.');
  if (db.get('SELECT 1 FROM players WHERE round_id = ? AND name = ?', round.id, name)) fail('That name is taken this round.');
  const cols = ['round_id', 'user_id', 'name', 'city', 'turns', 'turns_at', 'protected_until', 'created_at', ...Object.keys(START_KIT)];
  const vals = [round.id, userId, name, city, CONFIG.startTurns, now, now + CONFIG.protectionHours * HOUR, now, ...Object.values(START_KIT)];
  const info = db.run(`INSERT INTO players (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, ...vals);
  addEvent(db, info.lastInsertRowid, `Welcome to the life, ${name}. You're under protection for ${CONFIG.protectionHours} hours: nobody can touch you, and you can't touch anybody.`, now);
  return db.get('SELECT * FROM players WHERE id = ?', info.lastInsertRowid);
}

function accrueTurns(db, p, now = Date.now()) {
  const interval = CONFIG.turnIntervalMin * 60 * 1000;
  const ticks = Math.floor((now - p.turns_at) / interval);
  if (ticks <= 0) return;
  save(db, p, {
    turns: Math.min(CONFIG.maxTurns, p.turns + ticks * CONFIG.turnsPerInterval),
    turns_at: p.turns_at + ticks * interval,
  });
}

function nextTurnsIn(p, now = Date.now()) {
  const interval = CONFIG.turnIntervalMin * 60 * 1000;
  return Math.max(0, p.turns_at + interval - now);
}

function isProtected(p, now = Date.now()) { return p.protected_until > now; }

function leaveProtection(db, p, now = Date.now()) {
  if (!isProtected(p, now)) fail("You're not under protection.");
  save(db, p, { protected_until: now });
  return 'You stepped out of protection. Watch your back.';
}

// ---------------------------------------------------------------------------
// Hiring, working, market, bank, travel
// ---------------------------------------------------------------------------
function hire(db, p, unit, qtyRaw) {
  const u = UNITS[unit];
  if (!u) fail('Unknown crew type.');
  const qty = int(qtyRaw, u.plural.toLowerCase());
  const cost = qty * u.price;
  const turns = Math.max(1, Math.ceil(qty / 10));
  if (p.cash < cost) fail(`Hiring ${num(qty)} ${u.plural} costs ${money(cost)} and you have ${money(p.cash)} on hand.`);
  save(db, p, { turns: spendTurns(p, turns), cash: p.cash - cost, [unit]: p[unit] + qty });
  return `You hired ${num(qty)} ${qty === 1 ? u.name : u.plural} for ${money(cost)} and ${turns} turn${turns > 1 ? 's' : ''}.`;
}

// How content the crew is for a stretch of work. Short on booze and drugs, unprotected or
// unarmed crews work worse, and badly unhappy earners walk out.
function morale(p, turns) {
  const ops = opCount(p), mus = muscleCount(p);
  const need = {
    alcohol: (ops * 0.05 + mus * 0.05) * turns,
    coke: ops * 0.02 * turns,
    weed: mus * 0.03 * turns,
  };
  let supply = 1;
  const use = {};
  for (const k in need) {
    use[k] = Math.min(p[k], Math.ceil(need[k]));
    if (need[k] > 0) supply = Math.min(supply, p[k] / need[k]);
  }
  supply = clamp(supply, 0, 1);
  const protection = ops ? clamp((mus * 2) / ops, 0, 1) : 1;
  const armed = mus ? clamp(weaponCount(p) / mus, 0, 1) : 1;
  const happiness = supply * (0.5 + 0.25 * protection + 0.25 * armed);
  return { happiness, use, supply, protection, armed };
}

function moraleNotes(m) {
  const notes = [];
  if (m.supply < 1) notes.push('your crew ran short of alcohol, weed or coke');
  if (m.protection < 1) notes.push('your earners want more muscle around');
  if (m.armed < 1) notes.push('some of your muscle has no gun');
  return notes;
}

function work(db, p, kind, turnsRaw) {
  const turns = int(turnsRaw, 'turns');
  const left = spendTurns(p, turns);
  const m = morale(p, turns);
  const eff = 0.3 + 0.7 * m.happiness;
  const fields = { turns: left };
  for (const k in m.use) fields[k] = p[k] - m.use[k];
  let result;
  if (kind === 'collect') {
    const cash = Math.floor(turns * (p.card_dealer * 45 + p.hustler * 30 + p.punk * 20) * eff);
    fields.cash = p.cash + cash;
    result = `You spent ${num(turns)} turns collecting and brought in ${money(cash)}.`;
  } else {
    const alcohol = Math.floor(p.bootlegger * 3 * turns * eff);
    const weed = Math.floor(p.thug * 0.4 * turns * eff);
    const coke = Math.floor(p.thug * 0.15 * turns * eff);
    fields.alcohol = fields.alcohol + alcohol;
    fields.weed = fields.weed + weed;
    fields.coke = fields.coke + coke;
    result = `You spent ${num(turns)} turns producing: ${num(alcohol)} alcohol, ${num(weed)} weed and ${num(coke)} coke.`;
  }
  let walked = 0;
  if (m.happiness < 0.5) {
    const share = Math.min(0.25, (0.5 - m.happiness) * 0.004 * turns);
    for (const k of OPS) {
      const n = Math.floor(p[k] * share);
      if (n) { fields[k] = p[k] - n; walked += n; }
    }
  }
  save(db, p, fields);
  const notes = moraleNotes(m);
  result += ` Crew morale ${Math.round(m.happiness * 100)}%.`;
  if (notes.length) result += ` (${notes.join('; ')}.)`;
  if (walked) result += ` ${num(walked)} unhappy earners walked out on you.`;
  return result;
}

function buy(db, p, item, qtyRaw) {
  const it = MARKET[item];
  if (!it) fail('Unknown item.');
  const qty = int(qtyRaw, it.name);
  const cost = qty * it.price;
  if (p.cash < cost) fail(`${num(qty)} ${it.name} costs ${money(cost)} and you have ${money(p.cash)} on hand.`);
  save(db, p, { cash: p.cash - cost, [item]: p[item] + qty });
  return `You bought ${num(qty)} ${it.name} for ${money(cost)}.`;
}

function sell(db, p, item, qtyRaw) {
  const it = MARKET[item];
  if (!it) fail('Unknown item.');
  const qty = int(qtyRaw, it.name);
  if (p[item] < qty) fail(`You only have ${num(p[item])} ${it.name}.`);
  const gain = Math.floor(qty * it.price * SELL_RATE);
  save(db, p, { cash: p.cash + gain, [item]: p[item] - qty });
  return `You sold ${num(qty)} ${it.name} for ${money(gain)}.`;
}

function bankCap(p) { return Math.max(50000, Math.floor(networth(p) * 0.25)); }

function deposit(db, p, amountRaw) {
  const amount = int(amountRaw, 'dollars');
  if (amount > p.cash) fail(`You only have ${money(p.cash)} on hand.`);
  const room = bankCap(p) - p.bank;
  if (room <= 0) fail(`Your safebox is full. It holds up to ${money(bankCap(p))}, a quarter of your net worth.`);
  const put = Math.min(amount, room);
  save(db, p, { cash: p.cash - put, bank: p.bank + put });
  return put < amount
    ? `Your safebox only had room for ${money(put)}, so that's what went in.`
    : `You put ${money(put)} in your safebox.`;
}

function withdraw(db, p, amountRaw) {
  const amount = int(amountRaw, 'dollars');
  if (amount > p.bank) fail(`Your safebox only holds ${money(p.bank)}.`);
  save(db, p, { cash: p.cash + amount, bank: p.bank - amount });
  return `You took ${money(amount)} out of your safebox.`;
}

function travelCost(p) { return 1000 + 10 * (opCount(p) + muscleCount(p)); }

function travel(db, p, city, now = Date.now()) {
  if (!CITIES.includes(city)) fail('Unknown city.');
  if (city === p.city) fail(`You're already in ${city}.`);
  if (isProtected(p, now)) fail("You can't travel while under protection.");
  const cost = travelCost(p);
  if (p.cash < cost) fail(`Moving your crew costs ${money(cost)} and you have ${money(p.cash)} on hand.`);
  save(db, p, { turns: spendTurns(p, 5), cash: p.cash - cost, city });
  return `You moved your whole crew to ${city} for ${money(cost)} and 5 turns.`;
}

// ---------------------------------------------------------------------------
// Combat
// ---------------------------------------------------------------------------
// Strength of a crew. The best guns go to the strongest fighters first; seats limits how many come along.
function force(p, role, seats = Infinity) {
  const stat = role === 'atk' ? 'atk' : 'def';
  const order = MUSCLE.slice().sort((a, b) => UNITS[b][stat] - UNITS[a][stat]);
  const guns = Object.keys(WEAPONS).sort((a, b) => WEAPONS[b].mult - WEAPONS[a].mult).map((k) => ({ k, n: p[k] }));
  let left = seats, power = 0;
  const used = {};
  for (const t of order) {
    let n = Math.min(p[t], left);
    left -= n;
    used[t] = n;
    for (const g of guns) {
      if (n <= 0) break;
      const k = Math.min(n, g.n);
      g.n -= k;
      n -= k;
      power += k * UNITS[t][stat] * WEAPONS[g.k].mult;
    }
    power += n * UNITS[t][stat] * UNARMED;
  }
  return { power, used };
}

function casualties(used, share) {
  const dead = {};
  let total = 0;
  for (const k in used) {
    const n = Math.min(used[k], roundRandom(used[k] * share));
    if (n) { dead[k] = n; total += n; }
  }
  return { dead, total };
}

function deadList(dead) {
  const parts = Object.keys(dead).map((k) => `${num(dead[k])} ${dead[k] === 1 ? UNITS[k].name : UNITS[k].plural}`);
  return parts.length ? parts.join(', ') : 'nobody';
}

// "a raid", "an armory hit"
function withNoun(kind) {
  const n = ATTACKS[kind].noun;
  return `${/^[aeiou]/.test(n) ? 'an' : 'a'} ${n}`;
}

function attackCheck(db, p, t, kind, now = Date.now()) {
  const a = ATTACKS[kind];
  if (!a) fail('Pick a type of attack.');
  if (!t || t.round_id !== p.round_id) fail('No such player this round.');
  if (t.id === p.id) fail("You can't hit yourself.");
  if (isProtected(p, now)) fail("You're under protection. Leave protection first if you want to fight.");
  if (isProtected(t, now)) fail(`${t.name} is under protection.`);
  if (t.city !== p.city) fail(`${t.name} is in ${t.city}. Travel there first.`);
  if (p.family_id && p.family_id === t.family_id) fail(`${t.name} is family.`);
  if (muscleCount(p) === 0) fail('You have no muscle to send.');
  const revenge = isRevenge(db, p, t, now);
  if (!revenge) {
    const mine = networth(p), theirs = networth(t);
    if (theirs < mine / 2 || theirs > mine * 4) fail(`${t.name} is out of your range. You can hit players worth half to four times your net worth, or anyone who hit you in the last 24 hours.`);
  }
  if (kind === 'driveby' && p.sedan + p.limo === 0) fail('A drive-by needs cars. Buy some on the black market.');
  if (kind !== 'driveby' && hourlyAllowance(db, t, now) <= 0) fail(`${t.name} has been hit hard this hour (maxed). Only drive-bys work on them right now.`);
  return { a, revenge };
}

function isRevenge(db, p, t, now = Date.now()) {
  return !!db.get('SELECT 1 FROM attacks WHERE attacker_id = ? AND defender_id = ? AND created_at > ?', t.id, p.id, now - 24 * HOUR);
}

function hourlyAllowance(db, t, now = Date.now()) {
  const taken = db.get('SELECT COALESCE(SUM(nw_taken), 0) AS s FROM attacks WHERE defender_id = ? AND created_at > ?', t.id, now - HOUR).s;
  return Math.floor(networth(t) * CONFIG.maxHourlyLoss) - taken;
}

function attack(db, p, t, kind, now = Date.now()) {
  const { a, revenge } = attackCheck(db, p, t, kind, now);
  const turnsLeft = spendTurns(p, a.turns);
  const nwBefore = networth(t);
  const seats = kind === 'driveby' ? p.sedan * CARS.sedan.seats + p.limo * CARS.limo.seats : Infinity;
  const atk = force(p, 'atk', seats);
  const def = force(t, 'def');
  let defPower = def.power;
  const fam = t.family_id ? db.get('SELECT * FROM families WHERE id = ?', t.family_id) : null;
  if (fam && fam.city === t.city) defPower *= 1.2;

  const roll = atk.power * rand(0.85, 1.15);
  const block = defPower * rand(0.85, 1.15);
  const won = roll > block;
  const ratio = block > 0 ? roll / block : 10;

  let atkShare, defShare;
  if (kind === 'driveby') {
    defShare = clamp(0.08 * ratio, 0.02, 0.3) * (won ? 1.5 : 1);
    atkShare = clamp(0.03 / ratio, 0, 0.1);
  } else if (won) {
    defShare = clamp(0.05 * ratio, 0.02, 0.15);
    atkShare = clamp(0.04 / ratio, 0.01, 0.1);
  } else {
    defShare = clamp(0.03 * ratio, 0, 0.06);
    atkShare = clamp(0.06 / ratio, 0.03, 0.2);
  }
  if (defPower === 0) atkShare = 0;

  const atkDead = casualties(atk.used, atkShare);
  const defDead = casualties(def.used, defShare);

  const pf = { turns: turnsLeft };
  const tf = {};
  for (const k in atkDead.dead) pf[k] = p[k] - atkDead.dead[k];
  for (const k in defDead.dead) tf[k] = t[k] - defDead.dead[k];

  // Loot, capped so a player can't lose more than the hourly maximum.
  let loot = '';
  let opsKilled = 0;
  if (won && kind !== 'driveby') {
    const killedValue = Object.keys(defDead.dead).reduce((s, k) => s + defDead.dead[k] * UNITS[k].price, 0);
    const room = Math.max(0, hourlyAllowance(db, t, now) - killedValue);
    const share = { raid: rand(0.2, 0.3), extort: rand(0.06, 0.12), armory: rand(0.15, 0.25), druglab: rand(0.2, 0.3) }[kind];
    const keys = { raid: ['cash'], extort: OPS, armory: Object.keys(WEAPONS), druglab: Object.keys(GOODS) }[kind];
    const unitValue = (k) => (k === 'cash' ? 1 : UNITS[k] ? UNITS[k].price : MARKET[k].price * SELL_RATE);
    let value = keys.reduce((s, k) => s + Math.floor(t[k] * share) * unitValue(k), 0);
    const scale = value > room ? room / value : 1;
    const got = {};
    for (const k of keys) {
      const n = Math.floor(t[k] * share * scale);
      if (!n) continue;
      got[k] = n;
      tf[k] = (tf[k] ?? t[k]) - n;
      if (kind !== 'extort') pf[k] = (pf[k] ?? p[k]) + n;
      else opsKilled += n;
    }
    const names = (k) => (k === 'cash' ? null : UNITS[k] ? UNITS[k].plural : MARKET[k].name);
    if (kind === 'raid') loot = got.cash ? `You walked off with ${money(got.cash)}.` : 'Their pockets were empty.';
    else if (kind === 'extort') loot = opsKilled ? `You whacked ${Object.keys(got).map((k) => `${num(got[k])} ${names(k)}`).join(', ')}.` : 'Their businesses were already empty.';
    else loot = Object.keys(got).length ? `You took ${Object.keys(got).map((k) => `${num(got[k])} ${names(k)}`).join(', ')}.` : 'There was nothing worth taking.';
  }

  const kills = defDead.total + opsKilled;
  pf.kills = p.kills + kills;
  pf.losses = p.losses + atkDead.total;
  tf.losses = t.losses + kills;
  save(db, p, pf);
  save(db, t, tf);
  if (p.family_id && kills) db.run('UPDATE families SET kills = kills + ? WHERE id = ?', kills, p.family_id);

  const nwTaken = Math.max(0, nwBefore - networth(t));
  db.run('INSERT INTO attacks (attacker_id, defender_id, kind, won, nw_taken, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    p.id, t.id, kind, won ? 1 : 0, kind === 'driveby' ? 0 : nwTaken, now);

  const verb = a.noun;
  const outcome = won ? 'won' : 'lost';
  const report = `${revenge ? 'Revenge! ' : ''}You ${outcome} the ${verb} on ${t.name}. ` +
    `They lost ${deadList(defDead.dead)}; you lost ${deadList(atkDead.dead)}. ${loot}`.trim();
  const theirs = `${p.name} hit you with ${withNoun(kind)} and ${won ? 'won' : 'lost'}. ` +
    `You lost ${deadList(defDead.dead)}${opsKilled ? ` plus ${num(opsKilled)} earners` : ''}; they lost ${deadList(atkDead.dead)}.` +
    (won && loot && kind === 'raid' ? ` They took cash off you.` : won && kind === 'armory' ? ' They took guns.' : won && kind === 'druglab' ? ' They took drugs.' : '') +
    ' You can take revenge for 24 hours, whatever their net worth.';
  addEvent(db, t.id, theirs, now);
  return { won, report };
}

// ---------------------------------------------------------------------------
// Families
// ---------------------------------------------------------------------------
function createFamily(db, p, nameRaw, now = Date.now()) {
  const name = String(nameRaw || '').trim();
  if (p.family_id) fail("You're already in a family.");
  if (!/^[A-Za-z0-9 _.'-]{3,24}$/.test(name)) fail('Pick a family name of 3 to 24 letters, numbers or spaces.');
  if (db.get('SELECT 1 FROM families WHERE round_id = ? AND name = ?', p.round_id, name)) fail('That family name is taken.');
  if (p.cash < CONFIG.familyCost) fail(`Starting a family costs ${money(CONFIG.familyCost)} on hand.`);
  const info = db.run('INSERT INTO families (round_id, name, boss_id, city, created_at) VALUES (?, ?, ?, ?, ?)', p.round_id, name, p.id, p.city, now);
  save(db, p, { cash: p.cash - CONFIG.familyCost, family_id: Number(info.lastInsertRowid) });
  db.run('DELETE FROM family_requests WHERE player_id = ?', p.id);
  return `The ${name} family is born, with ${p.city} as its home turf. Members defending at home fight 20% harder.`;
}

function requestJoin(db, p, familyId, now = Date.now()) {
  if (p.family_id) fail("You're already in a family.");
  const f = db.get('SELECT * FROM families WHERE id = ? AND round_id = ?', familyId, p.round_id);
  if (!f) fail('No such family.');
  db.run('INSERT OR IGNORE INTO family_requests (player_id, family_id, created_at) VALUES (?, ?, ?)', p.id, f.id, now);
  addEvent(db, f.boss_id, `${p.name} asked to join the ${f.name} family. Answer on your family page.`, now);
  return `You asked to join the ${f.name} family. The boss will decide.`;
}

function bossFamily(db, p) {
  const f = p.family_id && db.get('SELECT * FROM families WHERE id = ?', p.family_id);
  if (!f || f.boss_id !== p.id) fail('Only the boss can do that.');
  return f;
}

function answerRequest(db, p, playerId, accept, now = Date.now()) {
  const f = bossFamily(db, p);
  const req = db.get('SELECT * FROM family_requests WHERE player_id = ? AND family_id = ?', playerId, f.id);
  if (!req) fail('That request is gone.');
  const who = db.get('SELECT * FROM players WHERE id = ?', playerId);
  db.run('DELETE FROM family_requests WHERE player_id = ? AND family_id = ?', playerId, f.id);
  if (!accept) {
    addEvent(db, who.id, `The ${f.name} family turned you down.`, now);
    return `You turned down ${who.name}.`;
  }
  if (who.family_id) fail(`${who.name} already joined another family.`);
  const size = db.get('SELECT COUNT(*) AS n FROM players WHERE family_id = ?', f.id).n;
  if (size >= CONFIG.familyMax) fail(`A family can have at most ${CONFIG.familyMax} members.`);
  db.run('UPDATE players SET family_id = ? WHERE id = ?', f.id, who.id);
  db.run('DELETE FROM family_requests WHERE player_id = ?', who.id);
  addEvent(db, who.id, `You're in. Welcome to the ${f.name} family.`, now);
  return `${who.name} is now part of the family.`;
}

function kick(db, p, playerId, now = Date.now()) {
  const f = bossFamily(db, p);
  const who = db.get('SELECT * FROM players WHERE id = ? AND family_id = ?', playerId, f.id);
  if (!who || who.id === p.id) fail('No such member.');
  db.run('UPDATE players SET family_id = NULL WHERE id = ?', who.id);
  addEvent(db, who.id, `You were thrown out of the ${f.name} family.`, now);
  return `${who.name} is out of the family.`;
}

function leaveFamily(db, p, now = Date.now()) {
  if (!p.family_id) fail("You're not in a family.");
  const f = db.get('SELECT * FROM families WHERE id = ?', p.family_id);
  save(db, p, { family_id: null });
  if (f.boss_id === p.id) {
    const heir = db.get('SELECT * FROM players WHERE family_id = ? ORDER BY created_at LIMIT 1', f.id);
    if (heir) {
      db.run('UPDATE families SET boss_id = ? WHERE id = ?', heir.id, f.id);
      addEvent(db, heir.id, `${p.name} walked away. You're the boss of the ${f.name} family now.`, now);
    } else {
      db.run('DELETE FROM family_requests WHERE family_id = ?', f.id);
      db.run('DELETE FROM family_posts WHERE family_id = ?', f.id);
      db.run('DELETE FROM families WHERE id = ?', f.id);
      return `You left, and the ${f.name} family is no more.`;
    }
  }
  return `You left the ${f.name} family.`;
}

function postToFamily(db, p, bodyRaw, now = Date.now()) {
  if (!p.family_id) fail("You're not in a family.");
  const body = String(bodyRaw || '').trim().slice(0, 1000);
  if (!body) fail('Write something first.');
  db.run('INSERT INTO family_posts (family_id, player_id, body, created_at) VALUES (?, ?, ?, ?)', p.family_id, p.id, body, now);
  return 'Posted.';
}

function sendMessage(db, p, to, bodyRaw, now = Date.now()) {
  if (!to || to.round_id !== p.round_id) fail('No such player this round.');
  if (to.id === p.id) fail('Talking to yourself?');
  const body = String(bodyRaw || '').trim().slice(0, 2000);
  if (!body) fail('Write something first.');
  db.run('INSERT INTO messages (from_id, to_id, body, created_at) VALUES (?, ?, ?, ?)', p.id, to.id, body, now);
  return `Message sent to ${to.name}.`;
}

function familyNetworth(db, familyId) {
  return db.all('SELECT * FROM players WHERE family_id = ?', familyId).reduce((s, m) => s + networth(m), 0);
}

module.exports = {
  CONFIG, CITIES, UNITS, OPS, MUSCLE, WEAPONS, GOODS, CARS, MARKET, SELL_RATE, ATTACKS, RANKS, START_KIT, HOUR,
  GameError, money, num, networth, rankOf, opCount, muscleCount, weaponCount, morale,
  currentRound, startRound, finishRound, createPlayer, accrueTurns, nextTurnsIn, isProtected, leaveProtection,
  hire, work, buy, sell, bankCap, deposit, withdraw, travelCost, travel,
  force, withNoun, attackCheck, attack, isRevenge, hourlyAllowance,
  createFamily, requestJoin, answerRequest, kick, leaveFamily, postToFamily, sendMessage, familyNetworth,
  addEvent, setRandom,
};
