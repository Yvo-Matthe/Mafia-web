'use strict';
// Drives the real web app the way three friends would, through forms and redirects.
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');

function client(base) {
  let cookies = {};
  const jar = (res) => {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const k = pair.slice(0, i), v = pair.slice(i + 1);
      if (v === '' || /Max-Age=0/.test(c)) delete cookies[k]; else cookies[k] = v;
    }
  };
  const header = () => Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  async function req(method, path, form) {
    let res = await fetch(base + path, {
      method,
      redirect: 'manual',
      headers: { cookie: header(), 'content-type': 'application/x-www-form-urlencoded', origin: base },
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
    jar(res);
    while (res.status === 303 || res.status === 302) {
      res = await fetch(base + res.headers.get('location'), { redirect: 'manual', headers: { cookie: header() } });
      jar(res);
    }
    const text = await res.text();
    assert.ok(res.status < 500, `${method} ${path} -> ${res.status}`);
    return { status: res.status, text };
  }
  return { get: (p) => req('GET', p), post: (p, f) => req('POST', p, f) };
}

const flashOf = (text) => (text.match(/<div class="flash (ok|err)">([^<]*)<\/div>/) || [])[2] || '';

test('three friends play a round', async () => {
  const db = openDb(':memory:');
  const server = createApp(db).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const [a, b, c] = [client(base), client(base), client(base)];
    await a.post('/register', { username: 'tony', password: 'secret1' });
    await b.post('/register', { username: 'sal', password: 'secret2' });
    await c.post('/register', { username: 'vic', password: 'secret3' });
    assert.match((await a.get('/')).text, /Join round 1/);

    await a.post('/join', { name: 'Tony Two-Times', city: 'Chicago' });
    await b.post('/join', { name: 'Sal', city: 'Chicago' });
    await c.post('/join', { name: 'Vic', city: 'Miami' });
    assert.match((await a.get('/')).text, /Headquarters/);

    // Every page renders for a player.
    for (const p of ['/', '/work', '/crew', '/market', '/bank', '/travel', '/players', '/families', '/rankings', '/news', '/messages', '/guide', '/admin']) {
      const r = await a.get(p);
      assert.equal(r.status, 200, p);
    }

    let r = await a.post('/work/collect', { turns: 20 });
    assert.match(flashOf(r.text), /brought in \$/);
    r = await a.post('/work/produce', { turns: 5 });
    assert.match(flashOf(r.text), /producing/);
    r = await a.post('/crew/hire', { unit: 'hitman', qty: 20 });
    assert.match(flashOf(r.text), /hired 20 Hitmen/);
    r = await a.post('/market/buy', { item: 'uzi', qty: 10 });
    assert.match(flashOf(r.text), /bought 10 Uzi/);
    r = await a.post('/market/buy', { item: 'sedan', qty: 1 });
    r = await a.post('/market/sell', { item: 'weed', qty: 10 });
    assert.match(flashOf(r.text), /sold 10 Weed/);
    r = await a.post('/bank/deposit', { amount: 1000 });
    assert.match(flashOf(r.text), /safebox/);
    r = await a.post('/crew/hire', { unit: 'hitman', qty: 'lots' });
    assert.match(flashOf(r.text), /Enter how many/);

    // Protected players can't fight.
    const sal = db.get("SELECT id FROM players WHERE name = 'Sal'").id;
    r = await a.post(`/attack/${sal}`, { kind: 'raid' });
    assert.match(flashOf(r.text), /protection/);
    await a.post('/protection/leave');
    await b.post('/protection/leave');
    r = await a.post(`/attack/${sal}`, { kind: 'raid' });
    assert.match(flashOf(r.text), /the raid on Sal/);
    r = await a.post(`/attack/${sal}`, { kind: 'driveby' });
    assert.match(flashOf(r.text), /drive-by on Sal/);
    assert.match((await b.get('/')).text, /Tony Two-Times hit you/);
    assert.match((await b.get('/players')).text, /revenge/);

    // Family: Sal starts one, Vic travels and joins.
    await b.post('/market/buy', { item: 'alcohol', qty: 1 });
    db.run("UPDATE players SET cash = cash + 200000 WHERE name = 'Sal'");
    r = await b.post('/family/create', { name: 'The Outfit' });
    assert.match(flashOf(r.text), /The Outfit family is born/);
    const fam = db.get('SELECT id FROM families').id;
    r = await c.post('/family/request', { family: fam });
    assert.match(flashOf(r.text), /asked to join/);
    const vic = db.get("SELECT id FROM players WHERE name = 'Vic'").id;
    r = await b.post('/family/answer', { player: vic, accept: '1' });
    assert.match(flashOf(r.text), /Vic is now part of the family/);
    r = await c.post('/family/post', { body: 'Meet at the docks <b>tonight</b>' });
    r = await b.get(`/family/${fam}`);
    assert.match(r.text, /Meet at the docks &lt;b&gt;tonight&lt;\/b&gt;/, 'posts are escaped');
    r = await c.post('/travel', { city: 'Chicago' });
    assert.match(flashOf(r.text), /protection/);

    // Messages.
    r = await c.post('/messages/send', { to: sal, body: 'You owe me' });
    assert.match(flashOf(r.text), /Message sent to Sal/);
    assert.match((await b.get('/messages')).text, /You owe me/);

    // Admin starts a new round; everyone has to rejoin.
    r = await b.get('/admin');
    assert.doesNotMatch(r.text, /Start a new round now/);
    await a.post('/admin/new-round', { days: 3 });
    assert.match((await b.get('/')).text, /Join round 2/);
    assert.match((await c.get('/')).text, /Last round|Join round 2/);
    assert.ok(db.get('SELECT COUNT(*) AS n FROM round_results WHERE round_id = 1').n === 3);

    // Login and cross-site posts.
    const d = client(base);
    r = await d.post('/login', { username: 'tony', password: 'wrong' });
    assert.match(flashOf(r.text), /Wrong username or password/);
    r = await d.post('/login', { username: 'tony', password: 'secret1' });
    assert.match(r.text, /Join round 2/);
    const evil = await fetch(base + '/logout', { method: 'POST', headers: { origin: 'https://evil.example' } });
    assert.equal(evil.status, 403);
  } finally {
    server.close();
  }
});
