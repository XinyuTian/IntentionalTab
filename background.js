import * as shared from "./shared.js";

const BAR_SCRIPT_ID = "intentional-tab-bar";

/** Serialize session mutations so close/focus/reopen races cannot resurrect a session. */
let sessionMutationChain = Promise.resolve();
/** @param {() => Promise<T>} fn @returns {Promise<T>} @template T */
function withSessionLock(fn) {
  const run = sessionMutationChain.then(fn, fn);
  sessionMutationChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/**
 * @param {number[]} tabIds
 * @returns {Promise<number[]>}
 */
async function filterLiveTabIds(tabIds) {
  if (!Array.isArray(tabIds) || tabIds.length === 0) return [];
  const live = [];
  for (const id of tabIds) {
    if (!Number.isFinite(id)) continue;
    try {
      await chrome.tabs.get(id);
      live.push(id);
    } catch {
      /* tab already closed */
    }
  }
  return live;
}

chrome.runtime.onInstalled.addListener(async () => {
  await shared.ensureDefaults();
  await syncAlarmsFromStorage();
  await registerBarScriptsFromStorage();
});

chrome.runtime.onStartup.addListener(async () => {
  await syncAlarmsFromStorage();
  await registerBarScriptsFromStorage();
});

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "ensureSessionAlarm") {
    ensureSessionAlarm(message.host, message.endTime)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (message?.type === "joinSessionIfLive") {
    joinSessionIfLive(message.host, message.tabId)
      .then((joined) => sendResponse({ ok: true, joined }))
      .catch((e) => sendResponse({ ok: false, error: String(e), joined: false }));
    return true;
  }
  if (message?.type === "recomputeSessionPause") {
    recomputeAllSessionPauses()
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (message?.type === "reregisterBarScripts") {
    registerBarScriptsFromStorage()
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  return false;
});

chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId !== 0) return;
  const { tabId, url } = details;
  if (!url || (!url.startsWith("http://") && !url.startsWith("https://"))) return;

  await shared.ensureDefaults();

  let hostname = "";
  try {
    hostname = new URL(url).hostname;
  } catch {
    return;
  }

  await withSessionLock(async () => {
    const { managedSites, sessionsByHost } = await chrome.storage.local.get([
      "managedSites",
      "sessionsByHost",
    ]);
    const list = Array.isArray(managedSites) ? managedSites : [];
    const key = shared.managedKeyForHostname(hostname, list);
    if (!key) return;

    const session = sessionsByHost?.[key];
    const now = Date.now();
    if (session && isSessionStillRunning(session, now)) {
      const prevIds = Array.isArray(session.tabIds) ? session.tabIds : [];
      const otherLive = await filterLiveTabIds(prevIds.filter((id) => id !== tabId));
      const selfStillTracked = prevIds.includes(tabId);
      // Continue only if another session tab is open, or this is the same tracked tab
      // navigating/reloading. A brand-new tab after all session tabs closed must re-gate.
      if (otherLive.length > 0 || selfStillTracked) {
        await attachTabToSessionUnlocked(key, tabId);
        return;
      }
      await finalizeSessionUsageAndClear(key, session);
      const next = { ...(sessionsByHost || {}) };
      delete next[key];
      await chrome.storage.local.set({ sessionsByHost: next });
    }

    const gateBase = chrome.runtime.getURL("gate.html");
    if (url.startsWith(gateBase.split("?")[0])) return;

    const gateUrl = `${gateBase}?return=${encodeURIComponent(url)}`;
    try {
      await chrome.tabs.update(tabId, { url: gateUrl });
    } catch (e) {
      console.warn("IntentionalTab redirect failed", e);
    }
  });
  await recomputeAllSessionPauses();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm.name.startsWith("session:")) return;
  const host = alarm.name.slice("session:".length);
  await expireSession(host, true);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await withSessionLock(async () => {
    const { sessionsByHost } = await chrome.storage.local.get("sessionsByHost");
    if (!sessionsByHost || typeof sessionsByHost !== "object") return;
    const next = { ...sessionsByHost };
    let changed = false;
    for (const [h, s] of Object.entries(next)) {
      const prevIds = Array.isArray(s.tabIds) ? s.tabIds : [];
      const withoutRemoved = prevIds.filter((id) => id !== tabId);
      const liveIds = await filterLiveTabIds(withoutRemoved);
      if (liveIds.length === prevIds.length && !prevIds.includes(tabId)) continue;
      changed = true;
      if (liveIds.length === 0) {
        await finalizeSessionUsageAndClear(h, s);
        delete next[h];
      } else {
        next[h] = { ...s, tabIds: liveIds };
      }
    }
    if (changed) await chrome.storage.local.set({ sessionsByHost: next });
  });
  await recomputeAllSessionPauses();
});

