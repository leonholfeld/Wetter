/**
 * ============================================================
 *  Wetter & Luftqualitäts-Monitor
 *
 *  ► DWD  – offizielle DWD-App-API (dwd.api.bund.dev)
 *           Endpunkt: https://app-prod-ws.warnwetter.de/v30
 *           Daten: Stationsübersicht, Warnungen, Crowd-Meldungen
 *
 *  ► UBA  – Umweltbundesamt Luftdaten API v4
 *           Endpunkt: https://luftdaten.umweltbundesamt.de/api/air-data/v4
 *           Daten: PM10, PM2.5, NO2, O3, Luftqualitätsindex
 *
 *  Abfrage alle 5 Minuten, Ausgabe in Konsole + wetter_log.json
 *
 *  Setup:
 *    node --version        (>= 18 empfohlen, dann kein npm install noetig)
 *    node wetter-monitor.js
 *
 *  DWD-Stationskennungen nachschlagen:
 *    https://www.dwd.de/DE/leistungen/klimadatendeutschland/statliste/statlex_html.html
 * ============================================================
 */

// ---- Konfiguration ------------------------------------------
const CONFIG = {
  // DWD Stationskennungen (Array, mehrere moeglich).
  // 10400 = Meppen (naechste offizielle DWD-Station zu Boerger/Niedersachsen)
  // Weitere IDs: https://www.dwd.de/DE/leistungen/klimadatendeutschland/stationsliste.html
  dwdStationIds: ["10400"],

  // UBA Messstation (leer = bis zu 8 Stationen bundesweit)
  // z.B. "DENI010" fuer Lingen (Ems)
  ubaStationCode: "",

  // Abfrageintervall in Millisekunden (Standard: 5 Minuten)
  intervalMs: 5 * 60 * 1000,

  // Logdatei (JSON)
  logFile: "./wetter_log.json",
};
// -------------------------------------------------------------

import { writeFileSync, readFileSync, existsSync } from "fs";

// fetch: nativ ab Node 18
if (!globalThis.fetch) {
  console.error(
    "Kein natives fetch verfuegbar. Bitte Node.js >= 18 verwenden."
  );
  process.exit(1);
}

// ---- Einheiten-Umrechnung -----------------------------------
// Quelle: bundesAPI/dwd-api README (Rohwerte des DWD)
const EINHEITEN = {
  temperature:        { faktor: 0.1, einheit: "C",    name: "Temperatur" },
  temperatureMin:     { faktor: 0.1, einheit: "C",    name: "Temp. Min" },
  temperatureMax:     { faktor: 0.1, einheit: "C",    name: "Temp. Max" },
  dewPoint2m:         { faktor: 0.1, einheit: "C",    name: "Taupunkt" },
  humidity:           { faktor: 0.1, einheit: "%",    name: "Luftfeuchte" },
  surfacePressure:    { faktor: 0.1, einheit: "hPa",  name: "Luftdruck" },
  precipitationTotal: { faktor: 0.1, einheit: "mm/h", name: "Niederschlag" },
  precipitation:      { faktor: 0.1, einheit: "mm/d", name: "Niederschlag/Tag" },
  windSpeed:          { faktor: 1,   einheit: "km/h", name: "Wind" },
  windGust:           { faktor: 1,   einheit: "km/h", name: "Boen" },
  windDirection:      { faktor: 1,   einheit: "Grad", name: "Windrichtung" },
  sunshine:           { faktor: 0.1, einheit: "min",  name: "Sonnenschein" },
};

function umrechnen(key, raw) {
  if (raw == null) return null;
  const def = EINHEITEN[key];
  if (!def) return raw;
  return parseFloat((raw * def.faktor).toFixed(1));
}

// ---- Hilfsfunktionen ----------------------------------------

