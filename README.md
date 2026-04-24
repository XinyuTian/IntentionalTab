# IntentionalTab

Chrome extension: listed sites open only after a **gate** (reason + minutes). You get a **top bar** reminder; when time’s up, the tab **closes**.

### Limits

| | Minutes (local time) |
|---|--:|
| **Mon–Fri** (all sites total) | 60 |
| **Sat–Sun** | 120 |
| **One visit** | up to 30, never more than what’s left |

Each **Options** row: **website**, **left today** (read-only), **budget/day** for that site.

### Install & reload

1. `chrome://extensions` → **Developer mode** → **Load unpacked** → this folder.
2. After code changes: hit the **reload** icon on the extension card.

**Toolbar icon** opens **settings**.

### Files

`manifest.json` · `background.js` · `shared.js` · `options.*` · `gate.*` · `bar.js` · `icons/`

Uses `<all_urls>`. Won’t stop someone from disabling the extension or using another browser.
