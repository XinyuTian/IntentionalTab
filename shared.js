/** @param {string} hostname */
export function canonicalHost(hostname) {
  return hostname.toLowerCase().replace(/^www\./, "");
}

/** @param {string} url */
export function canonicalHostFromUrl(url) {
  try {
    return canonicalHost(new URL(url).hostname);
  } catch {
    return "";
  }
}

/** @typedef {{ host: string, weekdayMinutes: number, weekendMinutes: number }} ManagedSite */

export const DEFAULT_SITE_WEEKDAY_MINUTES = 60;
export const DEFAULT_SITE_WEEKEND_MINUTES = 120;

/** @param {unknown} n */
function clampSiteBudgetMinutes(n) {
  return Math.min(480, Math.max(1, Math.floor(Number(n))));
}

/**
 * Global cap: 60 min Mon–Fri, 120 min Sat–Sun (local time).
 * @param {Date} [now]
 */
export function effectiveGlobalDailyMax(now = new Date()) {
  const d = now.getDay();
  const isWeekend = d === 0 || d === 6;
  return isWeekend ? 120 : 60;
}

/**
 * Per-site budget for the given calendar day (local), using weekday vs weekend limits.
 * @param {{ weekdayMinutes: number, weekendMinutes: number }} norm
 * @param {Date} [now]
 */
export function siteDailyBudgetMinutes(norm, now = new Date()) {
  const d = now.getDay();
  const isWeekend = d === 0 || d === 6;
  return isWeekend ? norm.weekendMinutes : norm.weekdayMinutes;
}

/** @param {unknown} row */
export function normalizeSiteRow(row) {
  if (typeof row === "string") {
    const host = canonicalHost(row);
    return host
      ? { host, weekdayMinutes: DEFAULT_SITE_WEEKDAY_MINUTES, weekendMinutes: DEFAULT_SITE_WEEKEND_MINUTES }
      : null;
  }
  if (!row || typeof row !== "object") return null;
  const host = canonicalHost(String(/** @type {{ host?: string }} */ (row).host || ""));
  if (!host) return null;
  const wk = "weekdayMinutes" in row && Number.isFinite(Number(/** @type {{ weekdayMinutes?: unknown }} */ (row).weekdayMinutes));
  const we = "weekendMinutes" in row && Number.isFinite(Number(/** @type {{ weekendMinutes?: unknown }} */ (row).weekendMinutes));
  if (wk && we) {
    return {
      host,
      weekdayMinutes: clampSiteBudgetMinutes(/** @type {{ weekdayMinutes: unknown }} */ (row).weekdayMinutes),
      weekendMinutes: clampSiteBudgetMinutes(/** @type {{ weekendMinutes: unknown }} */ (row).weekendMinutes),
    };
  }
  if ("dailyMinutes" in row && Number.isFinite(Number(/** @type {{ dailyMinutes?: unknown }} */ (row).dailyMinutes))) {
    const d = clampSiteBudgetMinutes(/** @type {{ dailyMinutes: unknown }} */ (row).dailyMinutes);
    return { host, weekdayMinutes: d, weekendMinutes: d };
  }
  if ("maxSessionMinutes" in row) {
    const m = Math.min(30, Math.max(1, Math.floor(Number(/** @type {{ maxSessionMinutes?: unknown }} */ (row).maxSessionMinutes) || 10)));
    const daily = Math.min(120, Math.max(15, m * 5));
    return { host, weekdayMinutes: daily, weekendMinutes: daily };
  }
  if (wk) {
    return {
      host,
      weekdayMinutes: clampSiteBudgetMinutes(/** @type {{ weekdayMinutes: unknown }} */ (row).weekdayMinutes),
      weekendMinutes: DEFAULT_SITE_WEEKEND_MINUTES,
    };
  }
  if (we) {
    return {
      host,
      weekdayMinutes: DEFAULT_SITE_WEEKDAY_MINUTES,
      weekendMinutes: clampSiteBudgetMinutes(/** @type {{ weekendMinutes: unknown }} */ (row).weekendMinutes),
    };
  }
  return {
    host,
    weekdayMinutes: DEFAULT_SITE_WEEKDAY_MINUTES,
    weekendMinutes: DEFAULT_SITE_WEEKEND_MINUTES,
  };
}

