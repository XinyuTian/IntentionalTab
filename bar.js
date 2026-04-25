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

  let hostEl = null;
  let shadow = null;
  let timeEl = null;
  let dismissed = false;

  function minutesLeft(endTime) {
    const ms = endTime - Date.now();
    if (ms <= 0) return 0;
    return Math.ceil(ms / 60000);
  }

  function removeBar() {
    if (hostEl && hostEl.parentNode) hostEl.parentNode.removeChild(hostEl);
    hostEl = null;
    shadow = null;
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
          bottom: max(12px, env(safe-area-inset-bottom, 0px));
          right: max(12px, env(safe-area-inset-right, 0px));
          left: auto;
          top: auto;
          z-index: 2147483646;
          box-sizing: border-box;
          display: flex;
          align-items: center;
          justify-content: center;
          min-width: 5rem;
          padding: 0.6rem 0.8rem 0.6rem 0.65rem;
          font: 600 1.1rem/1.25 system-ui, -apple-system, Segoe UI, sans-serif;
          color: #234e52;
          background: #e6fffa;
          border: 1px solid #81e6d9;
          border-radius: 999px;
          box-shadow: 0 3px 14px rgba(0, 0, 0, 0.12);
        }
        .time {
          font-weight: 700;
          font-size: 1.35rem;
          color: #2c7a7b;
          letter-spacing: -0.02em;
        }
        button.close {
          all: unset;
          cursor: pointer;
          font-size: 0.95rem;
          line-height: 1;
          margin-left: 0.4rem;
          padding: 0.2rem 0.2rem;
          color: #4a5568;
          border-radius: 4px;
          opacity: 0.75;
        }
        button.close:hover {
          color: #1a202c;
          opacity: 1;
          background: rgba(0, 0, 0, 0.06);
        }
      </style>
      <div class="wrap" part="wrap">
        <span class="time" aria-live="polite"></span>
        <button type="button" class="close" aria-label="Hide timer (session still runs)">&times;</button>
      </div>
    `;
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
    if (!timeEl) return;
    const left = minutesLeft(session.endTime);
    timeEl.textContent = `${left}m left`;
    const wrap = /** @type {HTMLElement | null} */ (timeEl.closest(".wrap"));
    if (wrap) {
      const r = (session.reason || "").trim();
      wrap.title = r ? `Reason: ${r}` : "";
    }
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