chrome.tabs.onActivated.addListener(() => {
  recomputeAllSessionPauses().catch(console.error);
});

chrome.windows.onFocusChanged.addListener(() => {
  recomputeAllSessionPauses().catch(console.error);
});

/**
 * @param {{ startTime?: number, endTime?: number, pausedAccumMs?: number, pauseStartedAt?: number }} session
 * @param {number} endMs
 */
function activeElapsedMs(session, closeTime) {
  const start = Number(session.startTime);
  if (!Number.isFinite(start)) return 0;
  let paused = Number(session.pausedAccumMs) || 0;
  if (session.pauseStartedAt != null) {
    paused += closeTime - Number(session.pauseStartedAt);
  }
  return Math.max(0, closeTime - start - paused);
}

/**
 * True if the last-focused Chrome window’s active tab belongs to this session.
 * (Time does not run when another window is focused or the session tab is not active there.)
 * @param {number[]} tabIds
 */
async function isSessionTabActiveInFocusedWindow(tabIds) {
  if (!Array.isArray(tabIds) || tabIds.length === 0) return false;
  const set = new Set(tabIds);
  try {
    const win = await chrome.windows.getLastFocused({ populate: true });
    const tabs = win.tabs || [];
    const active = tabs.find((t) => t.active);
    return active?.id != null && set.has(active.id);
  } catch {
    return false;
  }
}

/**
 * @param {string} host
 * @param {Record<string, unknown>} session
 * @param {number} now
 */
function isSessionStillRunning(session, now) {
  if (session.pauseStartedAt != null) {
    const fr = Number(session.frozenRemainingMs);
    if (Number.isFinite(fr) && fr > 0) return true;
  }
  return Number(session.endTime) > now;
}

async function stepSessionPauseState(host, session, now) {
  const next = { ...session };
  const tabIds = Array.isArray(session.tabIds) ? session.tabIds : [];
  const active = await isSessionTabActiveInFocusedWindow(tabIds);

  if (active) {
    if (next.pauseStartedAt != null) {
      const pauseStarted = Number(next.pauseStartedAt);
      const frozen = Number(next.frozenRemainingMs);
      const delta = now - pauseStarted;
      next.pausedAccumMs = (Number(next.pausedAccumMs) || 0) + delta;
      if (Number.isFinite(frozen) && frozen >= 0) {
        next.endTime = now + frozen;
      } else {
        next.endTime = (Number(next.endTime) || 0) + delta;
      }
      next.pauseStartedAt = null;
      next.frozenRemainingMs = null;
      await ensureSessionAlarm(host, Number(next.endTime));
    }
  } else if (tabIds.length > 0) {
    if (next.pauseStartedAt == null) {
      next.pauseStartedAt = now;
      next.frozenRemainingMs = Math.max(0, (Number(next.endTime) || 0) - now);
      try {
        await chrome.alarms.clear(`session:${host}`);
      } catch {
        /* ignore */
      }
    }
  }
  return next;
}

function sessionPauseFieldsChanged(before, after) {
  return (
    Number(before.endTime) !== Number(after.endTime) ||
    before.pauseStartedAt !== after.pauseStartedAt ||
    before.frozenRemainingMs !== after.frozenRemainingMs ||
    (Number(before.pausedAccumMs) || 0) !== (Number(after.pausedAccumMs) || 0)
  );
}

