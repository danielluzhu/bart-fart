# bart-fart 🚆💨

A live map of every BART train in the system.

**Live site: https://danielluzhu.github.io/bart-fart/**

Three interfaces, switchable from the header (your choice is remembered):

- **NEON** — dark mission-control map with glowing trains
- **DAY** — the same map on a light basemap
- **DEPARTURES** — a vintage split-flap station board (pick any station,
  watch the flaps clatter as ETAs change)

## Run it

The site is fully static (the browser talks to the BART API directly, which
allows cross-origin requests) — GitHub Pages hosts it straight from `docs/`.

To run locally, either open `docs/index.html` via any static file server, or:

```
npm start
```

which serves the site at http://localhost:8642 and additionally exposes the
train estimates as a JSON API. No dependencies — just Node 18+.

## How it works

BART doesn't publish real-time train GPS positions, so this tool reconstructs
them from what BART *does* publish:

1. **At startup** it loads the station list (with coordinates), every route's
   ordered station sequence, and the route timetables — from which it derives
   the typical travel time between each pair of adjacent stations (median
   across all scheduled trains).
2. **Every 15 seconds** it fetches real-time estimated departures (ETD) for
   all stations. Each ETD entry means "a GREEN train heading South toward
   Daly City reaches Lake Merritt in 4 minutes."
3. Each sighting is projected backwards along the route's timeline: if the
   train is 4 minutes from a station that sits 21 minutes into the route, the
   train is at minute 17 of the route.
4. The same train is sighted from several stations ahead of it, so sightings
   on a route are clustered (within a 2-minute window) into individual trains,
   trusting the closest station's countdown the most.
5. Each train's timeline position is interpolated back into a lat/lon between
   the two stations it's currently between and rendered on a Leaflet map.

Accuracy is roughly ±1 minute of travel time — good enough to watch the whole
system breathe.

The estimation logic lives in [`docs/core.js`](docs/core.js), shared between
the browser and the Node server.

## API (local server only)

- `GET /api/trains` — current estimated position of every train:
  line color, destination, direction, car count, delay, coordinates,
  previous/next station and minutes to the next stop.
- `GET /api/network` — stations (with coordinates) and routes.

Data: [BART Legacy API](https://api.bart.gov/docs/overview/index.aspx). Set
`BART_API_KEY` to use your own key (defaults to BART's public demo key).
