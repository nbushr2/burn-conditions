/* Louisiana Burn Conditions: front-end logic.
   Rules mirrored from the backend:
   - The app never computes a rating. It only displays what the pipeline
     produced from NWS data.
   - Stale or missing data is shown loudly, never hidden.
   - Forecast periods are identified by calendar date + day/night ("key"),
     never by column position, because the four NWS offices issue at
     different times with different column layouts. */

"use strict";

const STALE_HOURS = 12;
const LEVEL_ICON = { good: "\u2713", fair: "\u26A0", poor: "\u26A0", no: "\u2715", nodata: "?" };
const LEVEL_COLOR = { good: "#009E73", fair: "#E69F00", poor: "#D55E00", no: "#1A1A1A", nodata: "#C9C4BA" };

/* ---------------- map settings ----------------
   BASEMAP: "usgs" (default: USGS The National Map, public domain, no key,
   roads/towns/rivers), "osm" (OpenStreetMap), or "none" (plain water-blue
   background; fully offline). When a basemap is on, the state backdrop and
   hand-placed labels below are unnecessary and are switched off. */
/*   "minimal" (default): no tiles; interstates, US highways and the ten
     largest cities drawn from public-domain Natural Earth data. Quiet,
     offline-capable, no outside server. "usgs" and "osm" fetch full
     street/topo tiles from those services. "none" is parishes only. */
const BASEMAP = "minimal";
const SHOW_STATE_BACKDROP = BASEMAP === "none" || BASEMAP === "minimal";
const SHOW_REGION_LABELS = BASEMAP === "none" || BASEMAP === "minimal";
const SHOW_REFERENCE = BASEMAP === "minimal";
/* How much reference detail to draw in "minimal" mode:
   ROADS: "interstates" or "none".  CITIES_ALWAYS: how many of the largest
   cities show at state zoom (the rest appear when zoomed in).
   PARISH_LABEL_ZOOM: zoom level at which parish names appear. */
const ROADS = "interstates";
const CITIES_ALWAYS = 4;
const PARISH_LABEL_ZOOM = 8;
const BASEMAPS = {
  usgs: {
    url: "https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}",
    attribution: "USGS The National Map",
    maxZoom: 16,
  },
  osm: {
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: "&copy; OpenStreetMap contributors",
    maxZoom: 18,
  },
};

/* Gulf wording follows NWS usage and Louisiana Executive Order JML 25-027. */
const GULF_NAME = "Gulf of America";
const MAP_LABELS = [
  { text: "TEXAS", lat: 31.0, lng: -94.35 },
  { text: "ARKANSAS", lat: 33.22, lng: -92.85 },
  { text: "MISSISSIPPI", lat: 32.4, lng: -90.0 },
  { text: GULF_NAME, lat: 28.7, lng: -91.2 },
];

let DATA = null, GEO = null, STATES = null, REF = null, MAP = null, LAYER = null;
let PERIODS = [];            /* [{key, date, is_night}] union across all parishes, sorted */
let selectedParish = null, selectedKey = null, mapKey = null;

const $ = (id) => document.getElementById(id);

/* ---------------- data loading ---------------- */

