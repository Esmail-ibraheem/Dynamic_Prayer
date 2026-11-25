// Entry point: read config from the environment and start the HTTP server.
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { loadCities, datasetInfo } from './geo.js';
import { createApp } from './app.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;

const publicBaseUrl = env.PUBLIC_BASE_URL ? env.PUBLIC_BASE_URL.replace(/\/+$/, '') : '';
const config = {
  port: Number(env.PORT) || 8787,
  host: env.HOST || '127.0.0.1',
  publicBaseUrl,
  trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
  dbPath: path.resolve(root, env.DB_PATH || 'data/waqt.db'),
  citiesPath: path.resolve(root, env.CITIES_PATH || 'data/cities.json'),
  publicDir: path.join(root, 'public'),
  uidDomain: publicBaseUrl ? new URL(publicBaseUrl).hostname : 'waqt.blocks',
  log: env.LOG !== '0',
};

const db = openDb(config.dbPath);
if (!loadCities(config.citiesPath)) {
  console.warn(`City index not found at ${config.citiesPath} — run "npm run data:cities". Coordinates still work.`);
}
const server = createServer(createApp({ db, config }));
server.keepAliveTimeout = 5_000;
server.requestTimeout = 15_000;
server.listen(config.port, config.host, () => {
  const shown = config.host === '0.0.0.0' ? 'localhost' : config.host;
  console.log(`Waqt Blocks listening on http://${shown}:${config.port}  (${datasetInfo().places} places, db ${path.relative(root, config.dbPath)})`);
  if (!publicBaseUrl) console.log('Tip: set PUBLIC_BASE_URL to the public https:// address so Google/Outlook can reach the feed.');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
