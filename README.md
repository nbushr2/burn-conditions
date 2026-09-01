# Louisiana Burn Conditions: setup manual

A mobile web app that shows Louisiana sugarcane farmers, parish by parish,
whether today is a safe day to burn, based on the National Weather Service
(NWS) Fire Weather Planning Forecasts from the four offices covering the
state (LIX New Orleans, SHV Shreveport, JAN Jackson, LCH Lake Charles) and
the Category Day scale used by the Louisiana Smoke Management Guidelines.

You do not need to install anything on your computer. Everything runs in
your web browser using free GitHub services.

## How it works (one paragraph)

Every 30 minutes, a small robot (GitHub Actions) fetches the latest fire
weather forecast from the official NWS API, checks that the data makes
sense, and saves one clean file called `latest.json`. The website (GitHub
Pages) is just a page that reads that file and draws the map. Farmers'
phones never talk to NWS directly and never do any calculation. If
anything breaks, the app shows old data WITH A LOUD WARNING instead of
showing nothing or showing something wrong.

## Part A: Put it online (about 30 minutes, all in the browser)

1. Create a free account at github.com. Use a project email your office
   controls, not a student's personal email (students graduate).
2. Click the "+" in the top right, then "New repository". Name it
   `burn-conditions`. Set it to Public. Click "Create repository".
3. On the new repository page, click "uploading an existing file".
   Drag ALL the files and folders from this kit into the upload box,
   keeping the folder structure exactly as it is (`scripts/`, `docs/`,
   `.github/workflows/`). Write "first upload" in the message box and
   click "Commit changes".
   If your browser will not upload the hidden `.github` folder, create the
   file by hand: in the repository click "Add file" then "Create new file",
   type `.github/workflows/update-forecast.yml` as the name (the slashes
   create the folders), and paste in the contents of that file from this kit.
4. IMPORTANT, do this before anything else: open
   `scripts/fetch_forecasts.py` in the repository, click the pencil icon,
   and change the line starting with `USER_AGENT` so it contains your real
   contact email. NWS requires this so they can contact you if your app
   misbehaves. Commit the change.
5. Turn on the website: go to Settings, then Pages (left sidebar). Under
   "Build and deployment", set Source to "Deploy from a branch", Branch to
   `main`, folder to `/docs`. Click Save. After a minute or two, the page
   will show your site address, something like
   `https://YOURNAME.github.io/burn-conditions/`.
6. Turn on the robot: click the "Actions" tab. If it asks you to enable
   workflows, click enable. Click "Update burn forecast" in the left list,
   then the "Run workflow" button, then the green "Run workflow" again.
   Wait for the green check mark (about a minute).
7. Open your site address on your phone. You should see the map colored
   with today's real ratings. Done.

## Part B: Verify before you tell a single farmer about it

Do not skip this. The kit was tested against a sample of the real LIX
product format, but NWS offices differ slightly and change formats
occasionally. Spend one afternoon on this checklist:

1. Pick 5 parishes spread across the state (one per NWS office at least).
   For each, compare the app's Category Day, transport wind, and surface
   wind against the raw forecast at forecast.weather.gov (search "FWF LIX",
   "FWF SHV", "FWF JAN", "FWF LCH"). They must match exactly.
2. In the repository, open `docs/data/latest.json` and read the
   `warnings` list. It should be empty or nearly empty. If it says parishes
   are missing, the zone-name matching needs adjusting for that office;
   the file `docs/data/zones_la.json` (created automatically on the first
   live run) shows the official zone names being matched.
3. Show the wording of the five verdict labels ("DO NOT BURN", "POOR",
   "FAIR", "GOOD", "EXCELLENT" in `scripts/fetch_forecasts.py`, the
   `CATEGORY_VERDICTS` table) to your LSU AgCenter or LDAF contact and get
   written sign-off. The Category 1 = no burning rule comes from the
   Louisiana Voluntary Smoke Management Guidelines; the rest of the wording
   is ours and an expert must approve it.
4. Test the app on one cheap Android phone and one iPhone, outdoors in
   sunlight, on cellular data. Then put the phone in airplane mode and
   reopen the app: you should see the last forecast with an OFFLINE banner.

## Part C: Monitoring (15 minutes, prevents silent death)

1. GitHub emails the repository owner automatically when the scheduled
   workflow fails. Make sure that email is watched by a real person.
2. Optional but recommended: create a free uptimerobot.com monitor that
   checks `https://YOURNAME.github.io/burn-conditions/data/latest.json`
   once an hour and emails you if it is unreachable.
3. Put a recurring reminder in your office calendar: once a month, open
   the app, pick two parishes, and spot-check them against
   forecast.weather.gov. Five minutes. This catches format drift that no
   automatic check can.

## Part D: What each file is

- `scripts/fetch_forecasts.py`  The pipeline. Fetches, parses, validates,
  writes `docs/data/latest.json`. All safety rules live here.
- `scripts/sample_fwf_lix.txt`  A sample forecast for offline testing:
  `python3 scripts/fetch_forecasts.py --sample scripts/sample_fwf_lix.txt`
- `.github/workflows/update-forecast.yml`  The 30-minute schedule.
- `docs/`  The entire website. `index.html` (page), `style.css` (design),
  `app.js` (logic), `parishes.geojson` (the 64 parish shapes, from the US
  Census county boundaries), `sw.js` + `manifest.json` + `icons/` (the
  "Add to Home Screen" and offline machinery), `docs/data/latest.json`
  (the forecast, rewritten by the robot).

## Part E: Known limits (tell farmers these, honestly)

- The app does NOT show burn bans. A parish can look green while under a
  legal burn ban from the State Fire Marshal or parish government. The
  disclaimer says so on every screen. Checking bans stays the farmer's job
  unless you later add a ban feed.
- Nighttime periods often have no Category Day because NWS does not always
  issue one; the app then says "NO RATING" and tells the user not to burn
  without one, rather than guessing.
- Some parishes are split across NWS fire weather zones. When that
  happens the app deliberately shows the WORST rating among the zones.
- GitHub's 30-minute schedule can slip by a few minutes under load. The
  app always displays the data's age, so slippage is visible, not hidden.

## Part F: Later (only after A through E are solid)

- AI question answering: if the grant needs it, add it as a separate,
  clearly labeled "Explain this forecast" button that sends ONLY the
  already-validated JSON for the selected parish to an LLM API and refuses
  everything else. The AI must never produce or change a rating. Do not
  build an open "ask anything" chatbot for this audience.
- A burn-ban feed, if LDAF or the Fire Marshal publishes one you can read
  automatically.
- SMS or push alerts for Category 1 days.
