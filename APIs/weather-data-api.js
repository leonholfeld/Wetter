// Konfiguration
const CONFIG = {
    dwdStationIds: ["10400"],
    ubaStationCode: "",
    intervalMs: 5 * 60 * 1000,
    logFile: "./wetter_log.json",
};

import { writeFileSync, readFileSync, existsSync } from "fs";

const EINHEITEN = {
    temperature:        { faktor: 0.1, einheit: "C" },
    temperatureMin:     { faktor: 0.1, einheit: "C" },
    temperatureMax:     { faktor: 0.1, einheit: "C" },
    precipitationTotal: { faktor: 0.1, einheit: "mm/h" },
    windSpeed:          { faktor: 1,   einheit: "km/h" },
    windGust:           { faktor: 1,   einheit: "km/h" },
    sunshine:           { faktor: 0.1, einheit: "min" },
};

function umrechnen(key, raw) {
    if (raw == null) return null;
    const def = EINHEITEN[key];
    return def ? parseFloat((raw * def.faktor).toFixed(1)) : raw;
}

// DWD API (dwd.api.bund.dev)
const DWD_BASE = "https://app-prod-ws.warnwetter.de/v30";
const S3_BASE  = "https://s3.eu-central-1.amazonaws.com/app-prod-static.warnwetter.de/v16";

async function fetchDWDStation(ids) {
    const res  = await fetch(`${DWD_BASE}/stationOverviewExtended?stationIds=${ids.join(",")}`);
    if (!res.ok) throw new Error(`DWD HTTP ${res.status}`);
    const json = await res.json();

    const ergebnisse = {};
    for (const id of ids) {
        const raw = json[id];
        if (!raw) { ergebnisse[id] = { fehler: "Keine Daten" }; continue; }

        const f1    = raw.forecast1 ?? {};
        const start = f1.start ?? 0;
        const step  = f1.timeStep ?? 3600000;
        const idx   = Math.max(0, Math.floor((Date.now() - start) / step));
        const get   = (arr) => Array.isArray(arr) ? arr[Math.min(idx, arr.length - 1)] : null;

        ergebnisse[id] = {
            aktuell: {
                zeitpunkt:        new Date(start + idx * step).toLocaleString("de-DE"),
                temperatur_C:     umrechnen("temperature",        get(f1.temperature)),
                niederschlag_mmh: umrechnen("precipitationTotal", get(f1.precipitationTotal)),
                icon_code:        get(f1.icon),
            },
            tageswerte: (raw.days ?? []).slice(0, 3).map((d) => ({
                datum:           d.dayDate,
                temp_min_C:      umrechnen("temperatureMin", d.temperatureMin),
                temp_max_C:      umrechnen("temperatureMax", d.temperatureMax),
                wind_kmh:        umrechnen("windSpeed",      d.windSpeed),
                sonnenschein_min: umrechnen("sunshine",      d.sunshine),
            })),
            warnungen: (raw.warnings ?? []).map((w) => ({
                event: w.event, headline: w.headLine, level: w.level,
            })),
        };
    }
    return ergebnisse;
}

async function fetchDWDNowcast() {
    const res = await fetch(`${S3_BASE}/warnings_nowcast.json`);
    if (!res.ok) throw new Error(`DWD Nowcast HTTP ${res.status}`);
    const json = await res.json();
    return { anzahl: (json.warnings ?? []).length };
}

async function fetchDWDCrowd() {
    const res = await fetch(`${S3_BASE}/crowd_meldungen_overview_v2.json`);
    if (!res.ok) throw new Error(`DWD Crowd HTTP ${res.status}`);
    const json = await res.json();
    return { anzahl: (json.meldungen ?? []).length };
}

async function fetchDWD() {
    const [stationen, nowcast, crowd] = await Promise.allSettled([
        fetchDWDStation(CONFIG.dwdStationIds),
        fetchDWDNowcast(),
        fetchDWDCrowd(),
    ]);
    const val = (p) => p.status === "fulfilled" ? p.value : { fehler: p.reason?.message };
    return { stationen: val(stationen), nowcast: val(nowcast), crowd: val(crowd) };
}

// UBA API
async function fetchUBA() {
    const d    = new Date();
    const date = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
    const hour = d.getHours() === 0 ? 24 : d.getHours();

    const url = new URL("https://luftdaten.umweltbundesamt.de/api/air-data/v4/airquality/json");
    url.searchParams.set("date_from", date);
    url.searchParams.set("date_to",   date);
    url.searchParams.set("time_from", String(hour).padStart(2, "0"));
    url.searchParams.set("time_to",   String(hour).padStart(2, "0"));
    if (CONFIG.ubaStationCode) url.searchParams.set("station", CONFIG.ubaStationCode);

    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`UBA HTTP ${res.status}`);
    const json = await res.json();

    const stationen = [];
    for (const [code, schadstoffe] of Object.entries(json.data ?? {})) {
        const messwerte = {};
        for (const [s, werte] of Object.entries(schadstoffe))
            if (Array.isArray(werte) && werte.length) messwerte[s] = werte.at(-1);
        stationen.push({ code, messwerte });
        if (!CONFIG.ubaStationCode && stationen.length >= 8) break;
    }
    return { datum: date, stunde: hour, stationen };
}

// Logging
function appendLog(entry) {
    let log = [];
    if (existsSync(CONFIG.logFile)) {
        try { log = JSON.parse(readFileSync(CONFIG.logFile, "utf8")); } catch { log = []; }
    }
    log.push(entry);
    if (log.length > 1000) log = log.slice(-1000);
    writeFileSync(CONFIG.logFile, JSON.stringify(log, null, 2), "utf8");
}

// Hauptschleife
async function run() {
    console.log(`Wetter-Monitor gestartet (Intervall: ${CONFIG.intervalMs / 1000}s)`);

    async function abfrage() {
        const ts = new Date().toLocaleString("de-DE", { timeZone: "Europe/Berlin" });
        console.log(`\n=== ${ts} ===`);

        let dwd = null, uba = null;
        try { dwd = await fetchDWD(); console.log("DWD:", JSON.stringify(dwd, null, 2)); }
        catch (e) { console.error("DWD Fehler:", e.message); }

        try { uba = await fetchUBA(); console.log("UBA:", JSON.stringify(uba, null, 2)); }
        catch (e) { console.error("UBA Fehler:", e.message); }

        appendLog({ ts, dwd, uba });
        console.log(`Gespeichert -> ${CONFIG.logFile}`);
    }

    await abfrage();
    setInterval(abfrage, CONFIG.intervalMs);
}

run().catch(console.error);
