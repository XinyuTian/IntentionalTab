import * as shared from "./shared.js";

const BAR_SCRIPT_ID = "intentional-tab-bar";

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

  const { managedSites, sessionsByHost } = await chrome.storage.local.get([
    "managedSites",
    "sessionsByHost",
  ]);
  const list = Array.isArray(managedSites) ? managedSites : [];
  const key = shared.managedKeyForHostname(hostname, list);
  if (!key) return;

  const session = sessionsByHost?.[key];
  if (session && session.endTime > Date.now()) {
    await attachTabToSession(key, tabId);
    return;
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

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm.name.startsWith("session:")) return;
  const host = alarm.name.slice("session:".length);
  await expireSession(host, true);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { sessionsByHost } = await chrome.storage.local.get("sessionsByHost");
  if (!sessionsByHost || typeof sessionsByHost !== "object") return;
  let changed = false;
  const next = { ...sessionsByHost };
  for (const [h, s] of Object.entries(next)) {
    const ids = Array.isArray(s.tabIds) ? s.tabIds.filter((id) => id !== tabId) : [];
    if (ids.length !== (s.tabIds || []).length) {
      changed = true;
      next[h] = { ...s, tabIds: ids };
    }
  }
  if (changed) await chrome.storage.local.set({ sessionsByHost: next });
});

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
  if (closeTabs && Array.isArray(session.tabIds)) {
    for (const id of session.tabIds) {
      try {
        await chrome.tabs.remove(id);
      } catch {
        /* already closed */
      }
    }
  }
  const next = { ...(sessionsByHost || {}) };
  delete next[host];
  await chrome.storage.local.set({ sessionsByHost: next });
  try {
    await chrome.alarms.clear(`session:${host}`);
  } catch {
    /* ignore */
  }
}

async function attachTabToSession(host, tabId) {
  const { sessionsByHost } = await chrome.storage.local.get("sessionsByHost");
  const session = sessionsByHost?.[host];
  if (!session || session.endTime <= Date.now()) return;
  const tabIds = Array.from(new Set([...(session.tabIds || []), tabId]));
  await chrome.storage.local.set({
    sessionsByHost: {
      ...(sessionsByHost || {}),
      [host]: { ...session, tabIds },
    },
  });
}

/** @param {string} host @param {number} endTime */
async function ensureSessionAlarm(host, endTime) {
  const when = Math.max(endTime, Date.now() + 500);
  await chrome.alarms.create(`session:${host}`, { when });
}

async function syncAlarmsFromStorage() {
  const { sessionsByHost } = await chrome.storage.local.get("sessionsByHost");
  const now = Date.now();
  for (const [host, session] of Object.entries(sessionsByHost || {})) {
    if (!session?.endTime) continue;
    if (session.endTime <= now) {
      await expireSession(host, true);
    } else {
      await ensureSessionAlarm(host, session.endTime);
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