/** @param {unknown[]} sites */
export function siteHostKeys(sites) {
  if (!Array.isArray(sites)) return [];
  const keys = [];
  for (const s of sites) {
    if (typeof s === "string") {
      const h = canonicalHost(s);
      if (h) keys.push(h);
    } else if (s && typeof s === "object" && "host" in s) {
      const h = canonicalHost(String(/** @type {{ host: string }} */ (s).host || ""));
      if (h) keys.push(h);
    }
  }
  return keys;
}

/**
 * @param {string} hostname
 * @param {unknown[]} managedSites
 */
export function managedKeyForHostname(hostname, managedSites) {
  const c = canonicalHost(hostname);
  const list = siteHostKeys(managedSites || []);
  for (const h of list) {
    if (c === h) return h;
    if (c.endsWith(`.${h}`)) return h;
  }
  return null;
}

/**
 * @param {string} hostname
 * @param {unknown[]} managedSites
 */
export function getManagedSiteRow(hostname, managedSites) {
  const key = managedKeyForHostname(hostname, managedSites);
  if (!key) return null;
  const sites = Array.isArray(managedSites) ? managedSites : [];
  const raw = sites.find((s) => {
    if (!s || typeof s !== "object") return false;
    return canonicalHost(String(/** @type {{ host: string }} */ (s).host || "")) === key;
  });
  const norm = normalizeSiteRow(raw || { host: key });
  if (!norm) return null;
  return {
    hostKey: key,
    weekdayMinutes: norm.weekdayMinutes,
    weekendMinutes: norm.weekendMinutes,
  };
}

/**
 * @param {string} hostname
 * @param {unknown[]} managedSites
 * @param {{ dailyUsageMinutes?: number; dailyUsageByHost?: Record<string, number>; dailyUsageDate?: string }} slice
 */
export function getGateLimits(hostname, managedSites, slice) {
  const row = getManagedSiteRow(hostname, managedSites);
  if (!row) return null;
  const today = localDateKey();
  const usageDate = typeof slice.dailyUsageDate === "string" ? slice.dailyUsageDate : today;
  const globalCap = effectiveGlobalDailyMax();
  let globalUsed = typeof slice.dailyUsageMinutes === "number" ? slice.dailyUsageMinutes : 0;
  const byHost =
    slice.dailyUsageByHost && typeof slice.dailyUsageByHost === "object" ? slice.dailyUsageByHost : {};
  let siteUsed = 0;
  if (usageDate === today) {
    siteUsed = Math.max(0, Math.floor(Number(byHost[row.hostKey]) || 0));
  } else {
    globalUsed = 0;
    siteUsed = 0;
  }
  const siteCap = siteDailyBudgetMinutes(row);
  const siteLeft = Math.max(0, siteCap - siteUsed);
  const globalLeft = Math.max(0, globalCap - globalUsed);
  const maxSingleSession = Math.min(30, siteLeft, globalLeft);
  return {
    hostKey: row.hostKey,
    /** Today’s per-site budget cap (weekday vs weekend). */
    dailyMinutes: siteCap,
    weekdayMinutes: row.weekdayMinutes,
    weekendMinutes: row.weekendMinutes,
    siteLeft,
    globalLeft,
    globalCap,
    maxSingleSession,
  };
}

/**
 * @param {string} returnUrl
 * @param {unknown[]} managedSites
 */
export function validateReturnUrl(returnUrl, managedSites) {
  let u;
  try {
    u = new URL(returnUrl);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!managedKeyForHostname(u.hostname, managedSites)) return null;
  return u.href;
}

