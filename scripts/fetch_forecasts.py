#!/usr/bin/env python3
"""
BurnWise pipeline: fetch NWS Fire Weather Planning Forecasts (FWF) for the
four offices covering Louisiana (LIX, SHV, JAN, LCH), parse the zone tables,
validate everything, and write one clean JSON file the mobile app reads.

Design rules (do not weaken these):
  1. NEVER guess. If a value cannot be parsed, it is null and flagged.
  2. NEVER silently serve stale data. Every parish carries its issuance time.
  3. If an office fails, keep that office's LAST GOOD data (age-flagged),
     and record a warning. The app shows the warning to the farmer.
  4. If a parish appears in more than one zone, use the WORST (lowest)
     Category Day per period. Conservative beats optimistic.

Run locally:   python3 scripts/fetch_forecasts.py
Debug a parse: python3 scripts/fetch_forecasts.py --debug
Offline test:  python3 scripts/fetch_forecasts.py --sample scripts/sample_fwf_lix.txt
"""

import argparse
import json
import re
import sys
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

import requests

# ---------------------------------------------------------------- constants

ROOT = Path(__file__).resolve().parent.parent
OUT_PATH = ROOT / "docs" / "data" / "latest.json"
GEOJSON_PATH = ROOT / "docs" / "parishes.geojson"

OFFICES = ["LIX", "SHV", "JAN", "LCH"]

# NWS requires a User-Agent that identifies your app and gives a contact.
# Only the text between the quotation marks may be edited.
USER_AGENT = "BurnWise-LA-SugarcaneBurnTool (contact: lastateclimate@lsu.edu)"

API_LIST = "https://api.weather.gov/products/types/FWF/locations/{office}"

SCHEMA_VERSION = 2

# Category Day meaning under the Louisiana Voluntary Smoke Management
# Guidelines: scale 1..5 based on ventilation rate, 1 = poor, 5 = excellent.
# "No burning ... is allowed, under the LA Smoke Management Guidelines,
#  during Category 1 periods."
# VERIFY the label wording with your LSU AgCenter / LDAF contact before
# release. The numbers-to-verdict mapping below is deliberately conservative.
CATEGORY_VERDICTS = {
    1: {"verdict": "DO NOT BURN", "detail": "Category 1: burning is not allowed under the Louisiana Smoke Management Guidelines.", "level": "no"},
    2: {"verdict": "POOR", "detail": "Category 2: poor smoke dispersal. Burning is strongly discouraged.", "level": "poor"},
    3: {"verdict": "FAIR", "detail": "Category 3: fair dispersal. Review winds and your burn plan carefully.", "level": "fair"},
    4: {"verdict": "GOOD", "detail": "Category 4: good dispersal. Confirm surface and transport winds fit your plan.", "level": "good"},
    5: {"verdict": "EXCELLENT", "detail": "Category 5: excellent dispersal conditions.", "level": "good"},
}

# Words that can appear as period column headers in FWF matrices.
# Real products use "Today / Tonight / Tue" in the morning issuance and
# "Tonight / Tue / Tue Night / Wed" in the afternoon issuance. Both must match.
PERIOD_WORD = re.compile(
    r"^(Rest of |This )?("
    r"Today|Tonight|Tomorrow|Overnight|Afternoon|Evening|Morning|"
    r"(Mon|Tue|Wed|Thu|Fri|Sat|Sun)(day|sday|nesday|rsday|urday)?"
    r"( Night| Evening| Morning| Afternoon)?"
    r")$",
    re.IGNORECASE,
)

ZONE_CODE_LINE = re.compile(r"^[A-Z]{2}Z\d{3}")
M_TO_FT = 3.28084
MS_TO_MPH = 2.23694

# Official Louisiana fire weather zone list (code -> name), cached locally.
# Prevents a dangerous bug: Mississippi counties named Franklin, Jefferson,
# Lincoln, Madison, Union share names with Louisiana parishes, so we match
# by LAZ zone CODE, never by name alone, whenever this cache is available.
ZONES_CACHE = ROOT / "docs" / "data" / "zones_la.json"
API_ZONES = "https://api.weather.gov/zones?type=fire&area=LA"


