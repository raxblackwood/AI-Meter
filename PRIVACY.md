# AI Meter Connector - Privacy Policy

Last updated: 28 October 2026

AI Meter Connector is a browser extension that works with the AI Meter desktop app.
It shows you how much of your Claude plan's usage limits you have left.

## What it reads

While you are signed in to claude.ai in your browser, the extension reads, every 3 minutes:

- your Claude organization ID and account email, to tell your accounts apart;
- your plan's usage limits: the 5-hour and weekly percentages used and when they reset.

These are the same numbers shown on claude.ai under Settings > Usage.
The extension does not read your conversations, files, or anything else on claude.ai, and it does not read any other website.

## Where it goes

The extension sends this information only to the AI Meter app running on your own computer, at `http://127.0.0.1:4317`.
Nothing is sent to the developer or to any other server.
There is no analytics, advertising, or tracking.

## What it stores

The extension keeps your last-seen Claude email and the result of its last check in the browser's local extension storage, so its popup can show the connection status.
The AI Meter app stores the usage readings on your computer.
Removing the extension deletes its storage; deleting the app's `data` folder deletes the readings.

## Your sign-in

The extension uses the claude.ai sign-in that already exists in your browser.
It never sees or stores your password, and it does not copy your sign-in anywhere.

## Contact

Questions about this policy: colonistx@gmail.com
