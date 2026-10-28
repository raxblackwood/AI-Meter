// Shared by the server (validation) and the browser (rendering).
// `feed: "statusline"` means the account is updated automatically by statusline.js.
export const ACCOUNTS = [
  { id: "claude", name: "Claude Code", plan: "Claude Pro", feed: "statusline" },
  { id: "ag1", name: "Antigravity 1", plan: "Google AI Pro", feed: "manual" },
  { id: "ag2", name: "Antigravity 2", plan: "Google AI Pro", feed: "manual" },
  { id: "ag3", name: "Antigravity 3", plan: "Google AI Pro", feed: "manual" },
];

export const ACCOUNT_IDS = new Set(ACCOUNTS.map((a) => a.id));
