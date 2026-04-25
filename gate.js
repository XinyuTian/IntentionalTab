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
const AI_REVIEW_GRANT_MINUTES = 20;
const AI_REVIEW_MODEL = "deepseek";
const AI_REVIEW_ENDPOINT = "https://space.ai-builders.com/backend/v1/chat/completions";
const AI_TOKEN_FILE = "ai-token.local.json";
const AI_REVIEW_SYSTEM_PROMPT =
  'You are a strict validator for productivity reasons to access distracting websites. Return JSON only: {"approved": boolean, "feedback": string}. Approve ONLY when the reason is specific, concrete, and clearly tied to productive intent with context (task + purpose). Reject vague reasons like "study", "work", "research", "just checking updates", or generic productivity statements.';

function pickRandom(arr) {
  if (!arr.length) return "";
  return arr[Math.floor(Math.random() * arr.length)];
}

/** @param {string[]} arr @param {string} avoid */
function pickRandomAvoid(arr, avoid) {
  if (!arr.length) return "";
  if (arr.length === 1) return arr[0];
  const pool = arr.filter((s) => s !== avoid);
  const use = pool.length ? pool : arr;
  return use[Math.floor(Math.random() * use.length)];
}

/**
 * @param {string[]} activities
 * @param {string} [prevSuggestion] prefer a different suggestion when possible
 */
function paintSparkle(activities, prevSuggestion) {
  encourageChip.textContent = pickRandom(ENCOURAGEMENT_CHIPS);
  encourageLead.textContent = pickRandom(ENCOURAGEMENT_LEADS);
  encourageSuggestion.textContent = pickRandomAvoid(activities, prevSuggestion || "");
}

const params = new URLSearchParams(window.location.search);
const returnParam = params.get("return") || "";

const encourageBox = document.getElementById("encourageBox");
const encourageChip = document.getElementById("encourageChip");
const targetLine = document.getElementById("targetLine");
const encourageLead = document.getElementById("encourageLead");
const encourageSuggestion = document.getElementById("encourageSuggestion");
const encourageRefresh = document.getElementById("encourageRefresh");
const form = document.getElementById("form");
const reasonEl = document.getElementById("reason");
const durationEl = document.getElementById("duration");
const quotaLine = document.getElementById("quotaLine");
const errorEl = document.getElementById("error");
const submitBtn = document.getElementById("submit");
const useAiReviewEl = document.getElementById("useAiReview");

function showError(msg) {
  errorEl.hidden = false;
  errorEl.textContent = msg;
}

function clearError() {
  errorEl.hidden = true;
  errorEl.textContent = "";
}

async function loadTokenFromLocalFile() {
  try {
    const url = chrome.runtime.getURL(AI_TOKEN_FILE);
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return "";
    const data = await res.json();
    return typeof data?.aiBuilderToken === "string" ? data.aiBuilderToken.trim() : "";
  } catch {
    return "";
  }
}

/** @param {string} text */
function parseAiJson(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      const parsed = JSON.parse(m[0]);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }
}