function now() {
  return new Date().toLocaleString("de-DE", { timeZone: "Europe/Berlin" });
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function ubaDateTime() {
  const d = new Date();
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const hour = d.getHours() === 0 ? 24 : d.getHours();
  return { date, hour };
}

function appendLog(entry) {
  let log = [];
  if (existsSync(CONFIG.logFile)) {
    try { log = JSON.parse(readFileSync(CONFIG.logFile, "utf8")); }
    catch { log = []; }
  }
  log.push(entry);
  if (log.length > 1000) log = log.slice(-1000);
  writeFileSync(CONFIG.logFile, JSON.stringify(log, null, 2), "utf8");
}

// ---- DWD-Endpunkte -----------------------------------------
// Alle URLs stammen direkt aus der openapi.yaml unter dwd.api.bund.dev
const DWD_BASE = "https://app-prod-ws.warnwetter.de/v30";
const S3_BASE  = "https://s3.eu-central-1.amazonaws.com/app-prod-static.warnwetter.de/v16";

/**
 * GET /stationOverviewExtended?stationIds=...
 * Liefert: forecast1 (stuendlich), forecast2 (3h), days (10 Tage), warnings
 */
async function fetchDWDStation(stationIds) {
  const res = await fetch(
    `${DWD_BASE}/stationOverviewExtended?stationIds=${stationIds.join(",")}`
  );
  if (!res.ok) throw new Error(`DWD stationOverview HTTP ${res.status}`);
  const json = await res.json();

  const ergebnisse = {};

  for (const id of stationIds) {
    const raw = json[id];
    if (!raw) {
      ergebnisse[id] = { fehler: "Keine Daten fuer diese Station" };
      continue;
    }

    // forecast1: stuendliche Zeitreihe
    const f1       = raw.forecast1 ?? {};
    const startMs  = f1.start    ?? 0;
    const stepMs   = f1.timeStep ?? 3600000; // 1 Stunde
    const idx      = Math.max(0, Math.floor((Date.now() - startMs) / stepMs));

    function get(arr) {
      if (!Array.isArray(arr) || !arr.length) return null;
      return arr[Math.min(idx, arr.length - 1)];
    }

    const aktuell = {
      zeitpunkt:         new Date(startMs + idx * stepMs).toLocaleString("de-DE"),
      temperatur_C:      umrechnen("temperature",        get(f1.temperature)),
      niederschlag_mmh:  umrechnen("precipitationTotal", get(f1.precipitationTotal)),
      icon_code:         get(f1.icon),
    };

    // Tageswerte: days[0] = heute, days[1] = morgen usw.
    const tageswerte = (raw.days ?? []).slice(0, 3).map((d) => ({
      datum:              d.dayDate,
      temp_min_C:         umrechnen("temperatureMin", d.temperatureMin),
      temp_max_C:         umrechnen("temperatureMax", d.temperatureMax),
      niederschlag_mm:    umrechnen("precipitation",  d.precipitation),
      wind_kmh:           umrechnen("windSpeed",      d.windSpeed),
      boeen_kmh:          umrechnen("windGust",       d.windGust),
      windrichtung_grad:  umrechnen("windDirection",  d.windDirection),
      sonnenschein_min:   umrechnen("sunshine",       d.sunshine),
      icon_code:          d.icon,
    }));

    // Stationsspezifische Warnungen
    const warnungen = (raw.warnings ?? []).map((w) => ({
      event:    w.event,
      headline: w.headLine,
      level:    w.level,
      von:      w.start ? new Date(w.start).toLocaleString("de-DE") : null,
      bis:      w.end   ? new Date(w.end).toLocaleString("de-DE")   : null,
      info:     w.description,
    }));

    ergebnisse[id] = { aktuell, tageswerte, warnungen };
  }

  return {
    quelle:    "DWD WarnWetter-App-API (dwd.api.bund.dev)",
    endpunkt:  `${DWD_BASE}/stationOverviewExtended`,
    stationen: ergebnisse,
  };
}

/**
 * GET /gemeinde_warnings_v2.json
 * Aktive Unwetterwarnungen fuer alle deutschen Gemeinden
 */
async function fetchDWDGemeindeWarnungen() {
  const res = await fetch(`${S3_BASE}/gemeinde_warnings_v2.json`);
  if (!res.ok) throw new Error(`DWD Gemeindewarnungen HTTP ${res.status}`);
  const json = await res.json();

  const alle = Object.values(json.warnings ?? {}).flat();
  return {
    stand:            new Date(json.time ?? 0).toLocaleString("de-DE"),
    anzahl_warnungen: alle.length,
    // Stichprobe: erste 5 Warnungen
    stichprobe: alle.slice(0, 5).map((w) => ({
      event:    w.event,
      headline: w.headLine,
      level:    w.level,
    })),
  };
}

/**
 * GET /warnings_nowcast.json
 * Kurzfristige Gewitterwarnungen (Nowcast)
 */
async function fetchDWDNowcast() {
  const res = await fetch(`${S3_BASE}/warnings_nowcast.json`);
  if (!res.ok) throw new Error(`DWD Nowcast HTTP ${res.status}`);
  const json = await res.json();
  return {
    stand:            new Date(json.time ?? 0).toLocaleString("de-DE"),
    anzahl_warnungen: (json.warnings ?? []).length,
  };
}

/**
 * GET /crowd_meldungen_overview_v2.json
 * Wettermeldungen von DWD-App-Nutzern
 */
async function fetchDWDCrowd() {
  const res = await fetch(`${S3_BASE}/crowd_meldungen_overview_v2.json`);
  if (!res.ok) throw new Error(`DWD Crowd HTTP ${res.status}`);
  const json = await res.json();
  return {
    gueltig_bis:      new Date(json.end ?? 0).toLocaleString("de-DE"),
    anzahl_meldungen: (json.meldungen ?? []).length,
    hoechste_schwere: (json.highestSeverities ?? []).map((s) => ({
      kategorie:   s.category,
      auspraegung: s.auspraegung,
    })),
  };
}

// Alle vier DWD-Endpunkte parallel abrufen
async function fetchDWD() {
  const [stationen, gemeinde, nowcast, crowd] = await Promise.allSettled([
    fetchDWDStation(CONFIG.dwdStationIds),
    fetchDWDGemeindeWarnungen(),
    fetchDWDNowcast(),
    fetchDWDCrowd(),
  ]);

  function val(p) {
    return p.status === "fulfilled" ? p.value : { fehler: p.reason?.message };
  }

  return {
    stationen_daten:    val(stationen),
    gemeinde_warnungen: val(gemeinde),
    nowcast_warnungen:  val(nowcast),
    crowd_meldungen:    val(crowd),
  };
}

// ---- UBA API ------------------------------------------------
async function fetchUBA() {
  const { date, hour } = ubaDateTime();
  const url = new URL(
    "https://luftdaten.umweltbundesamt.de/api/air-data/v4/airquality/json"
  );
  url.searchParams.set("date_from", date);
  url.searchParams.set("date_to",   date);
  url.searchParams.set("time_from", pad(hour));
  url.searchParams.set("time_to",   pad(hour));
  if (CONFIG.ubaStationCode) url.searchParams.set("station", CONFIG.ubaStationCode);

  const res = await fetch(url.toString(), { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`UBA HTTP ${res.status}`);
  const json = await res.json();

  const stationen = [];
  for (const [code, schadstoffe] of Object.entries(json.data ?? {})) {
    const messwerte = {};
    for (const [schadstoff, werte] of Object.entries(schadstoffe)) {
      if (Array.isArray(werte) && werte.length > 0)
        messwerte[schadstoff] = werte[werte.length - 1];
    }
    stationen.push({ station_code: code, messwerte });
    if (!CONFIG.ubaStationCode && stationen.length >= 8) break;
  }

  return {
    quelle:         "Umweltbundesamt Luftdaten API v4",
    abfrage_datum:  date,
    abfrage_stunde: hour,
    lqi_skala:      { 1: "sehr gut", 2: "gut", 3: "maessig", 4: "schlecht", 5: "sehr schlecht" },
    stationen,
  };
}

// ---- Konsolenausgabe ----------------------------------------
const L = "-".repeat(56);

function printDWD(dwd) {
  console.log(`\n+${L}+`);
  console.log("| DWD - Deutscher Wetterdienst (dwd.api.bund.dev)        |");
  console.log(`+${L}+`);

  const s = dwd.stationen_daten?.stationen ?? {};
  for (const [id, d] of Object.entries(s)) {
    if (d.fehler) { console.log(`| Station ${id}: FEHLER - ${d.fehler}`); continue; }
    const a = d.aktuell ?? {};
    console.log(`| Station ${id} | ${a.zeitpunkt ?? "?"}`);
    console.log(`|   Temperatur:    ${a.temperatur_C ?? "?"} C`);
    console.log(`|   Niederschlag:  ${a.niederschlag_mmh ?? "?"} mm/h`);
    console.log(`|   Icon-Code:     ${a.icon_code ?? "?"}`);

    if (d.tageswerte?.length) {
      console.log("|   -- 3-Tages-Vorschau --");
      for (const t of d.tageswerte) {
        console.log(
          `|   ${t.datum}: ${t.temp_min_C} bis ${t.temp_max_C} C | ` +
          `Wind ${t.wind_kmh} km/h | Sonne ${t.sonnenschein_min} min`
        );
      }
    }

    if (d.warnungen?.length) {
      console.log(`|   WARNUNGEN (${d.warnungen.length}):`);
      for (const w of d.warnungen)
        console.log(`|   [Level ${w.level}] ${w.event}: ${w.headline}`);
    } else {
      console.log("|   Keine aktiven Stationswarnungen");
    }
  }

  const gw = dwd.gemeinde_warnungen;
  if (gw && !gw.fehler)
    console.log(`| Gemeindewarnungen D: ${gw.anzahl_warnungen} (Stand: ${gw.stand})`);

  const nc = dwd.nowcast_warnungen;
  if (nc && !nc.fehler)
    console.log(`| Nowcast-Warnungen: ${nc.anzahl_warnungen} (${nc.stand})`);

  const cr = dwd.crowd_meldungen;
  if (cr && !cr.fehler)
    console.log(`| Crowd-Meldungen: ${cr.anzahl_meldungen} | gueltig bis ${cr.gueltig_bis}`);

  console.log(`+${L}+`);
}

function printUBA(uba) {
  console.log(`\n+${L}+`);
  console.log("| UBA - Luftqualitaet (api.bund.dev v4)                  |");
  console.log(`+${L}+`);
  if (!uba.stationen.length) {
    console.log("| (keine Daten fuer diesen Zeitraum)                     |");
  }
  for (const s of uba.stationen) {
    console.log(`| Station: ${s.station_code}`);
    for (const [k, v] of Object.entries(s.messwerte))
      console.log(`|   ${k}: ${JSON.stringify(v)}`);
  }
  console.log(`+${L}+`);
}

// ---- Hauptschleife ------------------------------------------
async function run() {
  console.log(`\nWetter-Monitor gestartet - ${now()}`);
  console.log(`  DWD-Stationen : ${CONFIG.dwdStationIds.join(", ")}`);
  console.log(`  UBA-Station   : ${CONFIG.ubaStationCode || "alle (max. 8)"}`);
  console.log(`  Intervall     : ${CONFIG.intervalMs / 1000}s`);
  console.log(`  Logdatei      : ${CONFIG.logFile}\n`);

  async function abfrage() {
    const ts = now();
    console.log(`\n${"=".repeat(25)} ${ts}`);

    let dwd = null, uba = null, fehler = [];

    try {
      dwd = await fetchDWD();
      printDWD(dwd);
    } catch (err) {
      console.error(`DWD Fehler: ${err.message}`);
      fehler.push({ quelle: "DWD", fehler: err.message });
    }

    try {
      uba = await fetchUBA();
      printUBA(uba);
    } catch (err) {
      console.error(`UBA Fehler: ${err.message}`);
      fehler.push({ quelle: "UBA", fehler: err.message });
    }

    appendLog({ abfrage_zeit: ts, dwd, uba, fehler: fehler.length ? fehler : undefined });
    console.log(`Gespeichert in ${CONFIG.logFile}`);
    console.log(`Naechste Abfrage in ${CONFIG.intervalMs / 60000} Minuten...`);
  }

  await abfrage();
  setInterval(abfrage, CONFIG.intervalMs);
}

run().catch((err) => {
  console.error("Fataler Fehler:", err);
  process.exit(1);
});
