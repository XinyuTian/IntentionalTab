# IntentionalTab

IntentionalTab is a Chrome extension that adds a mindful gate before opening distracting sites.

When you visit a managed site:
- You must pass through a **gate** page and write a short reason.
- You choose a session length (normal mode), then the site opens.
- A small bottom-right timer shows minutes left.
- When time is up, the session tabs are closed automatically.

## Core behavior

- **Per-site budgets:** each managed site has separate daily budgets for weekday and weekend.
- **Global cap:** all managed sites share a total daily cap:
  - **Weekday:** 60 minutes
  - **Weekend:** 120 minutes
- **Normal session limit:** up to 30 minutes, and never more than remaining site/global budget.
- **Early close refund:** if you close all session tabs early, unused planned minutes are returned to your budget.

## AI review mode (optional)

The gate includes an **AI review** checkbox:
- If unchecked: behaves like normal budgeted sessions.
- If checked: AI validates your written reason.
  - If approved, you get an **extra 20 minutes** bonus added to the session.
  - The extra 20 minutes are **not deducted** from daily budget.
  - If rejected, you stay on the gate page with feedback.

## Local AI token setup

To use AI review, add your token in:

- `ai-token.local.json`

This file is git-ignored and should not be committed.

Example:

```json
{
  "aiBuilderToken": "YOUR_TOKEN_HERE"
}
```

## Install / reload

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** and select this folder
4. After code changes, click the extension's **Reload** icon

Click the extension toolbar icon to open settings.

## Project files

`manifest.json` · `background.js` · `shared.js` · `options.*` · `gate.*` · `bar.js` · `icons/`

## Notes

- Requires `<all_urls>` host permission to gate managed sites.
- Like any local browser extension, it cannot prevent bypass if a user disables the extension or switches browser/profile.