def expand_ugc_codes(block: str) -> list[str]:
    """Expand UGC header lines like 'LAZ034>037-046-MSZ068>071-062300-'
    into ['LAZ034','LAZ035','LAZ036','LAZ037','LAZ046','MSZ068',...]."""
    codes = []
    for line in block.splitlines():
        s = line.strip()
        if not ZONE_CODE_LINE.match(s):
            if codes:
                break  # code lines come first; stop at the first non-code line
            continue
        prefix = None
        for token in s.rstrip("-").split("-"):
            token = token.strip()
            m = re.match(r"^([A-Z]{2}Z)(\d{3})(?:>(\d{3}))?$", token)
            if m:
                prefix = m.group(1)
                lo = int(m.group(2))
                hi = int(m.group(3)) if m.group(3) else lo
                codes.extend(f"{prefix}{n:03d}" for n in range(lo, hi + 1))
            elif prefix and re.match(r"^(\d{3})(?:>(\d{3}))?$", token):
                m2 = re.match(r"^(\d{3})(?:>(\d{3}))?$", token)
                lo = int(m2.group(1))
                hi = int(m2.group(2)) if m2.group(2) else lo
                # Trailing ddhhmm purge time is 6 digits, so 3-digit only here
                codes.extend(f"{prefix}{n:03d}" for n in range(lo, hi + 1))
    return codes


def load_zone_names(offline: bool) -> dict[str, str]:
    """Return {'LAZ034': 'West Feliciana', ...} from cache or the NWS API."""
    if ZONES_CACHE.exists():
        try:
            return json.loads(ZONES_CACHE.read_text())
        except Exception:
            pass
    if offline:
        return {}
    try:
        data = http_get(API_ZONES)
        mapping = {}
        for feat in data.get("features", []):
            props = feat.get("properties", {})
            zid, name = props.get("id"), props.get("name")
            if zid and name and zid.startswith("LAZ"):
                mapping[zid] = name
        if mapping:
            ZONES_CACHE.parent.mkdir(parents=True, exist_ok=True)
            ZONES_CACHE.write_text(json.dumps(mapping, indent=1))
        return mapping
    except Exception:
        return {}


# ---------------------------------------------------------------- helpers

def norm(s: str) -> str:
    """Normalize a place name for matching: lowercase, strip punctuation,
    unify St./Saint, DeSoto/De Soto, LaSalle/La Salle."""
    s = unicodedata.normalize("NFKD", s).lower()
    s = re.sub(r"[.\-']", " ", s)
    s = re.sub(r"\bsaint\b", "st", s)
    s = re.sub(r"\s+", "", s)
    s = s.replace("lasalle", "la salle".replace(" ", ""))
    s = s.replace("desoto", "de soto".replace(" ", ""))
    return s


def load_parishes() -> list[str]:
    gj = json.loads(GEOJSON_PATH.read_text())
    return [f["properties"]["name"] for f in gj["features"]]


def http_get(url: str) -> dict:
    r = requests.get(url, headers={"User-Agent": USER_AGENT, "Accept": "application/geo+json"}, timeout=30)
    r.raise_for_status()
    return r.json()


# ---------------------------------------------------------------- parsing

def split_zone_blocks(product_text: str) -> list[str]:
    """FWF products separate zone groups with lines containing '$$'."""
    blocks, current, started = [], [], False
    for line in product_text.splitlines():
        if ZONE_CODE_LINE.match(line):
            started = True
        if line.strip() == "$$":
            if current:
                blocks.append("\n".join(current))
            current, started = [], False
            continue
        if started:
            current.append(line)
    if current:
        blocks.append("\n".join(current))
    return blocks


