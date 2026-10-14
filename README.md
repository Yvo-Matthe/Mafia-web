# Mafia Web

Browser games with a mafia theme.

## Turf War

A real-time strategy game: your crime family against three AI rival families, fighting block by block for control of the city.

**Play:** open `index.html` in a browser. No build step, no server, no dependencies. It also works as-is on GitHub Pages (Settings → Pages → deploy from the branch root).

### How it plays

- The city is 24 blocks. Each family starts with a compound in one corner; the rest of the city is up for grabs.
- Every block you hold pays cash every second. Protection rackets pay least; the docks and the casinos in the middle of town pay most.
- Spend cash at your compound on **Thugs** (cheap, fast), **Enforcers** (tough, slow) and **Hitmen** (long range, fragile).
- Move your crew into a block. With no rivals there, your grip grows until the block is yours. Any rival standing in it contests it.
- Open a **front business** in a block you hold to double its income.
- Compounds defend themselves and are slow to take.
- **Win** by taking every rival compound, or by holding 18 of the 24 blocks. **Lose** if your compound falls or a rival reaches 18 blocks.

### Controls

| Action | Mouse / keyboard | Touch |
| --- | --- | --- |
| Select a unit / box-select | Click / drag | Tap / drag |
| Select whole crew | `Q` | |
| Send selected units (they fight on the way) | Right-click | Tap the map |
| Recruit Thug / Enforcer / Hitman | `1` / `2` / `3` | Buttons |
| Retreat selected units to your compound | `R` | |
| Block details, front business, rally point | Click a block, `U` to upgrade | Tap a block |
| Pause / speed | `Space` / speed button | Buttons |

Three difficulty levels change the rivals' income, how quickly they react, and how soon they dare to raid your compound.

### Code

- `index.html`: page structure and HUD
- `style.css`: styles
- `game.js`: the whole game (map generation, units, combat, capture, AI, rendering, input)

`window.__turfwar` exposes the game state and a `simulate(seconds)` helper for testing from the browser console.
