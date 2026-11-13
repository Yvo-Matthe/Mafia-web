'use strict';
/*
 * Turf War: a real-time mafia strategy game.
 * Plain canvas + DOM, no build step. Open index.html to play.
 */
(() => {
  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------
  const W = 1600, H = 1000;           // world size
  const COLS = 6, ROWS = 4;           // city blocks
  const STREET = 30;                  // street width between blocks
  const BW = W / COLS, BH = H / ROWS;
  const UNIT_CAP = 30;
  const CAPTURE_RATE = 5;             // strength per second per unit (max 3 counted)
  const REGEN_RATE = 3;               // strength per second when owner holds an uncontested block
  const UPGRADE_COST = 300;
  const WIN_BLOCKS = 18;
  const SIGHT = 110;                  // how far beyond attack range units notice enemies

  const UNIT_TYPES = {
    thug:     { name: 'Thug', plural: 'Thugs', cost: 100, hp: 60,  dmg: 7,  cd: 0.8, range: 6,   speed: 78, r: 8,  train: 3, letter: 'T', ranged: false, desc: 'Cheap street muscle.' },
    enforcer: { name: 'Enforcer', plural: 'Enforcers', cost: 250, hp: 170, dmg: 15, cd: 1.0, range: 8,   speed: 60, r: 11, train: 5, letter: 'E', ranged: false, desc: 'Tough brawler that holds turf.' },
    hitman:   { name: 'Hitman', plural: 'Hitmen', cost: 400, hp: 70,  dmg: 32, cd: 1.6, range: 150, speed: 70, r: 9,  train: 7, letter: 'H', ranged: true,  desc: 'Long-range shooter. Fragile.' },
  };

  const DISTRICT_TYPES = {
    hq:         { label: 'Headquarters',      income: 5 },
    casino:     { label: 'Casino',            income: 7 },
    docks:      { label: 'Docks',             income: 6 },
    speakeasy:  { label: 'Speakeasy',         income: 4 },
    numbers:    { label: 'Numbers Racket',    income: 3 },
    protection: { label: 'Protection Racket', income: 2 },
  };

  const BLOCK_NAMES = [
    'Little Italy', 'Harbor Row', 'Five Points', 'Chinatown', 'The Bowery',
    'Garment District', 'Fish Market', 'Union Square', 'Riverside', 'Old Town',
    'Midtown', 'Tenderloin', 'Mulberry Street', 'Brickyard', 'Rail Yards',
    'Gaslight Row', 'Uptown', 'Canal Street', 'Southside', 'Printers Alley',
  ];

  const FAMILY_DEFS = [
    { name: 'Vitale',   color: '#e8b84a', corner: [0, 3], player: true },
    { name: 'Moretti',  color: '#e0524d', corner: [5, 0] },
    { name: "O'Malley", color: '#4fbf6e', corner: [0, 0] },
    { name: 'Volkov',   color: '#4f93e8', corner: [5, 3] },
  ];

  const DIFFICULTY = {
    easy:   { aiIncome: 0.75, think: 1.6, playerBias: 0.8,  startCash: 300, hqRaidAfter: 300 },
    normal: { aiIncome: 1.0,  think: 1.1, playerBias: 1.0,  startCash: 400, hqRaidAfter: 180 },
    hard:   { aiIncome: 1.35, think: 0.8, playerBias: 1.35, startCash: 500, hqRaidAfter: 100 },
  };

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const rand = (lo, hi) => lo + Math.random() * (hi - lo);
  const shuffle = (arr) => {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  };
  const money = (v) => '$' + Math.floor(v).toLocaleString('en-US');
  const fmtTime = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

  function hexToRgba(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  // ---------------------------------------------------------------------------
  // Game state
  // ---------------------------------------------------------------------------
  let G = null;

  function newGame(difficulty, playerName) {
    const diff = DIFFICULTY[difficulty] || DIFFICULTY.normal;
    G = {
      t: 0, difficulty, diff,
      districts: [], units: [], families: [],
      tracers: [], floats: [], markers: [], log: [],
      over: false, paused: false, speed: 1, nextId: 1,
      selDistrict: null,
    };

    FAMILY_DEFS.forEach((def, i) => {
      G.families.push({
        id: i,
        name: def.player ? (playerName || def.name) : def.name,
        color: def.color,
        isPlayer: !!def.player,
        cash: diff.startCash,
        alive: true,
        hq: null,
        queue: [],
        incomeMult: def.player ? 1 : diff.aiIncome,
        aiTimer: rand(0, 1),
        stats: { kills: 0, lost: 0, captured: 0 },
        corner: def.corner,
      });
    });

    buildCity();

    // Starting crews.
    for (const f of G.families) {
      spawnUnit(f, 'thug');
      spawnUnit(f, 'thug');
      spawnUnit(f, 'enforcer');
    }

    log(`The ${G.families[0].name} family makes its move. Three rivals stand in the way.`, G.families[0].color);
  }

  function buildCity() {
    const isCorner = (c, r) => (c === 0 || c === COLS - 1) && (r === 0 || r === ROWS - 1);
    const isCenter = (c, r) => (c === 2 || c === 3) && (r === 1 || r === 2);
    const centerTypes = shuffle(['casino', 'casino', 'docks', 'speakeasy']);
    const otherTypes = shuffle([
      'docks', 'docks', 'speakeasy', 'speakeasy', 'speakeasy',
      'numbers', 'numbers', 'numbers', 'numbers', 'numbers',
      'protection', 'protection', 'protection', 'protection', 'protection', 'protection',
    ]);
    const names = shuffle(BLOCK_NAMES.slice());

    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const x = c * BW + STREET / 2, y = r * BH + STREET / 2;
        const w = BW - STREET, h = BH - STREET;
        let type;
        let owner = null;
        let name;
        if (isCorner(c, r)) {
          type = 'hq';
          owner = G.families.find((f) => f.corner[0] === c && f.corner[1] === r);
          name = `${owner.name} Compound`;
        } else if (isCenter(c, r)) {
          type = centerTypes.pop();
          name = names.pop();
        } else {
          type = otherTypes.pop();
          name = names.pop();
        }
        const d = {
          id: G.districts.length, c, r, x, y, w, h,
          cx: x + w / 2, cy: y + h / 2,
          name, type,
          income: DISTRICT_TYPES[type].income,
          owner,
          strength: owner ? 100 : 50,
          upgraded: false,
          presence: new Map(),
          contested: false,
          guardCd: 0,
          buildings: makeBuildings(x, y, w, h, type === 'hq'),
        };
        if (owner) owner.hq = d;
        G.districts.push(d);
      }
    }
  }

  function makeBuildings(x, y, w, h, hq) {
    const list = [];
    const pad = 10;
    let tries = 0;
    while (list.length < 7 && tries++ < 80) {
      const bw = rand(26, 62), bh = rand(22, 50);
      const bx = rand(x + pad, x + w - pad - bw), by = rand(y + 28, y + h - pad - bh);
      const b = { x: bx, y: by, w: bw, h: bh, shade: rand(0, 1) };
      // Keep the centre clear for the HQ building and the capture area.
      const cx = x + w / 2, cy = y + h / 2;
      const clear = hq ? 52 : 26;
      if (bx < cx + clear && bx + bw > cx - clear && by < cy + clear && by + bh > cy - clear) continue;
      if (list.some((o) => bx < o.x + o.w + 6 && bx + bw + 6 > o.x && by < o.y + o.h + 6 && by + bh + 6 > o.y)) continue;
      list.push(b);
    }
    return list;
  }

  function districtAt(x, y) {
    const c = Math.floor(x / BW), r = Math.floor(y / BH);
    if (c < 0 || c >= COLS || r < 0 || r >= ROWS) return null;
    const d = G.districts[r * COLS + c];
    if (x < d.x || x > d.x + d.w || y < d.y || y > d.y + d.h) return null;
    return d;
  }

  function log(text, color) {
    G.log.push({ text, color: color || '#9a958a', t: G.t });
    if (G.log.length > 4) G.log.shift();
    renderLog();
  }

  // ---------------------------------------------------------------------------
  // Units
  // ---------------------------------------------------------------------------
  function spawnUnit(f, type) {
    const def = UNIT_TYPES[type];
    const hq = f.hq;
    const a = rand(0, Math.PI * 2), rr = rand(20, 55);
    const x = hq.cx + Math.cos(a) * rr, y = hq.cy + Math.sin(a) * rr;
    const u = {
      id: G.nextId++, fam: f, type, def,
      x, y, hp: def.hp, maxHp: def.hp, r: def.r,
      cd: rand(0, def.cd), scan: 0,
      mode: 'idle', dest: null, anchor: { x, y }, target: null, chased: false,
      task: null, dead: false, selected: false, hitFlash: 0,
    };
    G.units.push(u);
    return u;
  }

  function familyUnits(f) {
    return G.units.filter((u) => u.fam === f && !u.dead);
  }

  function crewCount(f) {
    return familyUnits(f).length + f.queue.length;
  }

  function nearestEnemy(u, radius) {
    let best = null, bestD = radius;
    for (const o of G.units) {
      if (o.dead || o.fam === u.fam) continue;
      const d = dist(u, o) - o.r;
      if (d < bestD) { bestD = d; best = o; }
    }
    return best;
  }

  function moveToward(u, tx, ty, dt) {
    const dx = tx - u.x, dy = ty - u.y;
    const d = Math.hypot(dx, dy);
    const step = u.def.speed * dt;
    if (d <= Math.max(step, 3)) { u.x = tx; u.y = ty; return true; }
    u.x += (dx / d) * step;
    u.y += (dy / d) * step;
    return false;
  }

  function inRange(u, t) {
    return dist(u, t) <= u.def.range + u.r + t.r;
  }

  function updateUnit(u, dt) {
    u.cd -= dt;
    u.scan -= dt;
    if (u.hitFlash > 0) u.hitFlash -= dt;
    const sight = u.def.range + SIGHT;

    if (u.mode === 'move') {
      u.target = null;
    } else {
      if (u.target && (u.target.dead || dist(u, u.target) > sight + 80)) {
        u.target = null;
        if (u.chased && !u.dest) u.dest = { x: u.anchor.x, y: u.anchor.y };
        u.chased = false;
      }
      // Periodically look for something better: prefer an enemy already in range.
      if (u.scan <= 0) {
        u.scan = 0.4;
        if (!u.target || !inRange(u, u.target)) {
          const n = nearestEnemy(u, sight);
          if (n) {
            if (!u.target && !u.dest) u.chased = true;
            u.target = n;
          }
        }
      }
    }

    if (u.target) {
      const t = u.target;
      if (inRange(u, t)) {
        if (u.cd <= 0) attack(u, t);
      } else {
        moveToward(u, t.x, t.y, dt);
      }
      return;
    }

    if (u.dest) {
      if (moveToward(u, u.dest.x, u.dest.y, dt)) {
        u.anchor = u.dest;
        u.dest = null;
        u.mode = 'idle';
      }
    }
  }

  function attack(u, t) {
    u.cd = u.def.cd * rand(0.9, 1.1);
    t.hp -= u.def.dmg;
    t.hitFlash = 0.12;
    G.tracers.push({
      x1: u.x, y1: u.y, x2: t.x, y2: t.y,
      color: u.fam.color, life: u.def.ranged ? 0.18 : 0.1, max: u.def.ranged ? 0.18 : 0.1, ranged: u.def.ranged,
    });
    // Getting hit makes an idle unit fight back.
    if (!t.target && t.mode !== 'move') t.target = u;
    if (t.hp <= 0) killUnit(t, u.fam);
  }

  function killUnit(t, killer) {
    if (t.dead) return;
    t.dead = true;
    t.selected = false;
    t.fam.stats.lost++;
    if (killer) killer.stats.kills++;
    G.floats.push({ x: t.x, y: t.y, text: '✝', color: t.fam.color, life: 1.2 });
  }

  function orderUnits(units, x, y, mode) {
    x = clamp(x, 10, W - 10);
    y = clamp(y, 10, H - 10);
    // Sunflower spread so units don't all fight for the same spot.
    const sorted = units.slice().sort((a, b) => dist(a, { x, y }) - dist(b, { x, y }));
    sorted.forEach((u, i) => {
      const ang = i * 2.39996, rr = 15 * Math.sqrt(i);
      u.dest = { x: clamp(x + Math.cos(ang) * rr, 8, W - 8), y: clamp(y + Math.sin(ang) * rr, 8, H - 8) };
      u.mode = mode;
      u.target = null;
      u.chased = false;
    });
  }

  function separate() {
    const us = G.units;
    for (let i = 0; i < us.length; i++) {
      const a = us[i];
      if (a.dead) continue;
      for (let j = i + 1; j < us.length; j++) {
        const b = us[j];
        if (b.dead) continue;
        const dx = b.x - a.x, dy = b.y - a.y;
        const min = a.r + b.r + 1;
        if (Math.abs(dx) > min || Math.abs(dy) > min) continue;
        const d = Math.hypot(dx, dy) || 0.01;
        if (d < min) {
          const push = (min - d) / 2;
          const nx = dx / d, ny = dy / d;
          a.x -= nx * push; a.y -= ny * push;
          b.x += nx * push; b.y += ny * push;
        }
      }
      a.x = clamp(a.x, a.r, W - a.r);
      a.y = clamp(a.y, a.r, H - a.r);
    }
  }

  // ---------------------------------------------------------------------------
  // Families: income, recruiting, upgrades
  // ---------------------------------------------------------------------------
  function familyIncome(f) {
    let sum = 0;
    for (const d of G.districts) if (d.owner === f) sum += d.income * (d.upgraded ? 2 : 1);
    return sum * f.incomeMult;
  }

  function canRecruit(f, type) {
    return f.alive && f.cash >= UNIT_TYPES[type].cost && crewCount(f) < UNIT_CAP;
  }

  function recruit(f, type) {
    if (!canRecruit(f, type)) return false;
    const def = UNIT_TYPES[type];
    f.cash -= def.cost;
    f.queue.push({ type, t: def.train, total: def.train });
    return true;
  }

  function canUpgrade(f, d) {
    return d && d.owner === f && !d.upgraded && f.cash >= UPGRADE_COST;
  }

  function upgrade(f, d) {
    if (!canUpgrade(f, d)) return false;
    f.cash -= UPGRADE_COST;
    d.upgraded = true;
    G.floats.push({ x: d.cx, y: d.cy - 20, text: 'Front business opened', color: f.color, life: 1.8 });
    if (f.isPlayer) log(`You opened a front business in ${d.name}. Its take is doubled.`, f.color);
    return true;
  }

  function updateFamily(f, dt) {
    if (!f.alive) return;
    f.cash += familyIncome(f) * dt;
    const q = f.queue[0];
    if (q) {
      q.t -= dt;
      if (q.t <= 0) {
        f.queue.shift();
        const u = spawnUnit(f, q.type);
        if (f.isPlayer && f.rally) orderUnits([u], f.rally.x, f.rally.y, 'amove');
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Districts: capture, HQ defence
  // ---------------------------------------------------------------------------
  function updateDistricts(dt) {
    for (const d of G.districts) d.presence.clear();
    for (const u of G.units) {
      if (u.dead) continue;
      const d = districtAt(u.x, u.y);
      if (d) d.presence.set(u.fam, (d.presence.get(u.fam) || 0) + 1);
    }

    for (const d of G.districts) {
      const fams = [...d.presence.keys()];
      d.contested = fams.length > 1;
      const isLiveHq = d.type === 'hq' && d.owner && d.owner.hq === d;

      if (fams.length === 1) {
        const f = fams[0];
        const n = Math.min(3, d.presence.get(f));
        const rate = CAPTURE_RATE * n * (isLiveHq ? 0.35 : 1) * dt;
        if (d.owner === f) {
          d.strength = Math.min(100, d.strength + rate);
        } else {
          d.strength -= rate;
          if (d.strength <= 0) {
            const prev = d.owner;
            d.owner = f;
            d.strength = Math.min(100, -d.strength + 5);
            d.upgraded = false;
            onCaptured(d, f, prev);
          }
        }
      } else if (fams.length === 0 && d.owner) {
        d.strength = Math.min(100, d.strength + REGEN_RATE * dt);
      }

      // A family's HQ defends itself.
      if (isLiveHq && d.owner.hq === d) {
        d.guardCd -= dt;
        if (d.guardCd <= 0) {
          let best = null, bestD = Infinity;
          for (const u of G.units) {
            if (u.dead || u.fam === d.owner) continue;
            if (u.x < d.x || u.x > d.x + d.w || u.y < d.y || u.y > d.y + d.h) continue;
            const dd = Math.hypot(u.x - d.cx, u.y - d.cy);
            if (dd < bestD) { bestD = dd; best = u; }
          }
          if (best) {
            d.guardCd = 0.8;
            best.hp -= 12;
            best.hitFlash = 0.12;
            G.tracers.push({ x1: d.cx, y1: d.cy - 14, x2: best.x, y2: best.y, color: d.owner.color, life: 0.18, max: 0.18, ranged: true });
            if (best.hp <= 0) killUnit(best, d.owner);
          }
        }
      }
    }
  }

  function onCaptured(d, f, prev) {
    f.stats.captured++;
    G.floats.push({ x: d.cx, y: d.cy, text: `Captured by ${f.name}`, color: f.color, life: 2 });
    const player = G.families[0];
    if (f.isPlayer) log(`You took ${d.name}${prev ? ` from the ${prev.name}s` : ''}.`, f.color);
    else if (prev && prev.isPlayer) log(`The ${f.name}s took ${d.name} from you!`, f.color);
    else if (d.type === 'casino' || d.type === 'docks') log(`The ${f.name}s took ${d.name}.`, f.color);

    if (prev && prev.hq === d) eliminate(prev, f);
    if (!player.alive) return;
    checkVictory();
  }

  function eliminate(f, by) {
    f.alive = false;
    f.queue = [];
    for (const u of G.units) if (u.fam === f) { u.dead = true; u.selected = false; }
    for (const d of G.districts) {
      if (d.owner === f) { d.owner = null; d.strength = 25; d.upgraded = false; }
    }
    log(`The ${f.name} family is finished. ${by.isPlayer ? 'You' : `The ${by.name}s`} took their compound.`, by.color);
    if (f.isPlayer) endGame(false, `The ${by.name}s overran your compound.`);
  }

  function checkVictory() {
    if (G.over) return;
    const player = G.families[0];
    const rivals = G.families.filter((f) => !f.isPlayer && f.alive);
    if (rivals.length === 0) return endGame(true, 'Every rival family has been wiped out. The city is yours.');
    const owned = G.districts.filter((d) => d.owner === player).length;
    if (owned >= WIN_BLOCKS) return endGame(true, `You control ${owned} of ${G.districts.length} blocks. The other families bow out.`);
    for (const f of rivals) {
      const n = G.districts.filter((d) => d.owner === f).length;
      if (n >= WIN_BLOCKS) return endGame(false, `The ${f.name}s control ${n} blocks and run you out of town.`);
    }
  }

  // ---------------------------------------------------------------------------
  // AI
  // ---------------------------------------------------------------------------
  function enemyPowerNear(f, x, y, radius) {
    let p = 0;
    for (const u of G.units) {
      if (u.dead || u.fam === f) continue;
      if (Math.hypot(u.x - x, u.y - y) < radius) p += u.hp * (u.def.dmg / u.def.cd) / 8;
    }
    return p;
  }

  function unitPower(units) {
    return units.reduce((s, u) => s + u.hp * (u.def.dmg / u.def.cd) / 8, 0);
  }

  function aiThink(f) {
    const units = familyUnits(f);

    // 1. Recruit.
    if (crewCount(f) < UNIT_CAP && f.queue.length < 2) {
      const roll = Math.random();
      let type = 'thug';
      if (G.t > 150 && roll < 0.3) type = 'hitman';
      else if (G.t > 50 && roll < 0.65) type = 'enforcer';
      if (!recruit(f, type) && type !== 'thug' && f.cash > 600) recruit(f, 'thug');
    }

    // 2. Invest when rich.
    if (f.cash > 650) {
      const best = G.districts
        .filter((d) => d.owner === f && !d.upgraded && !d.contested)
        .sort((a, b) => b.income - a.income)[0];
      if (best && Math.random() < 0.5) upgrade(f, best);
    }

    // Clear finished tasks.
    for (const u of units) {
      if (!u.task) continue;
      const d = u.task;
      if ((d.owner === f && d.strength >= 85 && !d.contested) || G.t - u.taskAt > 45) u.task = null;
    }

    // 3. Defend the HQ with everything.
    const hq = f.hq;
    const hqThreat = [...hq.presence.keys()].some((o) => o !== f);
    if (hqThreat) {
      const defenders = units.filter((u) => u.task !== hq);
      if (defenders.length) {
        orderUnits(defenders, hq.cx, hq.cy, 'amove');
        for (const u of defenders) { u.task = hq; u.taskAt = G.t; }
      }
      return;
    }

    const free = units.filter((u) => !u.task && !u.target);
    if (!free.length) return;

    // 4. Defend valuable turf under attack.
    const threatened = G.districts.find((d) => d.owner === f && d.income >= 5 &&
      [...d.presence.keys()].some((o) => o !== f) && !d.presence.get(f));
    if (threatened && free.length >= 2) {
      sendTask(f, free, threatened);
      return;
    }

    // 5. Attack or expand.
    const waveSize = clamp(2 + Math.floor(G.t / 45), 2, 9);
    if (free.length < waveSize) return;
    const cx = free.reduce((s, u) => s + u.x, 0) / free.length;
    const cy = free.reduce((s, u) => s + u.y, 0) / free.length;
    const myPower = unitPower(free);

    let best = null, bestScore = -Infinity;
    for (const d of G.districts) {
      if (d.owner === f) continue;
      const isHq = d.type === 'hq' && d.owner && d.owner.hq === d;
      if (isHq && (myPower < 900 || G.t < G.diff.hqRaidAfter)) continue;
      const enemy = enemyPowerNear(f, d.cx, d.cy, 220) + (isHq ? 250 : 0);
      if (enemy > myPower * 1.1) continue;
      const travel = Math.hypot(d.cx - cx, d.cy - cy);
      let value = d.income * (d.upgraded ? 2 : 1) + (isHq ? 14 : 0);
      if (!d.owner) value *= 1.4;
      if (d.owner && d.owner.isPlayer) value *= G.diff.playerBias;
      const score = value / (1 + travel / 320) - (enemy / Math.max(1, myPower)) * 3 + rand(0, 1.5);
      if (score > bestScore) { bestScore = score; best = d; }
    }
    if (best) sendTask(f, free, best);
  }

  function sendTask(f, units, d) {
    orderUnits(units, d.cx + rand(-30, 30), d.cy + rand(-20, 20), 'amove');
    for (const u of units) { u.task = d; u.taskAt = G.t; }
  }

  // ---------------------------------------------------------------------------
  // Simulation step
  // ---------------------------------------------------------------------------
  function step(dt) {
    if (G.over) return;
    G.t += dt;
    for (const f of G.families) updateFamily(f, dt);
    for (const f of G.families) {
      if (f.isPlayer || !f.alive) continue;
      f.aiTimer -= dt;
      if (f.aiTimer <= 0) { f.aiTimer = G.diff.think; aiThink(f); }
    }
    for (const u of G.units) if (!u.dead) updateUnit(u, dt);
    separate();
    updateDistricts(dt);
    G.units = G.units.filter((u) => !u.dead);

    for (const tr of G.tracers) tr.life -= dt;
    G.tracers = G.tracers.filter((tr) => tr.life > 0);
    for (const fl of G.floats) { fl.life -= dt; fl.y -= 14 * dt; }
    G.floats = G.floats.filter((fl) => fl.life > 0);
    for (const m of G.markers) m.life -= dt;
    G.markers = G.markers.filter((m) => m.life > 0);

    // Territory victory is checked every step so it can't be missed.
    if (Math.floor(G.t) !== Math.floor(G.t - dt)) checkVictory();
  }

  function endGame(won, text) {
    if (G.over) return;
    G.over = true;
    const p = G.families[0];
    $('end-title').textContent = won ? 'The city is yours' : 'Sleeping with the fishes';
    $('end-text').textContent = `${text} Time: ${fmtTime(G.t)}. Blocks taken: ${p.stats.captured}. Rivals whacked: ${p.stats.kills}. Crew lost: ${p.stats.lost}.`;
    $('endscreen').classList.remove('hidden');
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------
  const canvas = $('game');
  const ctx = canvas.getContext('2d');
  const view = { s: 1, ox: 0, oy: 0, dpr: 1 };

  function resize() {
    view.dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(innerWidth * view.dpr);
    canvas.height = Math.floor(innerHeight * view.dpr);
    const top = $('topbar').offsetHeight;
    const bottom = $('panel').offsetHeight;
    const availH = Math.max(100, innerHeight - top - bottom);
    view.s = Math.min(innerWidth / W, availH / H) * 0.985;
    view.ox = (innerWidth - W * view.s) / 2;
    view.oy = top + (availH - H * view.s) / 2;
  }

  function toWorld(px, py) {
    return { x: (px - view.ox) / view.s, y: (py - view.oy) / view.s };
  }

  function render() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0d0e11';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!G) return;
    ctx.setTransform(view.dpr * view.s, 0, 0, view.dpr * view.s, view.dpr * view.ox, view.dpr * view.oy);

    // Streets.
    ctx.fillStyle = '#1c1e24';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(232, 200, 120, 0.12)';
    ctx.lineWidth = 2;
    ctx.setLineDash([14, 14]);
    ctx.beginPath();
    for (let c = 1; c < COLS; c++) { ctx.moveTo(c * BW, 0); ctx.lineTo(c * BW, H); }
    for (let r = 1; r < ROWS; r++) { ctx.moveTo(0, r * BH); ctx.lineTo(W, r * BH); }
    ctx.stroke();
    ctx.setLineDash([]);

    for (const d of G.districts) drawDistrict(d);

    // Move markers.
    for (const m of G.markers) {
      const k = m.life / 0.6;
      ctx.strokeStyle = hexToRgba('#7dff9a', k);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(m.x, m.y, 6 + (1 - k) * 14, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Tracers.
    for (const tr of G.tracers) {
      const k = tr.life / tr.max;
      ctx.strokeStyle = tr.ranged ? `rgba(255, 240, 200, ${k})` : hexToRgba(tr.color, k);
      ctx.lineWidth = tr.ranged ? 1.5 : 3;
      ctx.beginPath();
      if (tr.ranged) {
        ctx.moveTo(tr.x1, tr.y1);
        ctx.lineTo(tr.x2, tr.y2);
      } else {
        // A short swipe at the target for melee hits.
        const mx = tr.x1 + (tr.x2 - tr.x1) * 0.7, my = tr.y1 + (tr.y2 - tr.y1) * 0.7;
        ctx.arc(mx, my, 5, 0, Math.PI * 2);
      }
      ctx.stroke();
    }

    for (const u of G.units) drawUnit(u);

    // Floating text.
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const fl of G.floats) {
      ctx.globalAlpha = Math.min(1, fl.life);
      ctx.font = fl.text.length > 2 ? 'bold 15px Georgia, serif' : 'bold 16px sans-serif';
      ctx.fillStyle = '#000';
      ctx.fillText(fl.text, fl.x + 1, fl.y + 1);
      ctx.fillStyle = fl.color;
      ctx.fillText(fl.text, fl.x, fl.y);
    }
    ctx.globalAlpha = 1;

    // Selection box.
    if (input.box) {
      const a = toWorld(input.box.x0, input.box.y0), b = toWorld(input.box.x1, input.box.y1);
      ctx.strokeStyle = '#7dff9a';
      ctx.lineWidth = 1.5 / view.s;
      ctx.fillStyle = 'rgba(125, 255, 154, 0.08)';
      ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
      ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    }

    // Rally flag.
    const p = G.families[0];
    if (p.rally) {
      ctx.strokeStyle = p.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(p.rally.x, p.rally.y);
      ctx.lineTo(p.rally.x, p.rally.y - 22);
      ctx.stroke();
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.moveTo(p.rally.x, p.rally.y - 22);
      ctx.lineTo(p.rally.x + 12, p.rally.y - 17);
      ctx.lineTo(p.rally.x, p.rally.y - 12);
      ctx.fill();
    }

    if (G.paused && !G.over) {
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#e8b84a';
      ctx.font = 'bold 64px Georgia, serif';
      ctx.fillText('Paused', W / 2, H / 2);
    }
  }

  function drawDistrict(d) {
    const own = d.owner;
    ctx.fillStyle = '#2a2d35';
    ctx.fillRect(d.x, d.y, d.w, d.h);
    if (own) {
      ctx.fillStyle = hexToRgba(own.color, 0.1 + 0.22 * (d.strength / 100));
      ctx.fillRect(d.x, d.y, d.w, d.h);
    }

    for (const b of d.buildings) {
      ctx.fillStyle = `rgb(${52 + b.shade * 18}, ${54 + b.shade * 18}, ${62 + b.shade * 18})`;
      ctx.fillRect(b.x, b.y, b.w, b.h);
      ctx.fillStyle = 'rgba(255, 220, 140, 0.18)';
      for (let wx = b.x + 5; wx < b.x + b.w - 5; wx += 9) {
        for (let wy = b.y + 5; wy < b.y + b.h - 5; wy += 10) {
          if ((wx * 7 + wy * 13) % 5 < 2) ctx.fillRect(wx, wy, 3, 4);
        }
      }
    }

    // Border.
    const selected = G.selDistrict === d;
    ctx.lineWidth = selected ? 4 : 2;
    ctx.strokeStyle = selected ? '#ffffff' : own ? hexToRgba(own.color, 0.9) : '#3c404b';
    ctx.strokeRect(d.x, d.y, d.w, d.h);

    // HQ building.
    if (d.type === 'hq') {
      const live = own && own.hq === d;
      ctx.fillStyle = '#15161a';
      ctx.fillRect(d.cx - 40, d.cy - 30, 80, 60);
      ctx.strokeStyle = live ? own.color : '#555';
      ctx.lineWidth = 3;
      ctx.strokeRect(d.cx - 40, d.cy - 30, 80, 60);
      ctx.fillStyle = live ? own.color : '#666';
      ctx.font = 'bold 30px Georgia, serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(live ? own.name[0] : '✝', d.cx, d.cy + 2);
    }

    // Labels.
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.font = 'bold 15px Georgia, serif';
    ctx.fillStyle = '#e9e4d8';
    ctx.fillText(d.name, d.x + 8, d.y + 7);
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillStyle = '#b9b3a5';
    const inc = d.income * (d.upgraded ? 2 : 1);
    ctx.fillText(`${DISTRICT_TYPES[d.type].label} · $${inc}/s${d.upgraded ? ' ★' : ''}`, d.x + 8, d.y + 25);

    // Capture bar.
    if (d.strength < 100 || d.contested) {
      const bw = d.w - 40, bx = d.x + 20, by = d.y + d.h - 14;
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(bx, by, bw, 6);
      ctx.fillStyle = own ? own.color : '#888';
      ctx.fillRect(bx, by, bw * (d.strength / 100), 6);
      if (d.contested) {
        ctx.fillStyle = '#ff6b5e';
        ctx.font = 'bold 11px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText('CONTESTED', d.cx, by - 2);
      }
    }
  }

  function drawUnit(u) {
    const r = u.r;
    if (u.selected) {
      ctx.strokeStyle = '#7dff9a';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(u.x, u.y, r + 4, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.beginPath();
    ctx.ellipse(u.x + 2, u.y + 3, r, r * 0.8, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = u.hitFlash > 0 ? '#ffffff' : u.fam.color;
    ctx.strokeStyle = '#0b0b0d';
    ctx.lineWidth = 2;
    ctx.beginPath();
    if (u.type === 'enforcer') {
      ctx.rect(u.x - r, u.y - r, r * 2, r * 2);
    } else if (u.type === 'hitman') {
      ctx.moveTo(u.x, u.y - r - 2);
      ctx.lineTo(u.x + r + 1, u.y + r - 1);
      ctx.lineTo(u.x - r - 1, u.y + r - 1);
      ctx.closePath();
    } else {
      ctx.arc(u.x, u.y, r, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#111';
    ctx.font = `bold ${r + 2}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(u.def.letter, u.x, u.y + (u.type === 'hitman' ? 2 : 1));

    if (u.hp < u.maxHp) {
      const w = r * 2 + 4;
      ctx.fillStyle = 'rgba(0,0,0,0.7)';
      ctx.fillRect(u.x - w / 2, u.y - r - 8, w, 4);
      const k = u.hp / u.maxHp;
      ctx.fillStyle = k > 0.5 ? '#6fdc6f' : k > 0.25 ? '#f0c040' : '#ff5a4a';
      ctx.fillRect(u.x - w / 2, u.y - r - 8, w * k, 4);
    }
  }

  // ---------------------------------------------------------------------------
  // HUD
  // ---------------------------------------------------------------------------
  const recruitButtons = [...document.querySelectorAll('button.recruit')];

  function updateHud() {
    if (!G) return;
    const p = G.families[0];
    $('cash').textContent = money(p.cash);
    $('income').textContent = `${money(familyIncome(p))}/s`;
    $('turf').textContent = `${G.districts.filter((d) => d.owner === p).length}/${G.districts.length}`;
    $('crew').textContent = `${crewCount(p)}/${UNIT_CAP}`;
    $('clock').textContent = fmtTime(G.t);
    $('btn-pause').textContent = G.paused ? 'Resume' : 'Pause';
    $('btn-speed').textContent = `${G.speed}x`;

    const q = p.queue[0];
    for (const b of recruitButtons) {
      const type = b.dataset.type;
      b.disabled = !canRecruit(p, type);
      const prog = b.querySelector('.prog');
      prog.style.width = q && q.type === type ? `${(1 - q.t / q.total) * 100}%` : '0';
    }
    $('queue').textContent = p.queue.length ? `Queue: ${p.queue.map((x) => UNIT_TYPES[x.type].letter).join(' ')}` : '';

    renderInfo();
  }

  const esc = (t) => String(t).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

  // The info panel is rebuilt only when its structure changes, so buttons stay
  // clickable; numbers that tick every frame go into the .dyn element.
  let lastInfo = '';
  function renderInfo() {
    const p = G.families[0];
    const sel = G.units.filter((u) => u.selected);
    let html, dyn = '';
    if (sel.length) {
      const counts = {};
      for (const u of sel) counts[u.type] = (counts[u.type] || 0) + 1;
      const parts = Object.keys(counts).map((t) => `<b>${counts[t]}</b> ${counts[t] > 1 ? UNIT_TYPES[t].plural : UNIT_TYPES[t].name}`);
      const hp = sel.reduce((s, u) => s + u.hp, 0), max = sel.reduce((s, u) => s + u.maxHp, 0);
      dyn = `${Math.round((hp / max) * 100)}%`;
      html = `<h3>Crew selected</h3>
        <div class="row">${parts.join(', ')} &middot; health <b class="dyn"></b></div>
        <div class="row">Right-click or tap a spot to send them. <kbd>R</kbd> retreats to HQ.</div>`;
    } else if (G.selDistrict) {
      const d = G.selDistrict;
      const inc = d.income * (d.upgraded ? 2 : 1);
      const owner = d.owner ? (d.owner === p ? 'You' : `${esc(d.owner.name)} family`) : 'Nobody';
      dyn = `${Math.round(d.strength)}%`;
      html = `<h3>${esc(d.name)}</h3>
        <div class="row">${DISTRICT_TYPES[d.type].label} &middot; <b>$${inc}/s</b> &middot; held by <b>${owner}</b> &middot; grip <b class="dyn"></b></div>`;
      if (d.owner === p && !d.upgraded) {
        html += `<div class="actions"><button id="btn-upgrade">Front business ${money(UPGRADE_COST)}: double income <kbd>U</kbd></button>`;
      } else if (d.owner === p) {
        html += `<div class="actions"><span class="row">Front business open ★</span>`;
      } else {
        html += `<div class="row">Send a crew to stand in this block to take it.</div>`;
      }
      if (d.owner === p) html += `<button id="btn-rally">Rally recruits here</button></div>`;
    } else {
      html = `<h3>${esc(p.name)} family</h3>
        <div class="row">Drag to select your crew, then right-click (or tap) a block to move in. Click a block for details.</div>`;
    }
    if (html !== lastInfo) {
      $('info').innerHTML = html;
      lastInfo = html;
      const up = $('btn-upgrade');
      if (up) up.onclick = () => upgrade(p, G.selDistrict);
      const rally = $('btn-rally');
      if (rally) rally.onclick = () => {
        p.rally = { x: G.selDistrict.cx, y: G.selDistrict.cy + 30 };
        log(`New recruits will head to ${G.selDistrict.name}.`, p.color);
      };
    }
    const dynEl = $('info').querySelector('.dyn');
    if (dynEl && dynEl.textContent !== dyn) dynEl.textContent = dyn;
    const up = $('btn-upgrade');
    if (up) up.disabled = !canUpgrade(p, G.selDistrict);
  }

  function renderLog() {
    const el = $('log');
    el.innerHTML = '';
    for (const e of G.log) {
      const div = document.createElement('div');
      div.textContent = e.text;
      div.style.borderLeftColor = e.color;
      el.appendChild(div);
    }
  }

  function fadeLog() {
    if (!G) return;
    const divs = $('log').children;
    G.log.forEach((e, i) => {
      if (divs[i]) divs[i].style.opacity = G.t - e.t > 20 ? '0.35' : '1';
    });
  }

  // ---------------------------------------------------------------------------
  // Input
  // ---------------------------------------------------------------------------
  const input = { down: null, box: null, shift: false };

  function playerUnits() {
    return G.units.filter((u) => u.fam.isPlayer && !u.dead);
  }

  function unitAt(w) {
    let best = null, bestD = Infinity;
    for (const u of playerUnits()) {
      const d = dist(u, w);
      if (d < u.r + 6 && d < bestD) { bestD = d; best = u; }
    }
    return best;
  }

  function commandSelected(w, mode) {
    const sel = playerUnits().filter((u) => u.selected);
    if (!sel.length) return false;
    orderUnits(sel, w.x, w.y, mode);
    G.markers.push({ x: w.x, y: w.y, life: 0.6 });
    return true;
  }

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener('pointerdown', (e) => {
    if (!G || G.over) return;
    canvas.setPointerCapture(e.pointerId);
    const w = toWorld(e.clientX, e.clientY);
    if (e.button === 2) {
      commandSelected(w, 'amove');
      return;
    }
    input.down = { x: e.clientX, y: e.clientY, touch: e.pointerType !== 'mouse', shift: e.shiftKey };
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!input.down) return;
    const dx = e.clientX - input.down.x, dy = e.clientY - input.down.y;
    if (input.box || Math.hypot(dx, dy) > 8) {
      input.box = { x0: input.down.x, y0: input.down.y, x1: e.clientX, y1: e.clientY };
    }
  });

  canvas.addEventListener('pointerup', (e) => {
    const down = input.down;
    input.down = null;
    if (!down || !G || G.over) { input.box = null; return; }

    if (input.box) {
      const a = toWorld(input.box.x0, input.box.y0), b = toWorld(input.box.x1, input.box.y1);
      const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
      const inBox = playerUnits().filter((u) => u.x >= x0 && u.x <= x1 && u.y >= y0 && u.y <= y1);
      if (!down.shift) for (const u of playerUnits()) u.selected = false;
      for (const u of inBox) u.selected = true;
      if (inBox.length) G.selDistrict = null;
      input.box = null;
      return;
    }

    const w = toWorld(e.clientX, e.clientY);
    const u = unitAt(w);
    if (u) {
      if (down.shift) u.selected = !u.selected;
      else {
        for (const o of playerUnits()) o.selected = false;
        u.selected = true;
      }
      G.selDistrict = null;
      return;
    }

    // Touch has no right-click: tapping the map with a crew selected sends them.
    if (down.touch && commandSelected(w, 'amove')) return;

    if (!down.shift) for (const o of playerUnits()) o.selected = false;
    G.selDistrict = districtAt(w.x, w.y);
  });

  window.addEventListener('keydown', (e) => {
    if (!G || e.target.tagName === 'INPUT') return;
    const p = G.families[0];
    switch (e.key) {
      case '1': recruit(p, 'thug'); break;
      case '2': recruit(p, 'enforcer'); break;
      case '3': recruit(p, 'hitman'); break;
      case 'q': case 'Q':
        for (const u of playerUnits()) u.selected = true;
        G.selDistrict = null;
        break;
      case 'r': case 'R': {
        const sel = playerUnits().filter((u) => u.selected);
        if (sel.length) orderUnits(sel, p.hq.cx, p.hq.cy, 'move');
        break;
      }
      case 'u': case 'U':
        if (G.selDistrict) upgrade(p, G.selDistrict);
        break;
      case 'Escape':
        for (const u of playerUnits()) u.selected = false;
        G.selDistrict = null;
        break;
      case ' ':
        e.preventDefault();
        togglePause();
        break;
      default: return;
    }
  });

  function togglePause() {
    if (!G || G.over) return;
    G.paused = !G.paused;
  }

  for (const b of recruitButtons) {
    b.addEventListener('click', () => G && recruit(G.families[0], b.dataset.type));
  }
  $('btn-pause').addEventListener('click', togglePause);
  $('btn-speed').addEventListener('click', () => { if (G) G.speed = G.speed === 1 ? 2 : G.speed === 2 ? 3 : 1; });
  $('btn-help').addEventListener('click', () => {
    if (!G || G.over) return;
    G.paused = true;
    $('start-buttons').classList.add('hidden');
    document.querySelector('.card .name').classList.add('hidden');
    $('btn-resume').classList.remove('hidden');
    $('overlay').classList.remove('hidden');
  });
  $('btn-resume').addEventListener('click', () => {
    $('overlay').classList.add('hidden');
    G.paused = false;
  });

  function start(diff) {
    const name = $('family-name').value.trim() || 'Vitale';
    newGame(diff, name);
    $('overlay').classList.add('hidden');
    $('endscreen').classList.add('hidden');
    lastInfo = '';
    resize();
  }

  for (const b of document.querySelectorAll('#start-buttons button')) {
    b.addEventListener('click', () => start(b.dataset.diff));
  }
  $('btn-again').addEventListener('click', () => {
    $('endscreen').classList.add('hidden');
    $('start-buttons').classList.remove('hidden');
    document.querySelector('.card .name').classList.remove('hidden');
    $('btn-resume').classList.add('hidden');
    $('overlay').classList.remove('hidden');
  });

  // ---------------------------------------------------------------------------
  // Main loop
  // ---------------------------------------------------------------------------
  let last = performance.now();
  let hudTimer = 0;
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (G && !G.paused && !G.over) {
      for (let i = 0; i < G.speed; i++) step(dt);
    }
    render();
    hudTimer -= dt;
    if (hudTimer <= 0) { hudTimer = 0.1; updateHud(); fadeLog(); }
    requestAnimationFrame(frame);
  }

  window.addEventListener('resize', resize);
  if (window.ResizeObserver) new ResizeObserver(resize).observe($('panel'));
  resize();
  requestAnimationFrame(frame);

  // Hooks for automated tests and the browser console.
  window.__turfwar = {
    get state() { return G; },
    newGame: (diff, name) => { start(diff || 'normal'); if (name) G.families[0].name = name; },
    simulate(seconds, dt = 1 / 30) {
      const n = Math.round(seconds / dt);
      for (let i = 0; i < n && !G.over; i++) step(dt);
    },
    orderUnits, recruit, upgrade, districtAt, aiThink,
  };
})();