def extract_zone_names(block: str) -> list[str]:
    """Zone names come on dash-separated line(s) after the zone code line(s)
    and before the 'Including the cities' line or a timestamp line."""
    lines = block.splitlines()
    names = []
    past_codes = False
    for line in lines:
        s = line.strip()
        if ZONE_CODE_LINE.match(s):
            past_codes = True
            continue
        if not past_codes:
            continue
        if s.lower().startswith("including the cities"):
            break
        if re.match(r"^\d{3,4} (AM|PM) [A-Z]{3}", s):
            break
        if not s:
            break
        names.extend(n.strip() for n in s.rstrip("-").split("-") if n.strip())
    return names


def find_header(lines: list[str]):
    """Find the period header row and the start column of every period.
    Returns (line_index, [(period_name, start_col), ...]) or (None, None)."""
    for i, line in enumerate(lines):
        tokens = [(m.group(), m.start()) for m in re.finditer(r"\S+(?: \S+)*?(?=\s{2,}|$)", line)]
        # Tokens separated by 2+ spaces; every token must look like a period.
        if len(tokens) >= 2 and all(PERIOD_WORD.match(t) for t, _ in tokens):
            return i, tokens
    return None, None


def slice_columns(line: str, cols) -> list[str]:
    """Extract the value under each period column using column positions.
    Values are aligned with the header; allow 2 chars of left tolerance
    because some offices right-pad labels into the first column."""
    out = []
    for j, (_, start) in enumerate(cols):
        end = cols[j + 1][1] if j + 1 < len(cols) else len(line)
        lo = max(0, start - 2) if j == 0 else start
        out.append(line[lo:end].strip())
    return out


def parse_number(text: str):
    m = re.search(r"-?\d+(\.\d+)?", text or "")
    return float(m.group()) if m else None


def parse_wind(text: str):
    """Returns (dir, lo, hi, gust) in the product's own units.
    'NE 3-7'        -> ('NE', 3, 7, None)
    'E 6-10 G18'    -> ('E', 6, 10, 18)
    'S  6'          -> ('S', 6, 6, None)
    'Lgt/Var'       -> ('Lgt/Var', 0, 5, None)   light and variable
    ''              -> (None, None, None, None)"""
    if not text:
        return None, None, None, None
    t = text.strip()
    if re.match(r"^(Lgt|Light)\s*/?\s*(Var|Variable)", t, re.IGNORECASE) or t.lower() in ("calm", "light"):
        return "Lgt/Var", 0, 5, None
    m = re.match(r"([NSEW]{1,3})\s+(\d+)(?:\s*-\s*(\d+))?(?:\s+G(\d+))?", t)
    if not m:
        return None, None, None, None
    lo = int(m.group(2))
    hi = int(m.group(3)) if m.group(3) else lo
    gust = int(m.group(4)) if m.group(4) else None
    return m.group(1), lo, hi, gust