async function loadJSON(url) {
  const r = await fetch(url + (url.includes("latest") ? `?t=${Date.now()}` : ""));
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

async function init() {
  try {
    [GEO, DATA, STATES, REF] = await Promise.all([
      loadJSON("parishes.geojson"), loadJSON("data/latest.json"),
      loadJSON("states.geojson").catch(() => null),   /* backdrop only; optional */
      loadJSON("reference.geojson").catch(() => null), /* roads + cities; optional */
    ]);
  } catch (e) {
    if (!DATA) {
      showBanner("Could not load forecast data. Check your connection and pull to refresh.", true);
      return;
    }
  }
  buildPeriods();
  renderChrome();
  buildDropdown();
  buildMap();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");
}

/* ---------------- periods ---------------- */

function buildPeriods() {
  const seen = new Map();
  for (const e of Object.values(DATA.parishes || {})) {
    for (const p of e.periods || []) {
      if (p.key && !seen.has(p.key)) seen.set(p.key, { key: p.key, date: p.date, is_night: !!p.is_night });
    }
  }
  PERIODS = [...seen.values()].sort((a, b) => a.key.localeCompare(b.key));
  /* Drop periods more than a day in the past: they can only come from an
     office whose feed is stale, and the stale banner covers that case. */
  const cutoff = localISODate(new Date(Date.now() - 36 * 3.6e6));
  const fresh = PERIODS.filter((p) => p.date >= cutoff);
  if (fresh.length) PERIODS = fresh;
  /* Default: first period that has a rating anywhere. */
  mapKey = (PERIODS.find((p) => Object.values(DATA.parishes).some((e) => ratingFor(e, p.key))) || PERIODS[0] || {}).key;
}

function localISODate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/* One label function, used by BOTH the map dropdown and the tabs. */
function periodLabel(p) {
  const today = localISODate(new Date());
  const tomorrow = localISODate(new Date(Date.now() + 24 * 3.6e6));
  if (p.date === today) return p.is_night ? "Tonight" : "Today";
  if (p.date === tomorrow) return p.is_night ? "Tomorrow night" : "Tomorrow";
  const [y, m, d] = p.date.split("-").map(Number);
  const wd = new Date(y, m - 1, d).toLocaleDateString([], { weekday: "short" });
  return p.is_night ? `${wd} night` : `${wd} ${m}/${d}`;
}

function periodOf(entry, key) {
  return entry && entry.periods ? entry.periods.find((p) => p.key === key) : null;
}
function ratingFor(entry, key) {
  const p = periodOf(entry, key);
  return p && p.verdict ? p.verdict : null;
}

/* ---------------- chrome ---------------- */

function renderChrome() {
  const gen = new Date(DATA.generated_at_utc);
  const ageH = (Date.now() - gen.getTime()) / 3.6e6;
  $("issued").textContent = `Updated ${gen.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
  $("disclaimer").textContent = DATA.disclaimer;

  if (!navigator.onLine) {
    showBanner(`OFFLINE. Showing data saved ${gen.toLocaleString()}. Conditions may have changed.`, true);
  } else if (ageH > STALE_HOURS) {
    showBanner(`WARNING: This forecast is ${Math.round(ageH)} hours old. Do not rely on it. Check weather.gov before burning.`, true);
  } else {
    const officeFailures = Object.entries(DATA.offices || {}).filter(([, o]) => !o.ok);
    if (officeFailures.length) {
      showBanner(`Data problem at NWS office(s): ${officeFailures.map(([k]) => k).join(", ")}. Affected parishes show older data or no data.`, false);
    }
  }
}

function showBanner(msg, severe) {
  const b = $("banner");
  b.textContent = msg;
  b.classList.remove("hidden");
  b.classList.toggle("severe", !!severe);
}

/* ---------------- parish finder ---------------- */

function buildDropdown() {
  const sel = $("parishSelect");
  GEO.features.map((f) => f.properties.name).sort().forEach((name) => {
    const o = document.createElement("option");
    o.value = name;
    o.textContent = name + " Parish";
    sel.appendChild(o);
  });
  sel.addEventListener("change", () => sel.value && selectParish(sel.value, true));

  $("locateBtn").addEventListener("click", () => {
    if (!navigator.geolocation) return showBanner("Location is not available on this device.", false);
    $("locateBtn").textContent = "Locating\u2026";
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        $("locateBtn").textContent = "Use my location";
        const parish = parishAtPoint(pos.coords.longitude, pos.coords.latitude);
        if (parish) selectParish(parish, true);
        else showBanner("Your location is outside Louisiana parish boundaries.", false);
      },
      () => {
        $("locateBtn").textContent = "Use my location";
        showBanner("Could not get your location. Pick your parish from the list.", false);
      },
      { enableHighAccuracy: false, timeout: 10000 }
    );
  });
}

function parishAtPoint(lng, lat) {
  const inRing = (ring) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  for (const f of GEO.features) {
    const g = f.geometry;
    const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
    for (const poly of polys) {
      if (inRing(poly[0]) && !poly.slice(1).some(inRing)) return f.properties.name;
    }
  }
  return null;
}

/* ---------------- map ---------------- */

function buildMap() {
  MAP = L.map("map", { zoomSnap: 0.25, attributionControl: true, tap: true })
    .setView([31.25, -91.9], 6.3);
  MAP.attributionControl.setPrefix(false);

  if (BASEMAPS[BASEMAP]) {
    const b = BASEMAPS[BASEMAP];
    L.tileLayer(b.url, { attribution: b.attribution, maxZoom: b.maxZoom, crossOrigin: true }).addTo(MAP);
  }

  /* Neighboring states as a quiet backdrop (from the Census TIGER file). */
  if (SHOW_STATE_BACKDROP && STATES) {
    L.geoJSON(STATES, {
      interactive: false,
      style: { fillColor: "#EEECE7", fillOpacity: 1, color: "#B7B1A7", weight: 1 },
    }).addTo(MAP);
  }

  LAYER = L.geoJSON(GEO, {
    style: (f) => styleFor(f.properties.name),
    onEachFeature: (f, layer) => {
      layer.on("click", () => selectParish(f.properties.name, false));
      layer.bindTooltip(f.properties.name, { permanent: false, direction: "center", className: "parish-label" });
    },
  }).addTo(MAP);

  for (const l of SHOW_REGION_LABELS ? MAP_LABELS : []) {
    L.marker([l.lat, l.lng], {
      interactive: false,
      icon: L.divIcon({ className: "region-label", html: l.text, iconSize: [140, 20], iconAnchor: [70, 10] }),
    }).addTo(MAP);
  }

  if (SHOW_REFERENCE && REF) {
    if (ROADS !== "none") {
      L.geoJSON(REF, {
        interactive: false,
        filter: (f) => f.geometry.type !== "Point" && f.properties.cls === "interstate",
        style: { color: "#FFFFFF", weight: 1.5, opacity: 0.55 },
      }).addTo(MAP);
    }
    const ranked = REF.features.filter((f) => f.geometry.type === "Point")
      .sort((a, b) => (b.properties.pop || 0) - (a.properties.pop || 0));
    const alwaysShow = new Set(ranked.slice(0, CITIES_ALWAYS).map((f) => f.properties.name));
    const cities = L.layerGroup().addTo(MAP);
    const drawCities = () => {
      cities.clearLayers();
      const z = MAP.getZoom();
      for (const f of ranked) {
        if (!alwaysShow.has(f.properties.name) && z < PARISH_LABEL_ZOOM) continue;
        const [lng, lat] = f.geometry.coordinates;
        L.circleMarker([lat, lng], { radius: 3.5, color: "#1A1A1A", weight: 1.5, fillColor: "#FFFFFF", fillOpacity: 1, interactive: false }).addTo(cities);
        L.marker([lat, lng], { interactive: false,
          icon: L.divIcon({ className: "city-label", html: f.properties.name, iconSize: [90, 14], iconAnchor: [-6, 7] }) }).addTo(cities);
      }
    };
    MAP.on("zoomend", drawCities);
    drawCities();
  }

  const ctl = L.control({ position: "topright" });
  ctl.onAdd = () => {
    const div = L.DomUtil.create("div", "map-period");
    div.innerHTML = `<span>Map shows</span><select id="mapPeriod" aria-label="Forecast period shown on map">` +
      PERIODS.map((p) => `<option value="${p.key}" ${p.key === mapKey ? "selected" : ""}>${periodLabel(p)}</option>`).join("") +
      `</select>`;
    L.DomEvent.disableClickPropagation(div);
    return div;
  };
  ctl.addTo(MAP);
  $("mapPeriod").addEventListener("change", (e) => {
    mapKey = e.target.value;
    LAYER.setStyle((f) => styleFor(f.properties.name));
    if (selectedParish) { selectedKey = mapKey; renderDetail(); }
  });

  const updateLabels = () => {
    const show = MAP.getZoom() >= PARISH_LABEL_ZOOM;
    LAYER.eachLayer((l) => {
      const t = l.getTooltip();
      if (!t || t.options.permanent === show) return;
      l.unbindTooltip();
      l.bindTooltip(l.feature.properties.name, { permanent: show, direction: "center", className: "parish-label" });
    });
  };
  MAP.on("zoomend", updateLabels);
  updateLabels();
}

function styleFor(name) {
  const v = ratingFor(DATA.parishes[name], mapKey);
  const level = v ? v.level : "nodata";
  return {
    fillColor: LEVEL_COLOR[level],
    fillOpacity: (BASEMAP === "none" || BASEMAP === "minimal") ? (level === "nodata" ? 0.6 : 0.9) : (level === "nodata" ? 0.35 : 0.6),
    color: name === selectedParish ? "#FFFFFF" : "#1A1A1A",
    weight: name === selectedParish ? 4 : 1.2,
  };
}

/* ---------------- detail panel ---------------- */

function selectParish(name, panMap) {
  selectedParish = name;
  selectedKey = mapKey;
  LAYER.setStyle((f) => styleFor(f.properties.name));
  LAYER.eachLayer((l) => { if (l.feature.properties.name === name) l.bringToFront(); });
  if (panMap) {
    LAYER.eachLayer((l) => {
      if (l.feature.properties.name === name) MAP.fitBounds(l.getBounds(), { maxZoom: 9 });
    });
  }
  $("parishSelect").value = name;
  renderDetail();
  $("detail").scrollIntoView({ behavior: "smooth", block: "start" });
}

function windText(w) {
  if (!w) return "\u2014";
  if (w.dir === "Lgt/Var") return "Light, variable";
  const range = w.lo_mph === w.hi_mph ? `${w.lo_mph}` : `${w.lo_mph}\u2013${w.hi_mph}`;
  const gust = w.gust_mph ? `, gusts ${w.gust_mph}` : "";
  return `${w.dir} ${range} mph${gust}`;
}

function setCard(level, icon, word, detail) {
  $("verdictCard").className = "verdict " + level;
  $("verdictIcon").textContent = icon;
  $("verdictWord").textContent = word;
  $("verdictDetail").textContent = detail;
}

function renderDetail() {
  const entry = DATA.parishes[selectedParish];
  $("detail").classList.remove("hidden");
  $("parishName").textContent = selectedParish + " Parish";

  /* Tabs = the same global period list as the map dropdown, same labels. */
  const tabs = $("periodTabs");
  tabs.innerHTML = "";
  PERIODS.forEach((p) => {
    const b = document.createElement("button");
    b.role = "tab";
    b.textContent = periodLabel(p);
    b.setAttribute("aria-selected", p.key === selectedKey);
    b.addEventListener("click", () => { selectedKey = p.key; renderDetail(); });
    tabs.appendChild(b);
  });

  const per = PERIODS.find((p) => p.key === selectedKey);
  const p = periodOf(entry, selectedKey);
  $("keyFacts").innerHTML = "";
  $("rawTable").innerHTML = "";
  $("sourceNote").textContent = "";

  if (!entry) {
    setCard("nodata", "?", "NO DATA",
      "No forecast matched this parish in the latest update. Check weather.gov or call your NWS office before burning.");
    return;
  }
  if (!p) {
    const firstKey = (entry.periods || []).map((x) => x.key).filter(Boolean).sort()[0] || "";
    const label = per ? periodLabel(per).toLowerCase() : "this period";
    if (selectedKey < firstKey) {
      setCard("nodata", "?", "PERIOD PASSED",
        `NWS ${entry.office}'s latest forecast starts after ${label}; that period is no longer covered.`);
    } else {
      setCard("nodata", "?", "NOT ISSUED YET",
        `NWS ${entry.office}'s current forecast does not reach ${label} yet. Offices issue new forecasts around 4 AM and 4 PM; check back then.`);
    }
    return;
  }

  if (p.verdict) {
    setCard(p.verdict.level, LEVEL_ICON[p.verdict.level], p.verdict.verdict, p.verdict.detail);
  } else if (p.is_night) {
    setCard("nodata", "?", "NO NIGHT RATING",
      `NWS ${entry.office} does not issue a Category Day for night periods. Do not burn without a rating.`);
  } else {
    setCard("nodata", "?", "NO RATING",
      `NWS ${entry.office} did not include a Category Day for this period. Check weather.gov before burning.`);
  }

  const facts = [
    ["Category Day", p.category != null ? `${p.category} of 5` : "\u2014"],
    ["Surface wind (PM)", windText(p.surface_wind_pm || p.surface_wind_am)],
    ["Transport wind", windText(p.transport_wind)],
  ];
  $("keyFacts").innerHTML = facts
    .map(([k, v]) => `<div class="fact"><div class="v">${v}</div><div class="k">${k}</div></div>`).join("");

  const rows = [
    ["Smoke rises to (mixing height)", p.mixing_height_ft != null ? p.mixing_height_ft.toLocaleString() + " ft" : "\u2014"],
    ["Humidity", p.rh_pct != null ? p.rh_pct + "%" : "\u2014"],
    ["Temperature", p.temp_f != null ? p.temp_f + " \u00B0F" : "\u2014"],
    ["Chance of rain", p.precip_chance_pct != null ? p.precip_chance_pct + "%" : "\u2014"],
    ["Morning surface wind", windText(p.surface_wind_am)],
    ["Afternoon surface wind", windText(p.surface_wind_pm)],
    ["NWS dispersion word", p.dispersion_text || "\u2014"],
  ];
  $("rawTable").innerHTML = "<table>" + rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join("") + "</table>";

  const issued = entry.issued ? new Date(entry.issued).toLocaleString() : "unknown time";
  $("sourceNote").textContent =
    `Source: NWS ${entry.office} Fire Weather Planning Forecast, issued ${issued}.` +
    (entry.stale ? " CAUTION: this office's latest update failed; data may be outdated." : "");
}

init();
