import * as shared from "./shared.js";

const siteRowsEl = document.getElementById("siteRows");
const addSiteBtn = document.getElementById("addSite");
const activitiesEl = document.getElementById("activities");
const saveBtn = document.getElementById("save");
const statusEl = document.getElementById("status");
const capNoteEl = document.getElementById("capNote");

function parseLines(text) {
  return text
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

function flash(msg) {
  statusEl.hidden = false;
  statusEl.textContent = msg;
  setTimeout(() => {
    statusEl.hidden = true;
  }, 2800);
}

function lineToHost(line) {
  const s = line.trim();
  if (!s) return "";
  if (s.includes("://")) {
    try {
      return shared.canonicalHost(new URL(s).hostname);
    } catch {
      return "";
    }
  }
  const first = s.split("/")[0].split(":")[0];
  return shared.canonicalHost(first);
}

/**
 * @param {string} host
 * @param {number} dailyMinutes
 * @param {number | null} leftToday null when no host yet
 */
function addRow(host = "", dailyMinutes = shared.effectiveGlobalDailyMax(), leftToday = null) {
  const row = document.createElement("div");
  row.className = "site-row";
  const hostIn = document.createElement("input");
  hostIn.type = "text";
  hostIn.className = "site-host";
  hostIn.placeholder = "e.g. twitter.com";
  hostIn.value = host;
  const leftSpan = document.createElement("span");
  leftSpan.className = "site-left";
  leftSpan.textContent = leftToday == null ? "—" : `${leftToday} min`;
  const budgetIn = document.createElement("input");
  budgetIn.type = "number";
  budgetIn.className = "site-budget";
  budgetIn.min = "1";
  budgetIn.max = "480";
  budgetIn.step = "1";
  budgetIn.title = "Minutes this site may use per calendar day";
  budgetIn.value = String(Math.min(480, Math.max(1, Math.floor(dailyMinutes))));
  const rm = document.createElement("button");
  rm.type = "button";
  rm.className = "remove-row";
  rm.title = "Remove this row";
  rm.textContent = "Remove";
  rm.addEventListener("click", () => {
    row.remove();
    if (!siteRowsEl.querySelector(".site-row")) addRow();
  });
  row.append(hostIn, leftSpan, budgetIn, rm);
  siteRowsEl.appendChild(row);
}

function minutesLeftForHost(host, dailyMinutes, usageByHost, usageDate, today) {
  if (!host) return null;
  const used =
    usageDate === today ? Math.max(0, Math.floor(Number(usageByHost?.[host]) || 0)) : 0;
  return Math.max(0, dailyMinutes - used);
}

async function load() {
  await shared.ensureDefaults();
  const { managedSites, alternativeActivities, dailyUsageByHost, dailyUsageDate } =
    await chrome.storage.local.get([
      "managedSites",
      "alternativeActivities",
      "dailyUsageByHost",
      "dailyUsageDate",
    ]);
  const today = shared.localDateKey();
  const usageByHost =
    dailyUsageByHost && typeof dailyUsageByHost === "object" ? dailyUsageByHost : {};
  const usageDate = typeof dailyUsageDate === "string" ? dailyUsageDate : today;

  siteRowsEl.innerHTML = "";
  const sites = Array.isArray(managedSites) ? managedSites : [];
  if (sites.length === 0) {
    addRow();
  } else {
    for (const s of sites) {
      const norm = shared.normalizeSiteRow(s);
      if (!norm) continue;
      const left = minutesLeftForHost(norm.host, norm.dailyMinutes, usageByHost, usageDate, today);
      addRow(norm.host, norm.dailyMinutes, left);
    }
  }
  activitiesEl.value = (alternativeActivities || []).join("\n");

  const cap = shared.effectiveGlobalDailyMax();
  const isWeekend = cap === 120;
  capNoteEl.textContent = `Today’s overall cap is ${cap} minutes (${isWeekend ? "weekend" : "weekday"}). Per-site “left today” only counts time on that site; the gate also enforces the overall cap across all sites.`;
}

addSiteBtn.addEventListener("click", () => addRow());

saveBtn.addEventListener("click", async () => {
  const rows = Array.from(siteRowsEl.querySelectorAll(".site-row"));
  /** @type {Map<string, { host: string, dailyMinutes: number }>} */
  const byHost = new Map();
  for (const row of rows) {
    const hostRaw = /** @type {HTMLInputElement} */ (row.querySelector(".site-host")).value;
    const budgetRaw = /** @type {HTMLInputElement} */ (row.querySelector(".site-budget")).value;
    const host = lineToHost(hostRaw);
    if (!host) continue;
    const dailyMinutes = Math.min(
      480,
      Math.max(1, Math.floor(Number(budgetRaw)) || shared.effectiveGlobalDailyMax())
    );
    byHost.set(host, { host, dailyMinutes });
  }
  const managedSites = [...byHost.values()];

  const alternativeActivities = parseLines(activitiesEl.value);
  if (alternativeActivities.length === 0) {
    flash("Add at least one break idea (one line).");
    return;
  }

  await chrome.storage.local.set({
    managedSites,
    alternativeActivities,
  });

  const reg = await chrome.runtime.sendMessage({ type: "reregisterBarScripts" });
  if (!reg?.ok) {
    flash(`Saved, but bar script refresh failed: ${reg?.error || "unknown"}`);
    return;
  }
  flash("Saved.");
  await load();
});

load().catch(console.error);
