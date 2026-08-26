// bart-fart — live BART train tracker.
//
// BART does not publish real-time train GPS positions. What it does publish is
// a real-time arrival countdown (ETD) for every station, plus static route and
// schedule data. This server reconstructs every train's position by projecting
// each ETD sighting backwards along its route using scheduled inter-station
// travel times, then clustering the sightings that refer to the same train.

const http = require('http');
const fs = require('fs');
const path = require('path');

const API_KEY = process.env.BART_API_KEY || 'MW9S-E7SL-26DU-VV8V'; // BART's public demo key
const PORT = process.env.PORT || 8642;
const ETD_REFRESH_MS = 15_000;

const api = (endpoint, params) =>
  `https://api.bart.gov/api/${endpoint}.aspx?` +
  new URLSearchParams({ ...params, key: API_KEY, json: 'y' });

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`BART API ${res.status} for ${url}`);
  return res.json();
}

const asArray = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);

// ---------------------------------------------------------------------------
// Static network data, loaded once at startup.
// ---------------------------------------------------------------------------

const network = {
  stations: {},   // abbr -> { abbr, name, lat, lon }
  routes: [],     // { number, name, color, hexcolor, direction, stations[], cumMin[] }
};

function haversineKm(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(s));
}

function parseSchedTime(str) {
  // "4:51 AM" -> minutes since midnight
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(str.trim());
  if (!m) return null;
  let h = Number(m[1]) % 12;
  if (/pm/i.test(m[3])) h += 12;
  return h * 60 + Number(m[2]);
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};

async function loadNetwork() {
  const stnData = await getJSON(api('stn', { cmd: 'stns' }));
  for (const s of asArray(stnData.root.stations.station)) {
    network.stations[s.abbr] = {
      abbr: s.abbr,
      name: s.name,
      lat: Number(s.gtfs_latitude),
      lon: Number(s.gtfs_longitude),
    };
  }

  const routeData = await getJSON(api('route', { cmd: 'routes' }));
  const routeList = asArray(routeData.root.routes.route);

  for (const r of routeList) {
    const [info, sched] = await Promise.all([
      getJSON(api('route', { cmd: 'routeinfo', route: r.number })),
      getJSON(api('sched', { cmd: 'routesched', route: r.number })).catch(() => null),
    ]);
    const stations = asArray(info.root.routes.route.config.station);

    // Derive travel time for each consecutive station pair from the timetable:
    // median of the deltas across every scheduled train that serves the pair.
    const segTimes = new Map(); // "A>B" -> [minutes]
    for (const train of asArray(sched?.root?.route?.train)) {
      const stops = asArray(train.stop)
        .map((st) => ({ abbr: st['@station'], t: parseSchedTime(st['@origTime']) }))
        .filter((st) => st.t != null);
      for (let i = 1; i < stops.length; i++) {
        let dt = stops[i].t - stops[i - 1].t;
        if (dt < 0) dt += 24 * 60; // past-midnight wrap
        if (dt > 0 && dt <= 60) {
          const key = `${stops[i - 1].abbr}>${stops[i].abbr}`;
          if (!segTimes.has(key)) segTimes.set(key, []);
          segTimes.get(key).push(dt);
        }
      }
    }

    // Cumulative minutes from the route's origin to each station.
    const cumMin = [0];
    for (let i = 1; i < stations.length; i++) {
      const a = network.stations[stations[i - 1]];
      const b = network.stations[stations[i]];
      let dt = median(segTimes.get(`${stations[i - 1]}>${stations[i]}`) || []);
      if (dt == null) dt = (a && b ? haversineKm(a, b) / (50 / 60) : 3) + 0.7; // fallback: ~50 km/h + dwell
      cumMin.push(cumMin[cumMin.length - 1] + dt);
    }

    network.routes.push({
      number: r.number,
      name: r.name,
      color: r.color,
      hexcolor: r.hexcolor,
      direction: r.direction,
      stations,
      cumMin,
    });
  }
}

// ---------------------------------------------------------------------------
// Real-time train position estimation.
// ---------------------------------------------------------------------------

let latest = { updated: null, trains: [], error: null };

