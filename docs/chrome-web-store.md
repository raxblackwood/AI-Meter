# Publishing AI Usage Connector to the Chrome Web Store

This is the checklist and listing text for submitting `extension/` to the Chrome Web Store.
Edge Add-ons accepts the same zip.

## Before submitting

1. Load the extension unpacked and confirm a Claude reading reaches the app (see README).
2. Raise `version` in `extension/manifest.json` for every upload.
3. Build the zip:

   ```bash
   node scripts/pack-extension.mjs
   ```

   It writes `dist/ai-usage-connector-<version>.zip`.
4. Host `PRIVACY.md` at a public URL (the repository is private).
   A public GitHub Gist or a GitHub Pages page works.

## Developer account

- Register at https://chrome.google.com/webstore/devconsole (one-time USD 5 fee).
- Use the Google account you want shown as the publisher.

## Store listing

- **Name**: AI Usage Connector
- **Summary** (up to 132 characters): Sends your Claude plan usage (5-hour and weekly limits) to the AI Usage desktop app on your computer.
- **Category**: Productivity
- **Language**: English
- **Description**:

  > Shows how much of your Claude plan you have left, together with your other AI accounts, in the AI Usage desktop app.
  >
  > While you are signed in to claude.ai, the extension reads your 5-hour and weekly usage every few minutes, the same numbers as Settings > Usage, and sends them only to the AI Usage app on your own computer.
  > It uses your existing sign-in, so you never enter a password.
  >
  > - Works with any number of Claude accounts: install it in each browser profile.
  > - Reads only your usage limits, not your conversations.
  > - Sends nothing to the developer or anywhere else.
  >
  > Requires the AI Usage desktop app running on the same computer.

- **Icon**: `extension/icon-128.png`
- **Screenshots** (1280x800): the app with a Claude row, and the extension popup showing "Sending usage for ...".

## Privacy practices tab

- **Single purpose**: Send the user's own Claude plan usage limits to the AI Usage app on the same computer.
- **Permission justifications**:
  - `alarms`: re-read usage every 3 minutes.
  - `storage`: remember the last account email and the last check result for the popup.
  - Host `https://claude.ai/*`: read the usage limits and account email from the user's signed-in claude.ai session.
  - Host `http://127.0.0.1:4317/*`: send the readings to the AI Usage app on the user's own computer.
- **Remote code**: No.
- **Data usage**: tick only "Personally identifiable information" (the account email, used only to tell accounts apart).
  Usage percentages are not personal data; nothing else is collected.
  Certify that data is not sold, not used for unrelated purposes, and not used for creditworthiness.
  It is sent only to the user's own computer.
- **Privacy policy URL**: the public copy of `PRIVACY.md`.

## After approval

Put the store URL in `package.json` under `config.chromeWebStoreUrl`.
The app then shows an "Install from Chrome Web Store" button under Add account > Claude, with the Load unpacked steps as a fallback.