async function recomputeAllSessionPauses() {
  await withSessionLock(async () => {
    const { sessionsByHost } = await chrome.storage.local.get("sessionsByHost");
    if (!sessionsByHost || typeof sessionsByHost !== "object") return;
    const now = Date.now();
    const next = { ...sessionsByHost };
    let changed = false;
    for (const [host, s] of Object.entries(next)) {
      if (!s || typeof s !== "object" || !s.endTime) continue;
      const prevIds = Array.isArray(s.tabIds) ? s.tabIds : [];
      const liveIds = await filterLiveTabIds(prevIds);
      if (liveIds.length === 0) {
        await finalizeSessionUsageAndClear(host, s);
        delete next[host];
        changed = true;
        continue;
      }
      let current = s;
      if (liveIds.length !== prevIds.length) {
        current = { ...s, tabIds: liveIds };
        next[host] = current;
        changed = true;
      }
      if (!isSessionStillRunning(current, now)) continue;
      const updated = await stepSessionPauseState(host, current, now);
      if (sessionPauseFieldsChanged(current, updated)) {
        next[host] = updated;
        changed = true;
      }
    }
    if (changed) await chrome.storage.local.set({ sessionsByHost: next });
  });
}

/**
 * When the last tab for a session closes, refund minutes not yet "used" by wall
 * clock (vs the planned visit), then clear the session and alarm so the bar/timer stop.
 * @param {string} host
 * @param {{ endTime?: number, startTime?: number, plannedMinutes?: number, pausedAccumMs?: number, pauseStartedAt?: number, frozenRemainingMs?: number }} session
 */
async function finalizeSessionUsageAndClear(host, session) {
  const planned =
    session && Number.isFinite(Number(session.plannedMinutes))
      ? Math.max(0, Math.floor(Number(session.plannedMinutes)))
      : null;
  const startTime =
    session && Number.isFinite(Number(session.startTime)) ? Number(session.startTime) : null;
  const endTime = session && Number.isFinite(Number(session.endTime)) ? Number(session.endTime) : 0;

  let refund = 0;
  if (planned != null && startTime != null && endTime > 0) {
    const closeTime = Date.now();
    const activeMs = activeElapsedMs(session, closeTime);
    const actualUsed = Math.min(planned, Math.max(0, Math.ceil(activeMs / 60000)));
    refund = Math.max(0, planned - actualUsed);
  }

  try {
    await chrome.alarms.clear(`session:${host}`);
  } catch {
    /* ignore */
  }

  const { dailyUsageByHost, dailyUsageDate } = await chrome.storage.local.get([
    "dailyUsageByHost",
    "dailyUsageDate",
  ]);
  const today = shared.localDateKey();
  const patch = {};
  if (refund > 0 && typeof dailyUsageDate === "string" && dailyUsageDate === today) {
    const byHost =
      dailyUsageByHost && typeof dailyUsageByHost === "object" ? { ...dailyUsageByHost } : {};
    const curHost = Math.max(0, Math.floor(Number(byHost[host]) || 0) - refund);
    if (curHost <= 0) delete byHost[host];
    else byHost[host] = curHost;
    patch.dailyUsageByHost = byHost;
  }
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
}

/**
 * @param {string} host
 * @param {boolean} closeTabs
 */
async function expireSession(host, closeTabs) {
  const { sessionsByHost } = await chrome.storage.local.get("sessionsByHost");
  const session = sessionsByHost?.[host];
  if (!session) {
    try {
      await chrome.alarms.clear(`session:${host}`);
    } catch {
      /* ignore */
    }
    return;
  }
  const tabIdsToClose = closeTabs && Array.isArray(session.tabIds) ? [...session.tabIds] : [];
  const next = { ...(sessionsByHost || {}) };
  delete next[host];
  await chrome.storage.local.set({ sessionsByHost: next });
  try {
    await chrome.alarms.clear(`session:${host}`);
  } catch {
    /* ignore */
  }
  for (const id of tabIdsToClose) {
    try {
      await chrome.tabs.remove(id);
    } catch {
      /* already closed */
    }
  }
}

