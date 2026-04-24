import * as shared from "./shared.js";

/**
 * @param {string} h managed host key (apex)
 * @param {number | null | undefined} gateTabId
 */
async function collectTabIdsForHost(h, gateTabId) {
  const patterns = [
    `https://${h}/*`,
    `http://${h}/*`,
    `https://*.${h}/*`,
    `http://*.${h}/*`,
  ];
  const ids = new Set();
  if (gateTabId != null) ids.add(gateTabId);
  for (const url of patterns) {
    try {
      const tabs = await chrome.tabs.query({ url });
      for (const t of tabs) {
        if (t.id != null) ids.add(t.id);
      }
    } catch {
      /* invalid pattern or permission */
    }
  }
  return [...ids];
}

const ENCOURAGEMENT_CHIPS = [
  "✨ Pick a sparkle",
  "🎯 Tiny win first",
  "☀️ Pause, then play",
  "🌈 Micro-adventure",
  "💫 One gentle detour",
];

const ENCOURAGEMENT_LEADS = [
  "Hey—before you jump in, how about a pocket-sized pause? You might love this:",
  "Quick vibe check: a two-minute detour can feel surprisingly good. Here’s inspiration:",
  "You’re in charge of the tempo. Try this little reset—it’s small but mighty:",
  "Plot twist: the internet can wait. Steal a moment for yourself with this:",
  "Low-key genius move: breathe, stretch, then scroll. Maybe start here:",
  "This site isn’t going anywhere. First, a splash of something nicer for you:",
  "Tiny pause → better brain. Roll the dice on this feel-good option:",
];

function pickRandom(arr) {
  if (!arr.length) return "";
  return arr[Math.floor(Math.random() * arr.length)];
}

const params = new URLSearchParams(window.location.search);
const returnParam = params.get("return") || "";

const encourageBox = document.getElementById("encourageBox");
const encourageChip = document.getElementById("encourageChip");
const targetLine = document.getElementById("targetLine");
const encourageLead = document.getElementById("encourageLead");
const encourageSuggestion = document.getElementById("encourageSuggestion");
const form = document.getElementById("form");
const reasonEl = document.getElementById("reason");
const durationEl = document.getElementById("duration");
const quotaLine = document.getElementById("quotaLine");
const errorEl = document.getElementById("error");
const submitBtn = document.getElementById("submit");

function showError(msg) {
  errorEl.hidden = false;
  errorEl.textContent = msg;
}

function clearError() {
  errorEl.hidden = true;
  errorEl.textContent = "";
}

/** @param {number} sessionMax min(30, site left, global left) */
function fillDurationSelect(sessionMax) {
  durationEl.innerHTML = "";
  const cap = Math.min(30, Math.max(0, Math.floor(sessionMax)));
  if (cap < 1) return;
  for (let m = 1; m <= cap; m++) {
    const opt = document.createElement("option");
    opt.value = String(m);
    opt.textContent = `${m} minute${m === 1 ? "" : "s"}`;
    if (m === Math.min(10, cap)) opt.selected = true;
    durationEl.appendChild(opt);
  }
}

