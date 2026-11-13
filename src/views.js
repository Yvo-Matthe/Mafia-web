'use strict';
// Tiny HTML templating: html`...` escapes every interpolated value unless it is itself html`` or raw().
const G = require('./game');

class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
const raw = (s) => new Raw(String(s));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function render(v) {
  if (v === null || v === undefined || v === false) return '';
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(render).join('');
  return esc(v);
}

function html(strings, ...vals) {
  let out = '';
  strings.forEach((s, i) => {
    out += s;
    if (i < vals.length) out += render(vals[i]);
  });
  return new Raw(out);
}

function ago(ts, now = Date.now()) {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function duration(ms) {
  const m = Math.ceil(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

const MENU = [
  ['Headquarters', '/'],
  ['Collect & produce', '/work'],
  ['Hire crew', '/crew'],
  ['Black market', '/market'],
  ['Safebox', '/bank'],
  ['Travel', '/travel'],
  ['Players', '/players'],
  ['Families', '/families'],
  ['Rankings', '/rankings'],
  ['News', '/news'],
  ['Messages', '/messages'],
  ['How to play', '/guide'],
];

function page(ctx, title, body) {
  const { user, player, round, flash, counts, now = Date.now() } = ctx;
  let bar = '';
  if (player) {
    const nw = G.networth(player);
    bar = html`<div class="stats">
      <span><b>${player.name}</b> · ${G.rankOf(nw)}</span>
      <span>Cash <b class="gold">${G.money(player.cash)}</b></span>
      <span>Safebox <b>${G.money(player.bank)}</b></span>
      <span>Turns <b>${G.num(player.turns)}</b> <small>+${G.CONFIG.turnsPerInterval} in ${duration(G.nextTurnsIn(player, now))}</small></span>
      <span>Net worth <b>${G.money(nw)}</b></span>
      <span>City <b>${player.city}</b></span>
      ${G.isProtected(player, now) ? html`<span class="prot">Protected ${duration(player.protected_until - now)}</span>` : ''}
    </div>`;
  }
  const badge = (label, href) => {
    const n = href === '/news' ? counts?.events : href === '/messages' ? counts?.messages : 0;
    return n ? html`${label} <span class="badge">${n}</span>` : label;
  };
  const menu = player ? html`<nav class="menu">${MENU.map(([label, href]) => html`<a href="${href}" ${ctx.path === href ? raw('class="on"') : ''}>${badge(label, href)}</a>`)}
      ${user && user.is_admin ? html`<a href="/admin">Admin</a>` : ''}
      <form method="post" action="/logout"><button class="link">Log out</button></form></nav>` : '';

  return '<!doctype html>' + html`<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Mafia Web</title>
<link rel="stylesheet" href="/style.css">
</head><body>
<header class="top"><a href="/" class="logo">Mafia Web</a>
${round ? html`<span class="round">Round ${round.id} ends in ${duration(round.ends_at - now)}</span>` : ''}
${user && !player ? html`<form method="post" action="/logout" class="inline"><button class="link">Log out ${user.username}</button></form>` : ''}
</header>
${bar}
<div class="wrap">${menu}<main>
${flash ? html`<div class="flash ${flash.type}">${flash.text}</div>` : ''}
<h1>${title}</h1>
${body}
</main></div>
</body></html>`.s;
}

// A number input with a "max" button that fills in the largest sensible amount.
function qtyInput(name, max, placeholder = 'how many') {
  return html`<span class="qty"><input type="number" name="${name}" min="1" placeholder="${placeholder}" required>${max > 0 ? html`<button type="button" class="max" data-max="${Math.floor(max)}" onclick="this.previousElementSibling.value=this.dataset.max">max ${G.num(max)}</button>` : ''}</span>`;
}

module.exports = { html, raw, esc, page, ago, duration, qtyInput };
