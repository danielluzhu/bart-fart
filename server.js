// bart-fart — optional local server.
//
// The site in docs/ is fully static (it talks to the BART API from the
// browser) and is what GitHub Pages hosts. This server exists for local dev
// and to expose the estimates as a JSON API. The estimation logic itself
// lives in docs/core.js, shared with the browser.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { makeApi, loadNetwork, estimateTrains } = require('./docs/core.js');

const API_KEY = process.env.BART_API_KEY || 'MW9S-E7SL-26DU-VV8V'; // BART's public demo key
const PORT = process.env.PORT || 8642;
const ETD_REFRESH_MS = 15_000;

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`BART API ${res.status} for ${url}`);
  return res.json();
}

const api = makeApi(API_KEY);
let network = null;
let latest = { updated: null, trains: [], error: null };

async function refreshTrains() {
  try {
    const data = await getJSON(api('etd', { cmd: 'etd', orig: 'ALL' }));
    latest = {
      updated: new Date().toISOString(),
      bartTime: `${data.root.date} ${data.root.time}`,
      trains: estimateTrains(network, data.root),
      error: null,
    };
  } catch (err) {
    latest = { ...latest, error: String(err) };
    console.error('ETD refresh failed:', err.message);
  }
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const send = (code, body, type = 'application/json') => {
    res.writeHead(code, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' });
    res.end(body);
  };

  if (url.pathname === '/api/trains') return send(200, JSON.stringify(latest));
  if (url.pathname === '/api/network') {
    return send(200, JSON.stringify({
      stations: Object.values(network.stations),
      routes: network.routes.map(({ number, name, color, hexcolor, direction, stations }) =>
        ({ number, name, color, hexcolor, direction, stations })),
    }));
  }

  const file = url.pathname === '/' ? '/index.html' : url.pathname;
  const fsPath = path.join(__dirname, 'docs', path.normalize(file));
  if (!fsPath.startsWith(path.join(__dirname, 'docs'))) return send(404, '{"error":"not found"}');
  fs.readFile(fsPath, (err, data) => {
    if (err) return send(404, '{"error":"not found"}');
    send(200, data, MIME[path.extname(fsPath)] || 'application/octet-stream');
  });
});

(async () => {
  console.log('Loading BART network (stations, routes, timetables)...');
  network = await loadNetwork(getJSON, API_KEY);
  console.log(`Loaded ${Object.keys(network.stations).length} stations, ${network.routes.length} routes.`);
  await refreshTrains();
  setInterval(refreshTrains, ETD_REFRESH_MS);
  server.listen(PORT, () => console.log(`bart-fart running at http://localhost:${PORT}`));
})();