async function init() {
  await shared.ensureDefaults();
  const data = await chrome.storage.local.get([
    "managedSites",
    "alternativeActivities",
    "dailyUsageMinutes",
    "dailyUsageDate",
    "dailyUsageByHost",
  ]);

  const managedSites = data.managedSites || [];
  const safeReturn = shared.validateReturnUrl(returnParam, managedSites);
  if (!safeReturn) {
    encourageBox.hidden = true;
    targetLine.textContent =
      "Missing or invalid return URL. Open a managed site from the address bar, or check your managed sites in settings.";
    form.hidden = true;
    return;
  }

  const slice = {
    dailyUsageMinutes: data.dailyUsageMinutes,
    dailyUsageDate: data.dailyUsageDate,
    dailyUsageByHost: data.dailyUsageByHost,
  };
  const limits = shared.getGateLimits(new URL(safeReturn).hostname, managedSites, slice);
  if (!limits) {
    encourageBox.hidden = true;
    targetLine.textContent = "Could not read settings for this site.";
    form.hidden = true;
    return;
  }

  fillDurationSelect(limits.maxSingleSession);

  targetLine.textContent = `You’re about to open: ${limits.hostKey}`;

  let activities = Array.isArray(data.alternativeActivities)
    ? data.alternativeActivities.map((s) => String(s).trim()).filter(Boolean)
    : [...shared.DEFAULT_ALTERNATIVE_ACTIVITIES];
  if (!activities.length) activities = [...shared.DEFAULT_ALTERNATIVE_ACTIVITIES];
  encourageChip.textContent = pickRandom(ENCOURAGEMENT_CHIPS);
  encourageLead.textContent = pickRandom(ENCOURAGEMENT_LEADS);
  encourageSuggestion.textContent = pickRandom(activities);

  const dayKind = limits.globalCap === 120 ? "weekend" : "weekday";
  quotaLine.textContent = `This site has about ${limits.siteLeft} of ${limits.dailyMinutes} minutes left for today. Overall you have about ${limits.globalLeft} of ${limits.globalCap} minutes left (${dayKind} cap). Each visit can be up to 30 minutes, or less if you’re running low.`;

  if (limits.maxSingleSession < 1 || durationEl.options.length === 0) {
    submitBtn.disabled = true;
    showError(
      limits.siteLeft < 1
        ? "This site’s daily budget is already used up. Come back tomorrow, or raise its budget in settings."
        : limits.globalLeft < 1
          ? "Your overall intentional minutes for today are used up (60 on weekdays, 120 on weekends). Tomorrow is a fresh start."
          : "Not enough time left for a visit right now."
    );
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearError();
    const reason = reasonEl.value.trim();
    if (!reason) {
      showError("Please add a short reason—you’ve got this.");
      return;
    }

    const fresh = await chrome.storage.local.get([
      "managedSites",
      "sessionsByHost",
      "dailyUsageMinutes",
      "dailyUsageDate",
      "dailyUsageByHost",
    ]);
    const sites = fresh.managedSites || [];
    const validated = shared.validateReturnUrl(returnParam, sites);
    if (!validated) {
      showError("That return URL isn’t allowed anymore.");
      return;
    }

    const today2 = shared.localDateKey();
    let usage2 = typeof fresh.dailyUsageMinutes === "number" ? fresh.dailyUsageMinutes : 0;
    let usageDate2 = typeof fresh.dailyUsageDate === "string" ? fresh.dailyUsageDate : today2;
    let byHost =
      fresh.dailyUsageByHost && typeof fresh.dailyUsageByHost === "object" ? { ...fresh.dailyUsageByHost } : {};
    if (usageDate2 !== today2) {
      usage2 = 0;
      byHost = {};
      usageDate2 = today2;
    }

    const lim = shared.getGateLimits(new URL(validated).hostname, sites, {
      dailyUsageMinutes: usage2,
      dailyUsageDate: usageDate2,
      dailyUsageByHost: byHost,
    });
    if (!lim) {
      showError("That site isn’t in your managed list.");
      return;
    }

    const duration = Number(durationEl.value);
    if (!Number.isFinite(duration) || duration < 1 || duration > lim.maxSingleSession) {
      showError(`Pick between 1 and ${lim.maxSingleSession} minute(s) for this visit.`);
      return;
    }

    if (usage2 + duration > lim.globalCap) {
      showError("That would go past your overall daily cap—choose a shorter visit.");
      return;
    }

    const siteUsed = Math.max(0, Math.floor(Number(byHost[lim.hostKey]) || 0));
    if (siteUsed + duration > lim.dailyMinutes) {
      showError("That would go past this site’s daily budget—choose a shorter visit or raise its budget in settings.");
      return;
    }

    const h = lim.hostKey;
    const tab = await chrome.tabs.getCurrent();
    const tabId = tab?.id ?? null;
    const tabIds = await collectTabIdsForHost(h, tabId);

    const endTime = Date.now() + duration * 60 * 1000;
    const sessionsByHost = { ...(fresh.sessionsByHost || {}) };
    sessionsByHost[h] = {
      endTime,
      reason,
      tabIds,
    };

    byHost[h] = siteUsed + duration;

    await chrome.storage.local.set({
      sessionsByHost,
      dailyUsageMinutes: usage2 + duration,
      dailyUsageDate: today2,
      dailyUsageByHost: byHost,
    });

    const alarmRes = await chrome.runtime.sendMessage({
      type: "ensureSessionAlarm",
      host: h,
      endTime,
    });
    if (!alarmRes?.ok) {
      showError(`Could not start your session timer: ${alarmRes?.error || "unknown"}`);
      return;
    }

    window.location.href = validated;
  });
}

init().catch((err) => {
  console.error(err);
  showError(String(err));
});
