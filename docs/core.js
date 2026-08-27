// bart-fart core — network loading and train position estimation.
// Runs in both Node (server.js) and the browser (docs/index.html), so it takes
// a getJSON function instead of fetching directly.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BartCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const asArray = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);

  const makeApi = (key) => (endpoint, params) =>
    `https://api.bart.gov/api/${endpoint}.aspx?` +
    new URLSearchParams({ ...params, key, json: 'y' });

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

  // Compass bearing from a to b, degrees clockwise from north.
  function bearingDeg(a, b) {
    const rad = (d) => (d * Math.PI) / 180;
    const dLon = rad(b.lon - a.lon);
    const y = Math.sin(dLon) * Math.cos(rad(b.lat));
    const x =
      Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) -
      Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(dLon);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }

  // Load stations, routes, and timetable-derived inter-station travel times.
  async function loadNetwork(getJSON, apiKey) {
    const api = makeApi(apiKey);
    const network = { stations: {}, routes: [] };

    const [stnData, routeData] = await Promise.all([
      getJSON(api('stn', { cmd: 'stns' })),
      getJSON(api('route', { cmd: 'routes' })),
    ]);
    for (const s of asArray(stnData.root.stations.station)) {
      network.stations[s.abbr] = {
        abbr: s.abbr,
        name: s.name,
        lat: Number(s.gtfs_latitude),
        lon: Number(s.gtfs_longitude),
      };
    }

    const routeList = asArray(routeData.root.routes.route);
    const loaded = await Promise.all(routeList.map(async (r) => {
      const [info, sched] = await Promise.all([
        getJSON(api('route', { cmd: 'routeinfo', route: r.number })),
        getJSON(api('sched', { cmd: 'routesched', route: r.number })).catch(() => null),
      ]);
      const stations = asArray(info.root.routes.route.config.station);

      // Travel time for each consecutive station pair: median of the deltas
      // across every scheduled train that serves the pair.
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

      return {
        number: r.number,
        name: r.name,
        color: r.color,
        hexcolor: r.hexcolor,
        direction: r.direction,
        stations,
        cumMin,
      };
    }));
    network.routes = loaded;
    return network;
  }

  // Turn one ETD response into estimated train positions.
  function estimateTrains(network, etdRoot) {
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
          bearing: Math.round(bearingDeg(a, b)),
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

  return { makeApi, asArray, loadNetwork, estimateTrains };
});
