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
/* Colors follow the official "Smoke Category Days Defined" table used by the
   LA Office of State Climatology and the American Sugar Cane League:
     Category 1 red, Categories 2 and 5 yellow, Categories 3 and 4 green.
   Red and green are hard to tell apart for about 8% of men, so color is
   never the only signal: every rating also carries an icon and a word, and
   red parishes are drawn with diagonal stripes on the map (see PATTERNS). */
const LEVEL_ICON  = { no: "\u2715", caution: "\u26A0", burn: "\u2713", nodata: "?" };
const LEVEL_COLOR = { no: "#E8112D", caution: "#FFE800", burn: "#00A14B", nodata: "#C9C4BA" };
/* An unrecognized level (e.g. forecast data written by an older version of
   the pipeline) is shown as "no rating" gray rather than a wrong color. */
const levelOf = (v) => (v && LEVEL_COLOR[v.level] ? v.level : "nodata");

/* Neighbor labels drawn on the map. Gulf wording follows NWS usage and
   Louisiana Executive Order JML 25-027; change the text here if needed. */
const GULF_NAME = "Gulf of America";
const MAP_LABELS = [
  { text: "TEXAS", lat: 31.0, lng: -94.35 },
  { text: "ARKANSAS", lat: 33.22, lng: -92.85 },
  { text: "MISSISSIPPI", lat: 32.4, lng: -90.0 },
  { text: GULF_NAME, lat: 28.7, lng: -91.2 },
];