/** Caller must already hold the session lock. */
async function attachTabToSessionUnlocked(host, tabId) {
  const { sessionsByHost } = await chrome.storage.local.get("sessionsByHost");
  const session = sessionsByHost?.[host];
  const now = Date.now();
  if (!session || !isSessionStillRunning(session, now)) return;
  const prevIds = Array.isArray(session.tabIds) ? session.tabIds : [];
  const liveIds = await filterLiveTabIds(prevIds);
  const tabIds = Array.from(new Set([...liveIds, tabId]));
  await chrome.storage.local.set({
    sessionsByHost: {
      ...(sessionsByHost || {}),
      [host]: { ...session, tabIds },
    },
  });
}

async function attachTabToSession(host, tabId) {
  await withSessionLock(() => attachTabToSessionUnlocked(host, tabId));
  await recomputeAllSessionPauses();
}

/**
 * If this host already has a live session with at least one open tab, attach `tabId`
 * and return true. Orphaned sessions (no live tabs) are finalized so a new visit can start.
 * Prevents a second gate submit from overwriting the session and double-charging budget.
 * @param {string} host
 * @param {number | null | undefined} tabId
 * @returns {Promise<boolean>}
 */
async function joinSessionIfLive(host, tabId) {
  const joined = await withSessionLock(async () => {
    if (typeof host !== "string" || !host) return false;
    const { sessionsByHost } = await chrome.storage.local.get("sessionsByHost");
    const session = sessionsByHost?.[host];
    const now = Date.now();
    if (!session || !isSessionStillRunning(session, now)) return false;

    const prevIds = Array.isArray(session.tabIds) ? session.tabIds : [];
    const liveIds = await filterLiveTabIds(prevIds);
    if (liveIds.length === 0) {
      await finalizeSessionUsageAndClear(host, session);
      const next = { ...(sessionsByHost || {}) };
      delete next[host];
      await chrome.storage.local.set({ sessionsByHost: next });
      return false;
    }

    if (tabId != null && Number.isFinite(tabId)) {
      await attachTabToSessionUnlocked(host, tabId);
    }
    return true;
  });
  if (joined) await recomputeAllSessionPauses();
  return joined;
}

/** @param {string} host @param {number} endTime */
async function ensureSessionAlarm(host, endTime) {
  const when = Math.max(endTime, Date.now() + 500);
  await chrome.alarms.create(`session:${host}`, { when });
}

async function syncAlarmsFromStorage() {
  await recomputeAllSessionPauses();
  const { sessionsByHost } = await chrome.storage.local.get("sessionsByHost");
  const now = Date.now();
  for (const [host, session] of Object.entries(sessionsByHost || {})) {
    if (!session?.endTime) continue;
    if (!isSessionStillRunning(session, now)) {
      await expireSession(host, true);
      continue;
    }
    if (session.pauseStartedAt == null) {
      await ensureSessionAlarm(host, session.endTime);
    } else {
      try {
        await chrome.alarms.clear(`session:${host}`);
      } catch {
        /* ignore */
      }
    }
  }
}

async function registerBarScriptsFromStorage() {
  const { managedSites } = await chrome.storage.local.get("managedSites");
  const hosts = shared.siteHostKeys(Array.isArray(managedSites) ? managedSites : []);
  const matches = shared.matchesForHosts(hosts);

  try {
    await chrome.scripting.unregisterContentScripts({ ids: [BAR_SCRIPT_ID] });
  } catch {
    /* not registered */
  }

  if (matches.length === 0) return;

  await chrome.scripting.registerContentScripts([
    {
      id: BAR_SCRIPT_ID,
      matches,
      js: ["bar.js"],
      runAt: "document_idle",
    },
  ]);
}