def parse_block(block: str, debug=False) -> dict | None:
    lines = block.splitlines()
    zone_names = extract_zone_names(block)
    hdr_idx, cols = find_header(lines)
    if hdr_idx is None or not zone_names:
        if debug:
            print("  ! Skipped block (no header/names):", (zone_names or ["?"])[:3], file=sys.stderr)
        return None

    periods = [{"name": name, "raw": {}} for name, _ in cols]

    for line in lines[hdr_idx + 1:]:
        if not line.strip():
            continue
        # Label = everything left of the first period column.
        label = line[: max(0, cols[0][1] - 2)].strip()
        if not label:
            continue
        values = slice_columns(line, cols)
        for p, v in zip(periods, values):
            if v:
                p["raw"][label] = v

    for p in periods:
        raw = p["raw"]

        def get(*keys):
            """Match a row label by whole word anywhere in the label, so
            'Max/Min Temp' and 'Min/Max RH (%)' are found."""
            for label, v in raw.items():
                for k in keys:
                    if re.search(r"(?<![A-Za-z])" + re.escape(k) + r"(?![A-Za-z])", label, re.IGNORECASE):
                        return label, v
            return None, None

        lab, v = get("Category Day")
        cat = parse_number(v) if v else None
        p["category"] = int(cat) if cat and 1 <= cat <= 5 else None

        lab, v = get("Mixing Hgt", "Mixing Height")  # word-match; excludes "Mrng Mxg Hgt"
        mh = parse_number(v)
        if mh is not None and lab and re.search(r"\(m\b|m-AGL", lab):
            mh = round(mh * M_TO_FT)
        p["mixing_height_ft"] = int(mh) if mh is not None else None

        lab, v = get("Transport Wind")
        d, lo, hi, g = parse_wind(v)
        if lo is not None and lab and "m/s" in lab.lower():
            lo, hi = round(lo * MS_TO_MPH), round(hi * MS_TO_MPH)
            g = round(g * MS_TO_MPH) if g is not None else None
        p["transport_wind"] = {"dir": d, "lo_mph": lo, "hi_mph": hi, "gust_mph": g} if lo is not None else None

        _, v = get("20FT Wind/AM", "20 FT Wind/AM")
        d, lo, hi, g = parse_wind(v)
        p["surface_wind_am"] = {"dir": d, "lo_mph": lo, "hi_mph": hi, "gust_mph": g} if lo is not None else None

        _, v = get("20FT Wind/PM", "20 FT Wind/PM")
        d, lo, hi, g = parse_wind(v)
        p["surface_wind_pm"] = {"dir": d, "lo_mph": lo, "hi_mph": hi, "gust_mph": g} if lo is not None else None

        _, v = get("RH")
        p["rh_pct"] = int(parse_number(v)) if parse_number(v) is not None else None
        _, v = get("Temp")
        p["temp_f"] = int(parse_number(v)) if parse_number(v) is not None else None
        _, v = get("Chance Precip")
        p["precip_chance_pct"] = int(parse_number(v)) if parse_number(v) is not None else None
        _, v = get("Vent Rate")
        p["vent_rate"] = parse_number(v)

    return {"zone_names": zone_names, "periods": periods}


# ---------------------------------------------------------------- pipeline

def fetch_latest_product(office: str) -> dict:
    listing = http_get(API_LIST.format(office=office))
    graph = listing.get("@graph", [])
    if not graph:
        raise RuntimeError(f"No FWF products listed for {office}")
    latest = graph[0]  # newest first per NWS API
    product = http_get(latest["@id"])
    return {
        "text": product["productText"],
        "issued": product.get("issuanceTime"),
        "product_id": product.get("id"),
    }


def validate_period(p: dict, warnings: list, where: str):
    mh = p.get("mixing_height_ft")
    if mh is not None and not (0 <= mh <= 25000):
        warnings.append(f"{where}: mixing height {mh} ft out of sane range; value dropped")
        p["mixing_height_ft"] = None
    tw = p.get("transport_wind")
    if tw and tw["hi_mph"] is not None and not (0 <= tw["hi_mph"] <= 80):
        warnings.append(f"{where}: transport wind {tw['hi_mph']} mph out of sane range; value dropped")
        p["transport_wind"] = None