/** @param {string} text @param {number} max */
export function truncateReason(text, max) {
  const t = (text || "").trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1) + "…";
}

export function localDateKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export const DEFAULT_ALTERNATIVE_ACTIVITIES = [
  "📚 Read something nourishing for a few minutes",
  "🧘 Stretch your body slowly and breathe deeply",
  "🌳 Step outside for a short, easy walk",
  "💧 Pour a glass of water and rest your eyes on something green",
  "✨ Tidy one small spot—future you will smile",
  "📝 Write down three honest sentences in a journal",
  "💌 Send a kind message to someone you appreciate",
  "🫧 Take two minutes for calm, steady breathing",
  "🎨 Spend a little time on a hobby that lights you up",
];

export async function ensureDefaults() {
  const keys = [
    "managedSites",
    "managedHosts",
    "alternativeActivities",
    "dailyUsageMinutes",
    "dailyUsageDate",
    "dailyUsageByHost",
    "sessionsByHost",
  ];
  const cur = await chrome.storage.local.get(keys);
  const patch = {};
  const today = localDateKey();

  if (typeof cur.dailyUsageByHost !== "object" || cur.dailyUsageByHost === null) {
    patch.dailyUsageByHost = {};
  }

  if (cur.dailyUsageDate && cur.dailyUsageDate !== today) {
    patch.dailyUsageMinutes = 0;
    patch.dailyUsageByHost = {};
    patch.dailyUsageDate = today;
  }

  let managedSites = Array.isArray(cur.managedSites) ? cur.managedSites : [];
  if (managedSites.length === 0 && Array.isArray(cur.managedHosts) && cur.managedHosts.length > 0) {
    managedSites = cur.managedHosts
      .map((h) => ({
        host: canonicalHost(typeof h === "string" ? h : ""),
        weekdayMinutes: DEFAULT_SITE_WEEKDAY_MINUTES,
        weekendMinutes: DEFAULT_SITE_WEEKEND_MINUTES,
      }))
      .filter((s) => s.host);
    patch.managedSites = managedSites;
    await chrome.storage.local.remove("managedHosts");
  }
  if (!Array.isArray(cur.managedSites) && patch.managedSites === undefined) {
    patch.managedSites = [];
  }

  if (Array.isArray(cur.managedSites) && cur.managedSites.length > 0) {
    const normalized = cur.managedSites.map(normalizeSiteRow).filter(Boolean);
    const dirty =
      normalized.length !== cur.managedSites.length ||
      cur.managedSites.some((s) => {
        if (typeof s === "string") return true;
        if (!s || typeof s !== "object") return false;
        if ("maxSessionMinutes" in s || "dailyMinutes" in s) return true;
        return !("weekdayMinutes" in s) || !("weekendMinutes" in s);
      });
    if (dirty) patch.managedSites = normalized;
  }

  if (!Array.isArray(cur.alternativeActivities) || cur.alternativeActivities.length === 0) {
    patch.alternativeActivities = [...DEFAULT_ALTERNATIVE_ACTIVITIES];
  }
  if (typeof cur.dailyUsageMinutes !== "number") patch.dailyUsageMinutes = 0;
  if (typeof cur.dailyUsageDate !== "string") patch.dailyUsageDate = today;
  if (!cur.sessionsByHost || typeof cur.sessionsByHost !== "object") {
    patch.sessionsByHost = {};
  }

  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
  if (cur.dailyMaxMinutes !== undefined) {
    await chrome.storage.local.remove("dailyMaxMinutes");
  }
}

/** @param {string[]} hostKeys */
export function matchesForHosts(hostKeys) {
  const matches = [];
  for (const h of hostKeys) {
    const host = canonicalHost(h);
    if (!host) continue;
    matches.push(
      `http://${host}/*`,
      `https://${host}/*`,
      `http://*.${host}/*`,
      `https://*.${host}/*`
    );
  }
  return matches;
}
