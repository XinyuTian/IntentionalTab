/* global chrome */

(function intentionalTabBar() {
  if (window.__intentionalTabBarInjected) return;
  window.__intentionalTabBarInjected = true;

  function canonicalHost(hostname) {
    return String(hostname || "")
      .toLowerCase()
      .replace(/^www\./, "");
  }

  function siteHostKeys(sites) {
    if (!Array.isArray(sites)) return [];
    const keys = [];
    for (const s of sites) {
      if (typeof s === "string") {
        const h = canonicalHost(s);
        if (h) keys.push(h);
      } else if (s && typeof s === "object" && "host" in s) {
        const h = canonicalHost(String(s.host || ""));
        if (h) keys.push(h);
      }
    }
    return keys;
  }

  function managedKeyForHostname(hostname, managedSites) {
    const c = canonicalHost(hostname);
    const list = siteHostKeys(managedSites || []);
    for (const h of list) {
      if (c === h) return h;
      if (c.endsWith(`.${h}`)) return h;
    }
    return null;
  }

  const REASON_MAX = 80;
  let hostEl = null;
  let shadow = null;
  let textEl = null;
  let timeEl = null;
  let dismissed = false;

  function truncate(text, max) {
    const t = (text || "").trim();
    if (t.length <= max) return t;
    return t.slice(0, max - 1) + "…";
  }

  function minutesLeft(endTime) {
    const ms = endTime - Date.now();
    if (ms <= 0) return 0;
    return Math.ceil(ms / 60000);
  }

  function removeBar() {
    if (hostEl && hostEl.parentNode) hostEl.parentNode.removeChild(hostEl);
    hostEl = null;
    shadow = null;
    textEl = null;
    timeEl = null;
  }

  function buildBar() {
    removeBar();
    hostEl = document.createElement("div");
    hostEl.id = "intentional-tab-bar-host";
    shadow = hostEl.attachShadow({ mode: "closed" });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .wrap {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          z-index: 2147483646;
          min-height: 40px;
          box-sizing: border-box;
          display: flex;
          align-items: center;
          gap: 0.65rem;
          padding: 0.35rem 0.65rem;
          font: 13px/1.35 system-ui, -apple-system, Segoe UI, sans-serif;
          color: #1a202c;
          background: #e6fffa;
          border-bottom: 1px solid #81e6d9;
          box-shadow: 0 1px 3px rgba(0,0,0,0.08);
        }
        .brand { font-weight: 700; color: #234e52; flex: 0 0 auto; }
        .text { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .time { font-weight: 600; flex: 0 0 auto; color: #2c7a7b; }
        button.close {
          all: unset;
          cursor: pointer;
          font-size: 18px;
          line-height: 1;
          padding: 0 0.25rem;
          color: #234e52;
          flex: 0 0 auto;
        }
        button.close:hover { color: #000; }
      </style>
      <div class="wrap" part="wrap">
        <span class="brand">IntentionalTab</span>
        <span class="text"></span>
        <span class="time"></span>
        <button type="button" class="close" aria-label="Dismiss reminder">&times;</button>
      </div>
    `;
    textEl = shadow.querySelector(".text");
    timeEl = shadow.querySelector(".time");
    shadow.querySelector("button.close").addEventListener("click", () => {
      dismissed = true;
      removeBar();
    });
    document.documentElement.appendChild(hostEl);
  }

  async function tick() {
    if (dismissed) return;
    const { sessionsByHost, managedSites } = await chrome.storage.local.get([
      "sessionsByHost",
      "managedSites",
    ]);
    const key = managedKeyForHostname(window.location.hostname, managedSites || []);
    if (!key) {
      removeBar();
      return;
    }
    const session = sessionsByHost?.[key];
    if (!session || session.endTime <= Date.now()) {
      removeBar();
      return;
    }
    if (!hostEl) buildBar();
    const left = minutesLeft(session.endTime);
    const reason = truncate(session.reason || "", REASON_MAX);
    textEl.textContent = reason || "(no reason)";
    timeEl.textContent = `${left}m left`;
  }

  tick().catch(console.error);
  const interval = setInterval(() => {
    tick().catch(console.error);
  }, 10000);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.sessionsByHost || changes.managedSites) tick().catch(console.error);
  });

  window.addEventListener("beforeunload", () => clearInterval(interval));
})();
