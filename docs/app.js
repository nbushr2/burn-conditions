/* Louisiana Burn Conditions: front-end logic.
   Rules mirrored from the backend:
   - The app never computes a rating. It only displays what the pipeline
     produced from NWS data. No math on the phone means no drift between
     what the farmer sees and what the pipeline validated.
   - Stale or missing data is shown loudly, never hidden. */

"use strict";

const STALE_HOURS = 12;
const LEVEL_ICON = { good: "\u2713", fair: "\u26A0", poor: "\u26A0", no: "\u2715", nodata: "?" };
const LEVEL_COLOR = { good: "#009E73", fair: "#E69F00", poor: "#D55E00", no: "#1A1A1A", nodata: "#B7B1A7" };

let DATA = null, GEO = null, MAP = null, LAYER = null;
let selectedParish = null, selectedPeriod = 0;
let MAP_PERIOD = 0; /* index of the period the map is colored by */

const $ = (id) => document.getElementById(id);

/* ---------------- data loading ---------------- */

async function loadJSON(url) {
  const r = await fetch(url + (url.includes("latest") ? `?t=${Date.now()}` : ""));
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

async function init() {
  try {
    [GEO, DATA] = await Promise.all([
      loadJSON("parishes.geojson"),
      loadJSON("data/latest.json"),
    ]);
  } catch (e) {
    if (!DATA) {
      showBanner("Could not load forecast data. Check your connection and pull to refresh.", true);
      return;
    }
  }
  MAP_PERIOD = firstRatedPeriodIndex();
  renderChrome();
  buildDropdown();
  buildMap();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");
}

/* NWS issues no Category Day for night periods. In the evening issuance the
   first column is "Tonight", so the map and default tab use the first period
   that actually carries a rating (usually tomorrow). */
function firstRatedPeriodIndex() {
  const entries = Object.values(DATA.parishes || {});
  const maxLen = Math.max(0, ...entries.map((e) => (e.periods || []).length));
  for (let i = 0; i < maxLen; i++) {
    if (entries.some((e) => e.periods && e.periods[i] && e.periods[i].verdict)) return i;
  }
  return 0;
}

function periodName(i) {
  const e = Object.values(DATA.parishes || {}).find((x) => x.periods && x.periods[i]);
  return e ? e.periods[i].name : "";
}

/* ---------------- chrome: issued time, staleness, warnings ---------------- */

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
      showBanner(`Data problem at NWS office(s): ${officeFailures.map(([k]) => k).join(", ")}. Affected parishes show older data.`, false);
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
  GEO.features
    .map((f) => f.properties.name)
    .sort()
    .forEach((name) => {
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

/* Ray-casting point-in-polygon over the parish GeoJSON. */
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

function parishLevel(name, periodIdx) {
  const e = DATA.parishes[name];
  const p = e && e.periods && e.periods[periodIdx];
  if (!p || !p.verdict) return "nodata";
  return p.verdict.level;
}

function buildMap() {
  MAP = L.map("map", { zoomSnap: 0.25, attributionControl: true, tap: true })
    .setView([31.0, -92.0], 6.4);
  L.tileLayer("https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png", {
    attribution: "&copy; OpenStreetMap, &copy; CARTO",
    maxZoom: 12,
  }).addTo(MAP);

  LAYER = L.geoJSON(GEO, {
    style: (f) => styleFor(f.properties.name),
    onEachFeature: (f, layer) => {
      layer.on("click", () => selectParish(f.properties.name, false));
      layer.bindTooltip(f.properties.name, { sticky: true });
    },
  }).addTo(MAP);

  /* Small label so nobody mistakes tomorrow's colors for today's. */
  const label = L.control({ position: "topright" });
  label.onAdd = () => {
    const div = L.DomUtil.create("div");
    div.style.cssText = "background:#FFF;border:2px solid #1A1A1A;border-radius:8px;padding:4px 8px;font-weight:700;font-size:0.85rem;";
    div.textContent = "Map shows: " + (periodName(MAP_PERIOD) || "\u2014");
    return div;
  };
  label.addTo(MAP);
}

function styleFor(name) {
  const level = parishLevel(name, MAP_PERIOD);
  return {
    fillColor: LEVEL_COLOR[level],
    fillOpacity: level === "nodata" ? 0.35 : 0.75,
    color: "#1A1A1A",
    weight: name === selectedParish ? 3 : 1,
  };
}

/* ---------------- detail panel ---------------- */

function selectParish(name, panMap) {
  selectedParish = name;
  selectedPeriod = MAP_PERIOD;
  LAYER.setStyle((f) => styleFor(f.properties.name));
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

function renderDetail() {
  const entry = DATA.parishes[selectedParish];
  $("detail").classList.remove("hidden");
  $("parishName").textContent = selectedParish + " Parish";

  const tabs = $("periodTabs");
  tabs.innerHTML = "";
  const periods = entry ? entry.periods : [];
  periods.forEach((p, i) => {
    const b = document.createElement("button");
    b.role = "tab";
    b.textContent = p.name;
    b.setAttribute("aria-selected", i === selectedPeriod);
    b.addEventListener("click", () => { selectedPeriod = i; renderDetail(); });
    tabs.appendChild(b);
  });

  const card = $("verdictCard");
  const p = periods[selectedPeriod];

  if (!entry || !p) {
    card.className = "verdict nodata";
    $("verdictIcon").textContent = "?";
    $("verdictWord").textContent = "NO DATA";
    $("verdictDetail").textContent =
      "No forecast matched this parish. Check weather.gov or call your NWS office before burning.";
    $("keyFacts").innerHTML = "";
    $("rawTable").innerHTML = "";
    $("sourceNote").textContent = "";
    return;
  }

  const level = p.verdict ? p.verdict.level : "nodata";
  card.className = "verdict " + level;
  $("verdictIcon").textContent = LEVEL_ICON[level];
  $("verdictWord").textContent = p.verdict ? p.verdict.verdict : "NO RATING";
  $("verdictDetail").textContent = p.verdict
    ? p.verdict.detail
    : "NWS does not issue a Category Day for night periods. Do not burn without a rating.";

  const facts = [];
  facts.push(["Category Day", p.category != null ? `${p.category} of 5` : "\u2014"]);
  facts.push(["Surface wind (PM)", windText(p.surface_wind_pm || p.surface_wind_am)]);
  facts.push(["Transport wind", windText(p.transport_wind)]);
  $("keyFacts").innerHTML = facts
    .map(([k, v]) => `<div class="fact"><div class="v">${v}</div><div class="k">${k}</div></div>`)
    .join("");

  const rows = [
    ["Smoke rises to (mixing height)", p.mixing_height_ft != null ? p.mixing_height_ft.toLocaleString() + " ft" : "\u2014"],
    ["Humidity", p.rh_pct != null ? p.rh_pct + "%" : "\u2014"],
    ["Temperature", p.temp_f != null ? p.temp_f + " \u00B0F" : "\u2014"],
    ["Chance of rain", p.precip_chance_pct != null ? p.precip_chance_pct + "%" : "\u2014"],
    ["Morning surface wind", windText(p.surface_wind_am)],
    ["Afternoon surface wind", windText(p.surface_wind_pm)],
  ];
  $("rawTable").innerHTML =
    "<table>" + rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join("") + "</table>";

  const issued = entry.issued ? new Date(entry.issued).toLocaleString() : "unknown time";
  $("sourceNote").textContent =
    `Source: NWS ${entry.office} Fire Weather Planning Forecast, issued ${issued}.` +
    (entry.stale ? " CAUTION: this office's latest update failed; data may be outdated." : "");
}

init();