def run(sample_path=None, debug=False):
    parishes = load_parishes()
    parish_norm = {norm(name): name for name in parishes}

    previous = {}
    if OUT_PATH.exists():
        try:
            previous = json.loads(OUT_PATH.read_text())
        except Exception:
            previous = {}

    warnings, offices_meta = [], {}
    parish_data: dict[str, dict] = {}

    zone_names_official = load_zone_names(offline=bool(sample_path))
    if not zone_names_official:
        warnings.append("Official LAZ zone list unavailable; falling back to "
                        "name matching restricted to blocks containing LAZ codes.")

    def ingest(office, text, issued, product_id):
        blocks = split_zone_blocks(text)
        parsed = []
        for bl in blocks:
            codes = expand_ugc_codes(bl)
            la_codes = [c for c in codes if c.startswith("LAZ")]
            if not la_codes:
                continue  # Mississippi/Texas/Arkansas-only block: not our state
            b = parse_block(bl, debug)
            if b:
                b["la_codes"] = la_codes
                parsed.append(b)
        if not parsed:
            raise RuntimeError(f"{office}: product fetched but 0 Louisiana zones parsed (format change?)")
        offices_meta[office] = {"issued": issued, "product_id": product_id,
                                "zones_parsed": len(parsed), "ok": True}
        for z in parsed:
            # Prefer official code->name lookup; fall back to header names.
            if zone_names_official:
                names_to_match = [zone_names_official[c] for c in z["la_codes"]
                                  if c in zone_names_official]
                unknown = [c for c in z["la_codes"] if c not in zone_names_official]
                if unknown:
                    warnings.append(f"{office}: unknown LAZ codes {unknown}; "
                                    "refresh docs/data/zones_la.json")
            else:
                names_to_match = z["zone_names"]
            matched = set()
            for zn in names_to_match:
                n = norm(zn)
                for pn_norm, pn in parish_norm.items():
                    if pn_norm and pn_norm in n:
                        matched.add(pn)
            for parish in matched:
                for p in z["periods"]:
                    validate_period(p, warnings, f"{office}/{parish}/{p['name']}")
                entry = parish_data.setdefault(parish, {"office": office, "issued": issued,
                                                        "periods": None, "zones": []})
                entry["zones"].extend(z["zone_names"])
                if entry["periods"] is None:
                    entry["periods"] = [dict(p) for p in z["periods"]]
                else:  # parish in multiple zones: keep the worst category per period
                    for old, new in zip(entry["periods"], z["periods"]):
                        oc, nc = old.get("category"), new.get("category")
                        if nc is not None and (oc is None or nc < oc):
                            old.update({k: v for k, v in new.items() if k != "name"})

    if sample_path:
        text = Path(sample_path).read_text()
        ingest("LIX", text, datetime.now(timezone.utc).isoformat(), "SAMPLE")
    else:
        for office in OFFICES:
            try:
                prod = fetch_latest_product(office)
                ingest(office, prod["text"], prod["issued"], prod["product_id"])
            except Exception as e:
                warnings.append(f"{office}: FAILED ({e}). Serving last good data for its parishes.")
                offices_meta[office] = {"ok": False, "error": str(e)}
                # Recover last-good parishes that came from this office
                for name, entry in (previous.get("parishes") or {}).items():
                    if entry.get("office") == office and name not in parish_data:
                        entry = dict(entry)
                        entry["stale"] = True
                        parish_data[name] = entry

    # Attach verdicts (deterministic, from the verified Category Day scale)
    for name, entry in parish_data.items():
        for p in entry.get("periods") or []:
            cat = p.get("category")
            p["verdict"] = CATEGORY_VERDICTS.get(cat) if cat else None

    missing = [p for p in parishes if p not in parish_data]
    if missing:
        warnings.append(f"No forecast matched for {len(missing)} parishes: {', '.join(missing)}")

    out = {
        "schema_version": SCHEMA_VERSION,
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "offices": offices_meta,
        "parishes": parish_data,
        "missing_parishes": missing,
        "warnings": warnings,
        "disclaimer": ("This tool translates National Weather Service forecasts and the "
                       "Louisiana Smoke Management Guidelines. It does not authorize burning. "
                       "It does not reflect parish or state burn bans. You are responsible for "
                       "checking burn bans and complying with all regulations."),
    }

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(out, indent=1))
    print(f"Wrote {OUT_PATH}")
    print(f"Parishes with data: {len(parish_data)}/{len(parishes)}")
    for w in warnings:
        print("WARNING:", w)
    # Non-zero exit if everything failed, so GitHub Actions emails you.
    if not parish_data:
        sys.exit(1)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--sample", help="Parse a local FWF text file instead of fetching")
    ap.add_argument("--debug", action="store_true")
    args = ap.parse_args()
    run(sample_path=args.sample, debug=args.debug)
