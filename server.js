'use strict';
const path = require('node:path');
const { openDb } = require('./src/db');
const { createApp } = require('./src/app');

const port = Number(process.env.PORT) || 3000;
const dbFile = process.env.DB_FILE || path.join(__dirname, 'data', 'mafia.db');
const db = openDb(dbFile);
const app = createApp(db, { secureCookies: process.env.SECURE_COOKIES === '1' });

app.listen(port, () => console.log(`Mafia Web running on http://localhost:${port} (database: ${dbFile})`));