function estimateTrains(etdRoot) {
  // 1. Collect sightings: each ETD entry says "a COLOR train heading DIRECTION
  //    toward DEST reaches station S in M minutes". Projected onto the route's
  //    timeline, that train currently sits at cumMin(S) - M.
  const sightings = new Map(); // route number -> [{pos, minutes, dest, destName, length, delay}]
  for (const stn of asArray(etdRoot.station)) {
    for (const etd of asArray(stn.etd)) {
      for (const est of asArray(etd.estimate)) {
        const minutes = est.minutes === 'Leaving' ? 0 : Number(est.minutes);
        if (!Number.isFinite(minutes) || est.cancelflag === '1') continue;
        for (const route of network.routes) {
          if (route.color !== est.color || route.direction !== est.direction) continue;
          const si = route.stations.indexOf(stn.abbr);
          const di = route.stations.indexOf(etd.abbreviation);
          if (si < 0 || di < si) continue; // station not on route, or already past this destination
          const pos = route.cumMin[si] - minutes;
          if (pos < -1) continue; // hasn't entered this route yet
          if (!sightings.has(route.number)) sightings.set(route.number, []);
          sightings.get(route.number).push({
            pos: Math.max(0, pos),
            minutes,
            dest: etd.abbreviation,
            destName: etd.destination,
            length: Number(est.length) || null,
            delay: Number(est.delay) || 0,
          });
        }
      }
    }
  }

  // 2. Cluster sightings per route: multiple stations report the same train, so
  //    sightings within ~2 timeline-minutes of each other are one train.
  const trains = [];
  for (const route of network.routes) {
    const list = (sightings.get(route.number) || []).sort((a, b) => a.pos - b.pos);
    let cluster = [];
    const flush = () => {
      if (!cluster.length) return;
      // Trust the sighting closest to arrival (smallest countdown) the most.
      const best = cluster.reduce((a, b) => (b.minutes < a.minutes ? b : a));
      const pos = best.pos;

      // Map timeline position back to a point between two stations.
      let i = route.cumMin.findIndex((c, idx) => idx + 1 < route.cumMin.length && pos <= route.cumMin[idx + 1]);
      if (i < 0) i = route.stations.length - 2;
      const a = network.stations[route.stations[i]];
      const b = network.stations[route.stations[i + 1]];
      const span = route.cumMin[i + 1] - route.cumMin[i] || 1;
      const frac = Math.min(1, Math.max(0, (pos - route.cumMin[i]) / span));

      trains.push({
        id: `${route.number}-${trains.length}`,
        color: route.color,
        hexcolor: route.hexcolor,
        direction: route.direction,
        route: route.name,
        destination: best.destName,
        cars: best.length,
        delayMin: Math.round(best.delay / 60),
        lat: a.lat + (b.lat - a.lat) * frac,
        lon: a.lon + (b.lon - a.lon) * frac,
        prevStation: a.name,
        nextStation: b.name,
        minutesToNext: Math.round((route.cumMin[i + 1] - pos) * 10) / 10,
        atStation: frac < 0.02 ? a.name : frac > 0.98 ? b.name : null,
        sightings: cluster.length,
      });
      cluster = [];
    };
    for (const s of list) {
      if (cluster.length && s.pos - cluster[cluster.length - 1].pos > 2) flush();
      cluster.push(s);
    }
    flush();
  }
  return trains;
}

async function refreshTrains() {
  try {
    const data = await getJSON(api('etd', { cmd: 'etd', orig: 'ALL' }));
    latest = {
      updated: new Date().toISOString(),
      bartTime: `${data.root.date} ${data.root.time}`,
      trains: estimateTrains(data.root),
      error: null,
    };
  } catch (err) {
    latest = { ...latest, error: String(err) };
    console.error('ETD refresh failed:', err.message);
  }
}

// ---------------------------------------------------------------------------
// HTTP server.
// ---------------------------------------------------------------------------

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
  const fsPath = path.join(__dirname, 'public', path.normalize(file));
  if (!fsPath.startsWith(path.join(__dirname, 'public'))) return send(404, '{"error":"not found"}');
  fs.readFile(fsPath, (err, data) => {
    if (err) return send(404, '{"error":"not found"}');
    send(200, data, MIME[path.extname(fsPath)] || 'application/octet-stream');
  });
});

(async () => {
  console.log('Loading BART network (stations, routes, timetables)...');
  await loadNetwork();
  console.log(`Loaded ${Object.keys(network.stations).length} stations, ${network.routes.length} routes.`);
  await refreshTrains();
  setInterval(refreshTrains, ETD_REFRESH_MS);
  server.listen(PORT, () => console.log(`bart-fart running at http://localhost:${PORT}`));
})();
