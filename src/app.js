'use strict';
const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const G = require('./game');
const { html, raw, page, ago, duration, qtyInput } = require('./views');

const SESSION_DAYS = 30;

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function createApp(db, opts = {}) {
  const app = express();
  const secure = !!opts.secureCookies;
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));
  app.use(express.urlencoded({ extended: false, limit: '20kb' }));

  const setCookie = (res, name, value, maxAgeSec) => {
    res.append('Set-Cookie', `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`);
  };

  // Load the session, the current round and this user's player for every request.
  app.use((req, res, next) => {
    // Forms only post from this site.
    if (req.method === 'POST') {
      const origin = req.get('origin');
      if (origin && new URL(origin).host !== req.get('host')) return res.status(403).send('Bad origin');
    }
    const cookies = parseCookies(req.headers.cookie);
    const now = Date.now();
    req.now = now;
    req.ctx = { path: req.path, now };
    db.tx(() => {
      req.ctx.round = G.currentRound(db, now);
      if (cookies.sid) {
        const s = db.get('SELECT * FROM sessions WHERE token = ?', cookies.sid);
        if (s && s.created_at > now - SESSION_DAYS * 86400e3) {
          req.ctx.user = db.get('SELECT id, username, is_admin FROM users WHERE id = ?', s.user_id);
          req.sid = s.token;
        }
      }
      if (req.ctx.user) loadPlayer(req);
    });
    if (cookies.flash) {
      try { req.ctx.flash = JSON.parse(cookies.flash); } catch { /* ignore a mangled cookie */ }
      res.append('Set-Cookie', `flash=; Path=/; Max-Age=0`);
    }
    next();
  });

  function loadPlayer(req) {
    const p = db.get('SELECT * FROM players WHERE round_id = ? AND user_id = ?', req.ctx.round.id, req.ctx.user.id);
    if (p) {
      G.accrueTurns(db, p, req.now);
      req.ctx.counts = {
        events: db.get('SELECT COUNT(*) AS n FROM events WHERE player_id = ? AND seen = 0', p.id).n,
        messages: db.get('SELECT COUNT(*) AS n FROM messages WHERE to_id = ? AND seen = 0', p.id).n,
      };
    }
    req.ctx.player = p || null;
  }

  const flash = (res, type, text) => {
    res.append('Set-Cookie', `flash=${encodeURIComponent(JSON.stringify({ type, text }))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=60`);
  };

  // Runs a game action in one transaction, then redirects back with its result.
  function act(req, res, back, fn) {
    try {
      const msg = db.tx(() => {
        const p = req.ctx.player && db.get('SELECT * FROM players WHERE id = ?', req.ctx.player.id);
        return fn(p);
      });
      if (msg) flash(res, 'ok', msg);
    } catch (e) {
      if (!(e instanceof G.GameError)) throw e;
      flash(res, 'err', e.message);
    }
    res.redirect(303, back);
  }

  const needUser = (req, res, next) => (req.ctx.user ? next() : res.redirect('/'));
  const needPlayer = (req, res, next) => (req.ctx.player ? next() : res.redirect('/'));
  const send = (req, res, title, body) => res.send(page(req.ctx, title, body));

  // -------------------------------------------------------------------------
  // Accounts
  // -------------------------------------------------------------------------
  app.get('/', (req, res) => {
    const { user, player, round } = req.ctx;
    if (!user) return send(req, res, 'Run the city with your friends', landing());
    if (!player) return send(req, res, `Join round ${round.id}`, joinForm(req));
    return send(req, res, 'Headquarters', hq(req));
  });

  app.post('/register', (req, res) => {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) { flash(res, 'err', 'Usernames are 3 to 20 letters, numbers or underscores.'); return res.redirect(303, '/'); }
    if (password.length < 6) { flash(res, 'err', 'Use a password of at least 6 characters.'); return res.redirect(303, '/'); }
    if (db.get('SELECT 1 FROM users WHERE username = ?', username)) { flash(res, 'err', 'That username is taken.'); return res.redirect(303, '/'); }
    const salt = crypto.randomBytes(16).toString('hex');
    const first = !db.get('SELECT 1 FROM users LIMIT 1');
    const info = db.run('INSERT INTO users (username, pass_hash, salt, is_admin, created_at) VALUES (?, ?, ?, ?, ?)',
      username, hashPassword(password, salt), salt, first ? 1 : 0, req.now);
    startSession(res, info.lastInsertRowid, req.now);
    res.redirect(303, '/');
  });

  app.post('/login', (req, res) => {
    const u = db.get('SELECT * FROM users WHERE username = ?', String(req.body.username || '').trim());
    const password = String(req.body.password || '');
    if (!u || !crypto.timingSafeEqual(Buffer.from(hashPassword(password, u.salt), 'hex'), Buffer.from(u.pass_hash, 'hex'))) {
      flash(res, 'err', 'Wrong username or password.');
      return res.redirect(303, '/');
    }
    startSession(res, u.id, req.now);
    res.redirect(303, '/');
  });

  function startSession(res, userId, now) {
    const token = crypto.randomBytes(32).toString('hex');
    db.run('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)', token, userId, now);
    setCookie(res, 'sid', token, SESSION_DAYS * 86400);
  }

  app.post('/logout', (req, res) => {
    if (req.sid) db.run('DELETE FROM sessions WHERE token = ?', req.sid);
    setCookie(res, 'sid', '', 0);
    res.redirect(303, '/');
  });

  app.post('/join', needUser, (req, res) => {
    if (req.ctx.player) return res.redirect(303, '/');
    act(req, res, '/', () => {
      G.createPlayer(db, req.ctx.round, req.ctx.user.id, req.body.name, req.body.city, req.now);
      return null;
    });
  });

  function landing() {
    const last = db.get('SELECT * FROM rounds WHERE finished = 1 ORDER BY id DESC LIMIT 1');
    const winners = last ? db.all('SELECT * FROM round_results WHERE round_id = ? ORDER BY place LIMIT 3', last.id) : [];
    return html`<p class="lead">A turn-based mafia game you play in the browser with your friends. Build a crew, run rackets, hit your rivals, form a family and finish the round as the richest crook in town.</p>
    <div class="cols">
      <form method="post" action="/login" class="box"><h2>Log in</h2>
        <label>Username <input name="username" autocomplete="username" required></label>
        <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
        <button>Log in</button></form>
      <form method="post" action="/register" class="box"><h2>New here?</h2>
        <label>Username <input name="username" autocomplete="username" required></label>
        <label>Password <input name="password" type="password" autocomplete="new-password" minlength="6" required></label>
        <button>Create account</button></form>
    </div>
    ${winners.length ? html`<h2>Last round's winners</h2><ol>${winners.map((w) => html`<li>${w.name}${w.family ? ` (${w.family})` : ''}: ${G.money(w.networth)}</li>`)}</ol>` : ''}
    <p><a href="/guide">How to play</a> · <a href="/turf-war/">Turf War</a>, a single-player real-time side game</p>`;
  }

  function joinForm(req) {
    const r = req.ctx.round;
    const count = db.get('SELECT COUNT(*) AS n FROM players WHERE round_id = ?', r.id).n;
    return html`<p>Round ${r.id} started ${ago(r.started_at, req.now)} and runs for another ${duration(r.ends_at - req.now)}. ${count} player${count === 1 ? ' is' : 's are'} in it. Everyone starts from the same stake, and the richest player when the round ends wins.</p>
    <form method="post" action="/join" class="box narrow">
      <label>Your mafia name this round <input name="name" maxlength="20" required></label>
      <label>Starting city <select name="city">${G.CITIES.map((c) => html`<option>${c}</option>`)}</select></label>
      <button>Join the round</button>
    </form>`;
  }

  // -------------------------------------------------------------------------
  // Headquarters
  // -------------------------------------------------------------------------
  function hq(req) {
    const p = req.ctx.player;
    const fam = p.family_id && db.get('SELECT * FROM families WHERE id = ?', p.family_id);
    const m = G.morale(p, 10);
    const events = db.all('SELECT * FROM events WHERE player_id = ? ORDER BY id DESC LIMIT 6', p.id);
    const row = (k, name, n, extra = '') => html`<tr><td>${name}</td><td class="n">${G.num(n)}</td><td class="muted">${extra}</td></tr>`;
    return html`
    ${G.isProtected(p, req.now) ? html`<div class="note">You're under protection for ${duration(p.protected_until - req.now)}. Nobody can attack you, and you can't attack or travel. <form method="post" action="/protection/leave" class="inline"><button class="small">Leave protection now</button></form></div>` : ''}
    <div class="cols">
      <section class="box"><h2>Earners</h2><table>
        ${G.OPS.map((k) => row(k, G.UNITS[k].plural, p[k]))}</table></section>
      <section class="box"><h2>Muscle</h2><table>
        ${G.MUSCLE.map((k) => row(k, G.UNITS[k].plural, p[k]))}
        <tr><td>Attack strength</td><td class="n">${G.num(G.force(p, 'atk').power)}</td><td></td></tr>
        <tr><td>Defense strength</td><td class="n">${G.num(G.force(p, 'def').power)}</td><td></td></tr></table></section>
      <section class="box"><h2>Stash</h2><table>
        ${Object.keys(G.WEAPONS).map((k) => row(k, G.WEAPONS[k].name, p[k]))}
        ${Object.keys(G.GOODS).map((k) => row(k, G.GOODS[k].name, p[k]))}
        ${Object.keys(G.CARS).map((k) => row(k, G.CARS[k].name, p[k], `${G.CARS[k].seats} seats`))}</table></section>
    </div>
    <p>Crew morale: <b>${Math.round(m.happiness * 100)}%</b>. ${m.happiness < 1 ? 'Keep them stocked with alcohol, weed and coke, give your earners muscle to protect them, and give every gunman a gun.' : 'Your crew is happy.'}
    ${fam ? html` Family: <a href="/family/${fam.id}">${fam.name}</a>.` : html` You're not in a family yet. <a href="/families">Find one</a>.`}
    Kills: <b>${G.num(p.kills)}</b>. Crew lost: <b>${G.num(p.losses)}</b>.</p>
    <h2>Latest news</h2>
    ${events.length ? html`<ul class="events">${events.map((e) => html`<li class="${e.seen ? '' : 'new'}"><span class="muted">${ago(e.created_at, req.now)}</span> ${e.body}</li>`)}</ul><p><a href="/news">All news</a></p>` : html`<p class="muted">Nothing yet.</p>`}`;
  }

  app.post('/protection/leave', needPlayer, (req, res) => act(req, res, '/', (p) => G.leaveProtection(db, p, req.now)));

  // -------------------------------------------------------------------------
  // Work, crew, market, bank, travel
  // -------------------------------------------------------------------------
  app.get('/work', needPlayer, (req, res) => {
    const p = req.ctx.player;
    const perTurnCash = p.card_dealer * 45 + p.hustler * 30 + p.punk * 20;
    send(req, res, 'Collect & produce', html`
      <p>Spend turns to put your crew to work. How much they bring in depends on their morale.</p>
      <div class="cols">
        <form method="post" action="/work/collect" class="box"><h2>Collect</h2>
          <p>Your casinos, loan sharks and gambling dens pay up to <b>${G.money(perTurnCash)}</b> per turn.</p>
          ${qtyInput('turns', p.turns, 'turns')}<button>Collect</button></form>
        <form method="post" action="/work/produce" class="box"><h2>Produce</h2>
          <p>Bootleggers distill alcohol; thugs cook weed and coke. Up to <b>${G.num(p.bootlegger * 3)}</b> alcohol, <b>${G.num(p.thug * 0.4)}</b> weed and <b>${G.num(p.thug * 0.15)}</b> coke per turn.</p>
          ${qtyInput('turns', p.turns, 'turns')}<button>Produce</button></form>
      </div>`);
  });
  for (const kind of ['collect', 'produce']) {
    app.post(`/work/${kind}`, needPlayer, (req, res) => act(req, res, '/work', (p) => G.work(db, p, kind, req.body.turns)));
  }

  app.get('/crew', needPlayer, (req, res) => {
    const p = req.ctx.player;
    const rows = Object.keys(G.UNITS).map((k) => {
      const u = G.UNITS[k];
      return html`<tr><td><b>${u.plural}</b><br><small class="muted">${u.desc}</small></td><td class="n">${G.money(u.price)}</td><td class="n">${G.num(p[k])}</td>
        <td><form method="post" action="/crew/hire" class="row"><input type="hidden" name="unit" value="${k}">${qtyInput('qty', Math.floor(p.cash / u.price))}<button>Hire</button></form></td></tr>`;
    });
    send(req, res, 'Hire crew', html`<p>Hiring takes 1 turn for every 10 people.</p>
      <table class="wide"><tr><th>Crew</th><th>Price</th><th>You have</th><th></th></tr>${rows}</table>`);
  });
  app.post('/crew/hire', needPlayer, (req, res) => act(req, res, '/crew', (p) => G.hire(db, p, req.body.unit, req.body.qty)));

  app.get('/market', needPlayer, (req, res) => {
    const p = req.ctx.player;
    const section = (title, items, note) => html`<h2>${title}</h2>${note ? html`<p class="muted">${note}</p>` : ''}
      <table class="wide"><tr><th>Item</th><th>Buy</th><th>Sell</th><th>You have</th><th></th><th></th></tr>
      ${Object.keys(items).map((k) => html`<tr><td>${items[k].name}</td><td class="n">${G.money(items[k].price)}</td><td class="n">${G.money(items[k].price * G.SELL_RATE)}</td><td class="n">${G.num(p[k])}</td>
        <td><form method="post" action="/market/buy" class="row"><input type="hidden" name="item" value="${k}">${qtyInput('qty', Math.floor(p.cash / items[k].price))}<button>Buy</button></form></td>
        <td><form method="post" action="/market/sell" class="row"><input type="hidden" name="item" value="${k}">${qtyInput('qty', p[k])}<button>Sell</button></form></td></tr>`)}</table>`;
    send(req, res, 'Black market', html`<p>Everything sells back for half what it cost.</p>
      ${section('Guns', G.WEAPONS, 'Each fighter carries one gun. Better guns multiply strength: Glock ×1.5, Shotgun ×2, Uzi ×3, AK-47 ×4. Unarmed fighters fight at ×0.5.')}
      ${section('Goods', G.GOODS, 'Your crew burns through alcohol, weed and coke while they work. Run dry and morale drops.')}
      ${section('Cars', G.CARS, 'Cars carry your muscle on drive-bys.')}`);
  });
  app.post('/market/buy', needPlayer, (req, res) => act(req, res, '/market', (p) => G.buy(db, p, req.body.item, req.body.qty)));
  app.post('/market/sell', needPlayer, (req, res) => act(req, res, '/market', (p) => G.sell(db, p, req.body.item, req.body.qty)));

  app.get('/bank', needPlayer, (req, res) => {
    const p = req.ctx.player;
    const cap = G.bankCap(p);
    send(req, res, 'Safebox', html`<p>Cash on hand can be stolen in a raid. Your safebox can't. It holds up to a quarter of your net worth: right now <b>${G.money(cap)}</b>.</p>
      <div class="cols">
        <form method="post" action="/bank/deposit" class="box"><h2>Put in</h2>${qtyInput('amount', Math.min(p.cash, Math.max(0, cap - p.bank)), 'amount')}<button>Deposit</button></form>
        <form method="post" action="/bank/withdraw" class="box"><h2>Take out</h2>${qtyInput('amount', p.bank, 'amount')}<button>Withdraw</button></form>
      </div>`);
  });
  app.post('/bank/deposit', needPlayer, (req, res) => act(req, res, '/bank', (p) => G.deposit(db, p, req.body.amount)));
  app.post('/bank/withdraw', needPlayer, (req, res) => act(req, res, '/bank', (p) => G.withdraw(db, p, req.body.amount)));

  app.get('/travel', needPlayer, (req, res) => {
    const p = req.ctx.player;
    const counts = Object.fromEntries(db.all('SELECT city, COUNT(*) AS n FROM players WHERE round_id = ? GROUP BY city', p.round_id).map((r) => [r.city, r.n]));
    const homes = Object.fromEntries(db.all('SELECT city, GROUP_CONCAT(name, \', \') AS names FROM families WHERE round_id = ? GROUP BY city', p.round_id).map((r) => [r.city, r.names]));
    send(req, res, 'Travel', html`<p>You can only hit players in the same city. Moving your crew costs <b>${G.money(G.travelCost(p))}</b> and 5 turns.</p>
      <table class="wide"><tr><th>City</th><th>Players</th><th>Family home turf</th><th></th></tr>
      ${G.CITIES.map((c) => html`<tr><td>${c}</td><td class="n">${counts[c] || 0}</td><td>${homes[c] || ''}</td><td>${c === p.city ? html`<b>You're here</b>` : html`<form method="post" action="/travel"><input type="hidden" name="city" value="${c}"><button>Go</button></form>`}</td></tr>`)}</table>`);
  });
  app.post('/travel', needPlayer, (req, res) => act(req, res, '/travel', (p) => G.travel(db, p, req.body.city, req.now)));

  // -------------------------------------------------------------------------
  // Players and attacks
  // -------------------------------------------------------------------------
  function roster(roundId) {
    const list = db.all(`SELECT p.*, f.name AS family_name FROM players p LEFT JOIN families f ON f.id = p.family_id WHERE p.round_id = ?`, roundId);
    for (const x of list) x.nw = G.networth(x);
    return list.sort((a, b) => b.nw - a.nw);
  }

  app.get('/players', needPlayer, (req, res) => {
    const p = req.ctx.player;
    const mine = G.networth(p);
    const list = roster(p.round_id);
    send(req, res, 'Players', html`<p>You can attack players in your city worth between ${G.money(mine / 2)} and ${G.money(mine * 4)}, and anyone who hit you in the last 24 hours.</p>
      <table class="wide"><tr><th>#</th><th>Name</th><th>Rank</th><th>Net worth</th><th>City</th><th>Family</th><th></th></tr>
      ${list.map((x, i) => {
        const inRange = x.nw >= mine / 2 && x.nw <= mine * 4;
        let tag = '';
        if (x.id === p.id) tag = html`<b>you</b>`;
        else if (G.isProtected(x, req.now)) tag = html`<span class="muted">protected</span>`;
        else if (x.city !== p.city) tag = html`<span class="muted">other city</span>`;
        else if (p.family_id && x.family_id === p.family_id) tag = html`<span class="muted">family</span>`;
        else if (G.isRevenge(db, p, x, req.now)) tag = html`<a href="/player/${x.id}" class="hot">revenge</a>`;
        else if (inRange) tag = html`<a href="/player/${x.id}" class="hot">in range</a>`;
        return html`<tr class="${x.id === p.id ? 'me' : ''}"><td>${i + 1}</td><td><a href="/player/${x.id}">${x.name}</a></td><td>${G.rankOf(x.nw)}</td><td class="n">${G.money(x.nw)}</td><td>${x.city}</td><td>${x.family_name ? html`<a href="/family/${x.family_id}">${x.family_name}</a>` : ''}</td><td>${tag}</td></tr>`;
      })}</table>`);
  });

  app.get('/player/:id', needPlayer, (req, res) => {
    const p = req.ctx.player;
    const t = db.get('SELECT p.*, f.name AS family_name FROM players p LEFT JOIN families f ON f.id = p.family_id WHERE p.id = ? AND p.round_id = ?', Number(req.params.id), p.round_id);
    if (!t) return res.status(404).send(page(req.ctx, 'Not found', html`<p>No such player this round.</p>`));
    const nw = G.networth(t);
    let canHit = null;
    try { G.attackCheck(db, p, t, 'raid', req.now); canHit = true; } catch (e) { if (!(e instanceof G.GameError)) throw e; canHit = e.message; }
    const maxed = G.hourlyAllowance(db, t, req.now) <= 0;
    const attacks = db.all(`SELECT a.*, pa.name AS attacker, pd.name AS defender FROM attacks a JOIN players pa ON pa.id = a.attacker_id JOIN players pd ON pd.id = a.defender_id
      WHERE (a.attacker_id = ? AND a.defender_id = ?) OR (a.attacker_id = ? AND a.defender_id = ?) ORDER BY a.id DESC LIMIT 8`, p.id, t.id, t.id, p.id);
    send(req, res, t.name, html`<p>${G.rankOf(nw)} · net worth <b>${G.money(nw)}</b> · in <b>${t.city}</b>${t.family_name ? html` · <a href="/family/${t.family_id}">${t.family_name}</a> family` : ''} · ${G.num(t.kills)} kills${G.isProtected(t, req.now) ? ' · under protection' : ''}</p>
      ${t.id !== p.id ? html`
      <h2>Attack</h2>
      ${canHit === true || (maxed && typeof canHit === 'string' && canHit.includes('maxed')) ? html`
        <p class="muted">Your attack strength: ${G.num(G.force(p, 'atk').power)}. You can't see their defense; a raid tells you how it went.</p>
        <div class="attacks">${Object.keys(G.ATTACKS).map((k) => html`<form method="post" action="/attack/${t.id}" class="box"><input type="hidden" name="kind" value="${k}"><b>${G.ATTACKS[k].name}</b><small>${G.ATTACKS[k].desc} ${G.ATTACKS[k].turns} turns.</small><button ${maxed && k !== 'driveby' ? raw('disabled') : ''}>Go</button></form>`)}</div>`
        : html`<p class="muted">${canHit}</p>`}
      <h2>Send a message</h2>
      <form method="post" action="/messages/send" class="box"><input type="hidden" name="to" value="${t.id}"><textarea name="body" rows="3" maxlength="2000" required></textarea><button>Send</button></form>
      ${attacks.length ? html`<h2>History between you</h2><ul class="events">${attacks.map((a) => html`<li><span class="muted">${ago(a.created_at, req.now)}</span> ${a.attacker} hit ${a.defender} with ${G.withNoun(a.kind)} and ${a.won ? 'won' : 'lost'}.</li>`)}</ul>` : ''}` : ''}`);
  });

  app.post('/attack/:id', needPlayer, (req, res) => act(req, res, `/player/${Number(req.params.id)}`, (p) => {
    const t = db.get('SELECT * FROM players WHERE id = ?', Number(req.params.id));
    return G.attack(db, p, t, String(req.body.kind), req.now).report;
  }));

  // -------------------------------------------------------------------------
  // Families
  // -------------------------------------------------------------------------
  app.get('/families', needPlayer, (req, res) => {
    const p = req.ctx.player;
    const fams = db.all('SELECT f.*, b.name AS boss, (SELECT COUNT(*) FROM players WHERE family_id = f.id) AS size FROM families f JOIN players b ON b.id = f.boss_id WHERE f.round_id = ?', p.round_id);
    for (const f of fams) f.nw = G.familyNetworth(db, f.id);
    fams.sort((a, b) => b.nw - a.nw);
    send(req, res, 'Families', html`<table class="wide"><tr><th>Family</th><th>Boss</th><th>Members</th><th>Home turf</th><th>Net worth</th><th>Kills</th></tr>
      ${fams.map((f) => html`<tr><td><a href="/family/${f.id}">${f.name}</a></td><td>${f.boss}</td><td class="n">${f.size}/${G.CONFIG.familyMax}</td><td>${f.city}</td><td class="n">${G.money(f.nw)}</td><td class="n">${G.num(f.kills)}</td></tr>`)}</table>
      ${!fams.length ? html`<p class="muted">No families yet.</p>` : ''}
      ${!p.family_id ? html`<form method="post" action="/family/create" class="box narrow"><h2>Start a family</h2>
        <p>Costs ${G.money(G.CONFIG.familyCost)}. Your current city (${p.city}) becomes home turf, where members defend 20% harder.</p>
        <label>Family name <input name="name" maxlength="24" required></label><button>Start family</button></form>` : ''}`);
  });

  app.get('/family/:id', needPlayer, (req, res) => {
    const p = req.ctx.player;
    const f = db.get('SELECT * FROM families WHERE id = ? AND round_id = ?', Number(req.params.id), p.round_id);
    if (!f) return res.status(404).send(page(req.ctx, 'Not found', html`<p>No such family.</p>`));
    const members = db.all('SELECT * FROM players WHERE family_id = ?', f.id);
    for (const m of members) m.nw = G.networth(m);
    members.sort((a, b) => b.nw - a.nw);
    const isMember = p.family_id === f.id, isBoss = f.boss_id === p.id;
    const requests = isBoss ? db.all('SELECT p.* FROM family_requests r JOIN players p ON p.id = r.player_id WHERE r.family_id = ?', f.id) : [];
    const posts = isMember ? db.all('SELECT fp.*, p.name FROM family_posts fp JOIN players p ON p.id = fp.player_id WHERE fp.family_id = ? ORDER BY fp.id DESC LIMIT 30', f.id) : [];
    const asked = !isMember && db.get('SELECT 1 FROM family_requests WHERE player_id = ? AND family_id = ?', p.id, f.id);
    send(req, res, `The ${f.name} family`, html`<p>Home turf <b>${f.city}</b> · net worth <b>${G.money(members.reduce((s, m) => s + m.nw, 0))}</b> · ${G.num(f.kills)} kills</p>
      <table class="wide"><tr><th>Member</th><th>Rank</th><th>Net worth</th><th>City</th><th></th></tr>
      ${members.map((m) => html`<tr><td><a href="/player/${m.id}">${m.name}</a>${m.id === f.boss_id ? ' (boss)' : ''}</td><td>${G.rankOf(m.nw)}</td><td class="n">${G.money(m.nw)}</td><td>${m.city}</td>
        <td>${isBoss && m.id !== p.id ? html`<form method="post" action="/family/kick"><input type="hidden" name="player" value="${m.id}"><button class="small">Kick</button></form>` : ''}</td></tr>`)}</table>
      ${!p.family_id ? (asked ? html`<p class="muted">You asked to join. Waiting on the boss.</p>` : html`<form method="post" action="/family/request"><input type="hidden" name="family" value="${f.id}"><button>Ask to join</button></form>`) : ''}
      ${requests.length ? html`<h2>Want to join</h2><ul>${requests.map((r) => html`<li>${r.name} (${G.money(G.networth(r))})
        <form method="post" action="/family/answer" class="inline"><input type="hidden" name="player" value="${r.id}"><button name="accept" value="1" class="small">Accept</button> <button name="accept" value="0" class="small">Refuse</button></form></li>`)}</ul>` : ''}
      ${isMember ? html`<h2>Family board</h2>
        <form method="post" action="/family/post" class="box"><textarea name="body" rows="2" maxlength="1000" placeholder="Only family can read this" required></textarea><button>Post</button></form>
        <ul class="events">${posts.map((x) => html`<li><span class="muted">${ago(x.created_at, req.now)}</span> <b>${x.name}:</b> ${x.body}</li>`)}</ul>
        <form method="post" action="/family/leave" onsubmit="return confirm('Leave the family?')"><button class="small danger">Leave the family</button></form>` : ''}`);
  });

  app.post('/family/create', needPlayer, (req, res) => act(req, res, '/families', (p) => G.createFamily(db, p, req.body.name, req.now)));
  app.post('/family/request', needPlayer, (req, res) => act(req, res, `/family/${Number(req.body.family)}`, (p) => G.requestJoin(db, p, Number(req.body.family), req.now)));
  app.post('/family/answer', needPlayer, (req, res) => act(req, res, `/family/${req.ctx.player.family_id}`, (p) => G.answerRequest(db, p, Number(req.body.player), req.body.accept === '1', req.now)));
  app.post('/family/kick', needPlayer, (req, res) => act(req, res, `/family/${req.ctx.player.family_id}`, (p) => G.kick(db, p, Number(req.body.player), req.now)));
  app.post('/family/leave', needPlayer, (req, res) => act(req, res, '/families', (p) => G.leaveFamily(db, p, req.now)));
  app.post('/family/post', needPlayer, (req, res) => act(req, res, `/family/${req.ctx.player.family_id}`, (p) => G.postToFamily(db, p, req.body.body, req.now)));

  // -------------------------------------------------------------------------
  // News, messages, rankings
  // -------------------------------------------------------------------------
  app.get('/news', needPlayer, (req, res) => {
    const p = req.ctx.player;
    const events = db.all('SELECT * FROM events WHERE player_id = ? ORDER BY id DESC LIMIT 100', p.id);
    db.run('UPDATE events SET seen = 1 WHERE player_id = ? AND seen = 0', p.id);
    req.ctx.counts.events = 0;
    send(req, res, 'News', events.length ? html`<ul class="events">${events.map((e) => html`<li class="${e.seen ? '' : 'new'}"><span class="muted">${ago(e.created_at, req.now)}</span> ${e.body}</li>`)}</ul>` : html`<p class="muted">Nothing yet.</p>`);
  });

  app.get('/messages', needPlayer, (req, res) => {
    const p = req.ctx.player;
    const inbox = db.all('SELECT m.*, p.name FROM messages m JOIN players p ON p.id = m.from_id WHERE m.to_id = ? ORDER BY m.id DESC LIMIT 50', p.id);
    const sent = db.all('SELECT m.*, p.name FROM messages m JOIN players p ON p.id = m.to_id WHERE m.from_id = ? ORDER BY m.id DESC LIMIT 20', p.id);
    db.run('UPDATE messages SET seen = 1 WHERE to_id = ? AND seen = 0', p.id);
    req.ctx.counts.messages = 0;
    const others = db.all('SELECT id, name FROM players WHERE round_id = ? AND id != ? ORDER BY name', p.round_id, p.id);
    send(req, res, 'Messages', html`
      <form method="post" action="/messages/send" class="box"><label>To <select name="to">${others.map((o) => html`<option value="${o.id}">${o.name}</option>`)}</select></label>
        <textarea name="body" rows="3" maxlength="2000" required></textarea><button>Send</button></form>
      <h2>Inbox</h2>${inbox.length ? html`<ul class="events">${inbox.map((m) => html`<li class="${m.seen ? '' : 'new'}"><span class="muted">${ago(m.created_at, req.now)}</span> <a href="/player/${m.from_id}"><b>${m.name}</b></a>: ${m.body}</li>`)}</ul>` : html`<p class="muted">No messages.</p>`}
      ${sent.length ? html`<h2>Sent</h2><ul class="events">${sent.map((m) => html`<li><span class="muted">${ago(m.created_at, req.now)}</span> to <b>${m.name}</b>: ${m.body}</li>`)}</ul>` : ''}`);
  });
  app.post('/messages/send', needPlayer, (req, res) => act(req, res, req.get('referer') && new URL(req.get('referer')).pathname.startsWith('/player/') ? new URL(req.get('referer')).pathname : '/messages', (p) => {
    const to = db.get('SELECT * FROM players WHERE id = ?', Number(req.body.to));
    const msg = G.sendMessage(db, p, to, req.body.body, req.now);
    G.addEvent(db, to.id, `New message from ${p.name}.`, req.now);
    return msg;
  }));

  app.get('/rankings', needPlayer, (req, res) => {
    const p = req.ctx.player;
    const list = roster(p.round_id).slice(0, 25);
    const killers = db.all('SELECT name, kills FROM players WHERE round_id = ? AND kills > 0 ORDER BY kills DESC LIMIT 10', p.round_id);
    const fams = db.all('SELECT * FROM families WHERE round_id = ?', p.round_id);
    for (const f of fams) f.nw = G.familyNetworth(db, f.id);
    fams.sort((a, b) => b.nw - a.nw);
    const past = db.all('SELECT r.round_id, r.name, r.family, r.networth FROM round_results r WHERE r.place = 1 ORDER BY r.round_id DESC LIMIT 10');
    send(req, res, 'Rankings', html`<div class="cols">
      <section class="box"><h2>Richest</h2><ol>${list.map((x) => html`<li>${x.name}: ${G.money(x.nw)}</li>`)}</ol></section>
      <section class="box"><h2>Deadliest</h2>${killers.length ? html`<ol>${killers.map((x) => html`<li>${x.name}: ${G.num(x.kills)} kills</li>`)}</ol>` : html`<p class="muted">No blood spilled yet.</p>`}</section>
      <section class="box"><h2>Families</h2>${fams.length ? html`<ol>${fams.map((f) => html`<li>${f.name}: ${G.money(f.nw)}, ${G.num(f.kills)} kills</li>`)}</ol>` : html`<p class="muted">No families yet.</p>`}</section>
    </div>
    ${past.length ? html`<h2>Past round winners</h2><ul>${past.map((r) => html`<li>Round ${r.round_id}: ${r.name}${r.family ? ` (${r.family})` : ''}, ${G.money(r.networth)}</li>`)}</ul>` : ''}`);
  });

  app.get('/guide', (req, res) => send(req, res, 'How to play', guide()));

  function guide() {
    const c = G.CONFIG;
    return html`<div class="prose">
    <p>Mafia Web is played in <b>rounds</b> of ${c.roundDays} days. Everyone starts with the same stake. When the round ends, the player with the highest <b>net worth</b> wins, the results go in the hall of fame, and a fresh round starts.</p>
    <h2>Turns</h2><p>Almost everything costs turns. You get ${c.turnsPerInterval} turns every ${c.turnIntervalMin} minutes, up to ${G.num(c.maxTurns)} saved. Check in now and then, spend them, and come back later.</p>
    <h2>Making money</h2><p><b>Collect</b> to cash in from your card dealers, hustlers and punks. <b>Produce</b> to have bootleggers distill alcohol and thugs cook weed and coke. Your crew uses up alcohol, weed and coke while they work; if you run dry, or your earners have too little muscle guarding them, or your muscle has no guns, morale drops and they earn less. Really unhappy earners quit.</p>
    <h2>Crew</h2><p>Hitmen hit hardest. Thugs are all-rounders. Bodyguards are cheap and great on defense but useless on offense. Every fighter needs a gun: the best guns go to your strongest fighters first.</p>
    <h2>Attacking</h2><p>You can hit players in your own city whose net worth is between half and four times yours. A raid steals cash on hand, extortion kills earners, hitting the armory steals guns and hitting the drug lab steals drugs. A drive-by needs cars, steals nothing, but kills lots of muscle. Nobody can lose more than ${Math.round(c.maxHourlyLoss * 100)}% of their net worth per hour to raids; once that's hit they're "maxed" and only drive-bys work. If someone hits you, you can take revenge on them for 24 hours whatever their net worth.</p>
    <h2>Staying safe</h2><p>Keep cash in your <b>safebox</b>, which raids can't touch. It holds up to a quarter of your net worth. New players get ${c.protectionHours} hours of protection; you can leave it early.</p>
    <h2>Families</h2><p>Start a family for ${G.money(c.familyCost)} or ask to join one. Family members can't hit each other, share a private board, and defend 20% harder when they're in the family's home city. Families are ranked by combined net worth and kills.</p>
    <h2>Travel</h2><p>There are ${G.CITIES.length} cities. Moving your crew costs cash and 5 turns. Go where your targets are, or home to your family.</p>
    </div>`;
  }

  // -------------------------------------------------------------------------
  // Admin
  // -------------------------------------------------------------------------
  const needAdmin = (req, res, next) => (req.ctx.user && req.ctx.user.is_admin ? next() : res.redirect('/'));
  app.get('/admin', needAdmin, (req, res) => {
    const r = req.ctx.round;
    const users = db.get('SELECT COUNT(*) AS n FROM users').n;
    send(req, res, 'Admin', html`<p>${users} accounts. Round ${r.id} ends in ${duration(r.ends_at - req.now)}.</p>
      <form method="post" action="/admin/new-round" class="box narrow" onsubmit="return confirm('End this round now and start a new one?')">
        <h2>Start a new round now</h2><p>Ends the current round, records its results and starts fresh.</p>
        <label>Length in days <input type="number" name="days" min="0.01" step="any" value="${G.CONFIG.roundDays}"></label>
        <button class="danger">End round and start a new one</button></form>`);
  });
  app.post('/admin/new-round', needAdmin, (req, res) => {
    const days = Number(req.body.days) > 0 ? Number(req.body.days) : G.CONFIG.roundDays;
    db.tx(() => {
      G.finishRound(db, req.ctx.round);
      G.startRound(db, req.now, days);
    });
    flash(res, 'ok', 'New round started.');
    res.redirect(303, '/');
  });

  app.use((err, req, res, _next) => {
    console.error(err);
    res.status(500).send('Something went wrong.');
  });

  return app;
}

module.exports = { createApp };
