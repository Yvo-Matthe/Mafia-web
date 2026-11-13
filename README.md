# Mafia Web

A turn-based multiplayer mafia game for the browser, made for playing with friends. It's in the style of the classic browser mafia games: build a crew, run rackets, hit your rivals, form a family, and finish the round as the richest crook in town.

## How it plays

- The game runs in **rounds** (10 days by default). Everyone starts with the same stake. When a round ends, the player with the highest net worth wins, the results go into the hall of fame, and a fresh round starts.
- **Turns** pay for almost everything. You get 10 every 10 minutes, up to 3,000 saved.
- **Collect** cash from your card dealers, hustlers and punks. **Produce** alcohol with bootleggers, and weed and coke with thugs. Your crew uses up alcohol, weed and coke while they work. Earners also want muscle around them, and muscle wants guns. A crew short on any of these earns less, and very unhappy earners quit.
- **Hire** hitmen (best attackers), thugs (all-rounders) and bodyguards (cheap defense). Arm them on the **black market** with Glocks, shotguns, Uzis and AK-47s.
- **Attack** players in your own city whose net worth is between half and four times yours:
  - A raid steals the cash they're carrying.
  - A shakedown kills their earners.
  - An armory hit steals their guns, and a drug lab hit steals their drugs.
  - A drive-by needs cars. It steals nothing but kills a lot of muscle.
- Nobody loses more than 10% of their net worth per hour to raids. Once they hit that cap, they're "maxed".
- If someone hits you, you can take **revenge** on them for 24 hours, whatever their net worth.
- Keep cash in your **safebox**, which raids can't touch. It holds up to a quarter of your net worth.
- **Travel** between five cities to reach targets, or to go home to your family.
- **Families** cost $100,000 to start, and other players ask to join. Members can't hit each other, they share a private board, and they defend 20% harder in the family's home city.
- New players get 12 hours of **protection**, which they can leave early.
- There are also **news** feeds, private **messages** and **rankings** (richest, deadliest and families).

The first account to register becomes the admin. The admin can end the current round and start a new one from the Admin page.

The old single-player real-time game, Turf War, is still available at `/turf-war/`.

## Running it

Requires Node.js 22.13 or newer. It uses Node's built-in SQLite, so nothing native needs compiling.

```sh
npm install
npm start          # http://localhost:3000
npm test
```

All game data lives in one SQLite file (`data/mafia.db` by default).

| Setting | Default | |
| --- | --- | --- |
| `PORT` | 3000 | |
| `DB_FILE` | `data/mafia.db` | Where the database lives. Put it on persistent storage. |
| `SECURE_COOKIES` | off | Set to `1` when serving over HTTPS. |
| `ROUND_DAYS` | 10 | Length of new rounds. |
| `TURN_INTERVAL_MIN` / `TURNS_PER_INTERVAL` | 10 / 10 | Turn income. |
| `MAX_TURNS` / `START_TURNS` | 3000 / 300 | |
| `PROTECTION_HOURS` | 12 | Protection for new players. |
| `MAX_HOURLY_LOSS` | 0.1 | Share of net worth that can be taken per hour. |
| `FAMILY_COST` / `FAMILY_MAX` | 100000 / 10 | |

## Hosting it for your friends

It's one small Node process plus a SQLite file, so any host that keeps a disk between restarts works.

- **Fly.io** (about $2–3 a month): run `fly launch --copy-config --no-deploy`, then `fly volumes create data --size 1`, then `fly deploy`. The included `fly.toml` and `Dockerfile` handle the rest.
- **A small VPS** (any $4–5 a month server): install Node 22, clone the repo, run `npm ci && npm start` behind Caddy or nginx for HTTPS, and set `SECURE_COOKIES=1`.
- **Railway** or **Render** also work, but only with a persistent disk attached and `DB_FILE` pointed at it. Without one, the database is wiped on every deploy.

## Code

- `server.js`: starts the server.
- `src/app.js`: routes and pages (server-rendered HTML, no front-end build).
- `src/game.js`: game rules (economy, combat, families, rounds).
- `src/db.js`: SQLite schema.
- `src/views.js`: layout and the escaping HTML template helper.
- `public/`: stylesheet, plus the Turf War side game.
- `test/`: rule tests, and an end-to-end test where three players play through the web app.