/** @param {string} reason */
async function evaluateReasonWithAI(reason) {
  const fileToken = await loadTokenFromLocalFile();
  const { aiBuilderToken, AI_BUILDER_TOKEN } = await chrome.storage.local.get([
    "aiBuilderToken",
    "AI_BUILDER_TOKEN",
  ]);
  const token =
    fileToken ||
    (typeof aiBuilderToken === "string" && aiBuilderToken.trim()
      ? aiBuilderToken.trim()
      : typeof AI_BUILDER_TOKEN === "string" && AI_BUILDER_TOKEN.trim()
        ? AI_BUILDER_TOKEN.trim()
        : "");

  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const res = await fetch(AI_REVIEW_ENDPOINT, {
      method: "POST",
      headers,
      signal: ctl.signal,
      body: JSON.stringify({
        model: AI_REVIEW_MODEL,
        temperature: 0.1,
        max_tokens: 220,
        messages: [
          { role: "system", content: AI_REVIEW_SYSTEM_PROMPT },
          {
            role: "user",
            content: `Reason to evaluate:\n${reason}\n\nRemember: return strict JSON only with keys approved and feedback.`,
          },
        ],
      }),
    });
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        throw new Error(
          "AI review needs an API token. Set `aiBuilderToken` in ai-token.local.json (preferred) or chrome.storage.local."
        );
      }
      throw new Error(`AI review failed (${res.status}).`);
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      throw new Error("AI review returned no content.");
    }
    const parsed = parseAiJson(content);
    if (!parsed) throw new Error("AI review returned invalid JSON.");
    return {
      approved: Boolean(parsed.approved),
      feedback:
        typeof parsed.feedback === "string" && parsed.feedback.trim()
          ? parsed.feedback.trim()
          : parsed.approved
            ? "Approved."
            : "Not approved.",
    };
  } finally {
    clearTimeout(t);
  }
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

  const activities = [...shared.DEFAULT_ALTERNATIVE_ACTIVITIES];
  paintSparkle(activities, "");
  encourageRefresh.addEventListener("click", () => {
    paintSparkle(activities, encourageSuggestion.textContent);
  });

  const dayKind = limits.globalCap === 120 ? "weekend" : "weekday";
  quotaLine.textContent = `This site has about ${limits.siteLeft} of ${limits.dailyMinutes} minutes left for today. Overall you have about ${limits.globalLeft} of ${limits.globalCap} minutes left (${dayKind} cap). Each visit can be up to 30 minutes, or less if you’re running low.`;
  let noRegularTimeLeft = false;
  const refreshContinueState = () => {
    submitBtn.disabled = noRegularTimeLeft && !useAiReviewEl.checked;
  };
  useAiReviewEl.addEventListener("change", refreshContinueState);

  if (limits.maxSingleSession < 1 || durationEl.options.length === 0) {
    noRegularTimeLeft = true;
    refreshContinueState();
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
    const aiMode = Boolean(useAiReviewEl.checked);
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

    let duration = Number(durationEl.value);
    if (aiMode && (!Number.isFinite(duration) || duration < 1)) {
      // AI path can still proceed when regular budgeted minutes are exhausted.
      duration = 0;
    }
    if (!aiMode && (!Number.isFinite(duration) || duration < 1 || duration > lim.maxSingleSession)) {
      showError(`Pick between 1 and ${lim.maxSingleSession} minute(s) for this visit.`);
      return;
    }

    if (!aiMode && usage2 + duration > lim.globalCap) {
      showError("That would go past your overall daily cap—choose a shorter visit.");
      return;
    }

    const siteUsed = Math.max(0, Math.floor(Number(byHost[lim.hostKey]) || 0));
    if (!aiMode && siteUsed + duration > lim.dailyMinutes) {
      showError("That would go past this site’s daily budget—choose a shorter visit or raise its budget in settings.");
      return;
    }
    let bonusMinutes = 0;
    if (aiMode) {
      submitBtn.disabled = true;
      submitBtn.textContent = "AI checking reason...";
      try {
        const ai = await evaluateReasonWithAI(reason);
        if (!ai.approved) {
          showError(`AI review did not approve this reason: ${ai.feedback}`);
          return;
        }
        bonusMinutes = AI_REVIEW_GRANT_MINUTES;
      } catch (err) {
        showError(
          `AI review failed: ${err instanceof Error ? err.message : "unknown error"}`
        );
        return;
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = "Continue";
      }
    }

    const h = lim.hostKey;
    const tab = await chrome.tabs.getCurrent();
    const tabId = tab?.id ?? null;
    const tabIds = await collectTabIdsForHost(h, tabId);

    const startTime = Date.now();
    const grantedMinutes = duration + bonusMinutes;
    const endTime = startTime + grantedMinutes * 60 * 1000;
    const sessionsByHost = { ...(fresh.sessionsByHost || {}) };
    sessionsByHost[h] = {
      endTime,
      startTime,
      plannedMinutes: duration,
      bonusMinutes,
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