let DATA = null, GEO = null, STATES = null, MAP = null, LAYER = null;
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
    [GEO, DATA, STATES] = await Promise.all([
      loadJSON("parishes.geojson"), loadJSON("data/latest.json"),
      loadJSON("states.geojson").catch(() => null),   /* backdrop only; optional */
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

/* The four NWS offices issue twice a day, at DIFFERENT times: a morning
   product (roughly 1-4 a.m.) covering Today / Tonight / Tomorrow, and an
   afternoon product (roughly 1-4 p.m.) that REPLACES it and begins at
   Tonight. So for part of the day some offices still offer "Today" while
   others have already moved past it. Taking the plain union of every
   office's periods therefore produces tabs that most parishes cannot fill.
   Two filters keep the tab row to periods that are actually usable. */

/* A daytime period stops being useful once the burn window closes. The
   official guidance is "fires should be burned out by 4 p.m.", so 4 p.m.
   local is the cutoff. A night period ends at daybreak the next morning. */
const DAY_ENDS_HOUR = 16;    /* 4 p.m. */
const NIGHT_ENDS_HOUR = 6;   /* 6 a.m. the following day */
/* A period offered by only a minority of parishes is one office's leading
   or trailing edge. Showing it means most parishes have nothing to show. */
const MIN_COVERAGE = 0.5;

function periodIsOver(per, now) {
  const [y, m, d] = per.date.split("-").map(Number);
  const end = new Date(y, m - 1, d);
  if (per.is_night) end.setDate(end.getDate() + 1);
  end.setHours(per.is_night ? NIGHT_ENDS_HOUR : DAY_ENDS_HOUR, 0, 0, 0);
  return now >= end;
}

function buildPeriods() {
  const entries = Object.values(DATA.parishes || {});
  const seen = new Map();
  const count = new Map();
  for (const e of entries) {
    for (const p of e.periods || []) {
      if (!p.key) continue;
      if (!seen.has(p.key)) seen.set(p.key, { key: p.key, date: p.date, is_night: !!p.is_night });
      count.set(p.key, (count.get(p.key) || 0) + 1);
    }
  }
  const all = [...seen.values()].sort((a, b) => a.key.localeCompare(b.key));

  const now = new Date();
  const current = all.filter((per) => !periodIsOver(per, now));
  const withParishes = entries.filter((e) => (e.periods || []).length).length || 1;
  const wellCovered = current.filter((per) => (count.get(per.key) || 0) / withParishes >= MIN_COVERAGE);

  /* Fall back rather than ever showing an empty app. */
  PERIODS = wellCovered.length ? wellCovered : (current.length ? current : all);

  /* Land on the next period a producer can actually burn in: the first
     DAYTIME period that carries a rating. In the late afternoon that is
     tomorrow, which is what someone planning a burn needs to see. */
  const hasRating = (per) => entries.some((e) => ratingFor(e, per.key));
  const firstDay = PERIODS.find((per) => !per.is_night && hasRating(per));
  mapKey = (firstDay || PERIODS.find(hasRating) || PERIODS[0] || {}).key;
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
  MAP = L.map("map", { zoomSnap: 0.25, attributionControl: false, tap: true })
    .setView([31.25, -91.9], 6.3);

  /* Neighboring states as a quiet backdrop (from the Census TIGER file). */
  if (STATES) {
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

  for (const l of MAP_LABELS) {
    L.marker([l.lat, l.lng], {
      interactive: false,
      icon: L.divIcon({ className: "region-label", html: l.text, iconSize: [140, 20], iconAnchor: [70, 10] }),
    }).addTo(MAP);
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
    applyStripes();
    if (selectedParish) { selectedKey = mapKey; renderDetail(); }
  });

  const updateLabels = () => {
    const show = MAP.getZoom() >= 7.5;
    LAYER.eachLayer((l) => {
      const t = l.getTooltip();
      if (!t || t.options.permanent === show) return;
      l.unbindTooltip();
      l.bindTooltip(l.feature.properties.name, { permanent: show, direction: "center", className: "parish-label" });
    });
  };
  MAP.on("zoomend", updateLabels);
  updateLabels();
  applyStripes();
}

/* Diagonal stripes over "no burning" parishes. Leaflet draws each parish as
   an SVG <path>, so we define a pattern once and point the path's fill at it.
   This makes red parishes distinguishable from green ones without relying on
   color, including in grayscale or bright sun. */
function ensurePattern() {
  const svg = MAP.getPanes().overlayPane.querySelector("svg");
  if (!svg || svg.querySelector("#stripeNo")) return;
  const NS = "http://www.w3.org/2000/svg";
  const defs = document.createElementNS(NS, "defs");
  const pat = document.createElementNS(NS, "pattern");
  pat.setAttribute("id", "stripeNo");
  pat.setAttribute("patternUnits", "userSpaceOnUse");
  pat.setAttribute("width", "8");
  pat.setAttribute("height", "8");
  pat.setAttribute("patternTransform", "rotate(45)");
  const bg = document.createElementNS(NS, "rect");
  bg.setAttribute("width", "8"); bg.setAttribute("height", "8");
  bg.setAttribute("fill", LEVEL_COLOR.no);
  const line = document.createElementNS(NS, "rect");
  line.setAttribute("width", "3"); line.setAttribute("height", "8");
  line.setAttribute("fill", "#7A0012");
  pat.appendChild(bg); pat.appendChild(line);
  defs.appendChild(pat); svg.insertBefore(defs, svg.firstChild);
}

function applyStripes() {
  ensurePattern();
  LAYER.eachLayer((l) => {
    if (!l._path) return;
    const level = levelOf(ratingFor(DATA.parishes[l.feature.properties.name], mapKey));
    if (level === "no") l._path.setAttribute("fill", "url(#stripeNo)");
    else l._path.setAttribute("fill", LEVEL_COLOR[level]);
  });
}

function styleFor(name) {
  const level = levelOf(ratingFor(DATA.parishes[name], mapKey));
  return {
    fillColor: LEVEL_COLOR[level],
    fillOpacity: level === "nodata" ? 0.6 : 0.9,
    /* Dark heavy outline for the selected parish: white vanishes on yellow. */
    color: "#1A1A1A",
    weight: name === selectedParish ? 4.5 : 1.2,
  };
}

/* ---------------- detail panel ---------------- */

function selectParish(name, panMap) {
  selectedParish = name;
  selectedKey = mapKey;
  LAYER.setStyle((f) => styleFor(f.properties.name));
  applyStripes();
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
  /* Long instructions like "BURN AFTER INVERSION LIFTS" need a smaller size
     so they stay to two lines on a phone. */
  $("verdictCard").className = "verdict " + level + (word.length > 16 ? " long" : "");
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
    /* This office's current product does not contain the selected period.
       Explain which way, in plain terms, instead of a bare "period passed". */
    const keys = (entry.periods || []).map((x) => x.key).filter(Boolean).sort();
    const label = per ? periodLabel(per).toLowerCase() : "this period";
    if (keys.length && selectedKey < keys[0]) {
      const nextPer = PERIODS.find((x) => x.key === keys[0]);
      const nextLabel = nextPer ? periodLabel(nextPer).toLowerCase() : "its next period";
      setCard("nodata", "\u24D8", "FORECAST HAS MOVED ON",
        `NWS ${entry.office} has replaced its forecast for ${label} with a newer one that begins with ${nextLabel}. ` +
        `Fires should be burned out by 4 p.m.`);
    } else {
      setCard("nodata", "\u24D8", "NOT ISSUED YET",
        `NWS ${entry.office} has not issued a forecast for ${label} yet. New forecasts come out in the early morning ` +
        `and again in the early afternoon.`);
    }
    return;
  }

  if (p.verdict) {
    const lvl = levelOf(p.verdict);
    setCard(lvl, LEVEL_ICON[lvl], p.verdict.verdict, p.verdict.detail);
  } else {
    setCard("nodata", "?", "NO RATING",
      `NWS ${entry.office} did not include a Category Day for this period. Check weather.gov before burning.`);
  }

  /* Key numbers. SILT (Surface Inversion Lifted Temperature) is the surface
     temperature that must be reached to break the inversion, so it is what a
     farmer watches on Category 2 and 3 days. It sits beside the Category Day
     for that reason. */
  const facts = [
    ["Category Day", p.category != null ? `${p.category} of 5` : "\u2014"],
    ["Inversion lifts at", p.silt_f != null ? `${p.silt_f} \u00B0F` : "\u2014"],
    ["Surface wind (PM)", windText(p.surface_wind_pm || p.surface_wind_am)],
    ["Transport wind", windText(p.transport_wind)],
  ];
  $("keyFacts").innerHTML = facts
    .map(([k, v]) => `<div class="fact"><div class="v">${v}</div><div class="k">${k}</div></div>`).join("");

  const rows = [
    ["Inversion lifts at (SILT / 500 m mixing temp)", p.silt_f != null ? p.silt_f + " \u00B0F" : "\u2014"],
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
