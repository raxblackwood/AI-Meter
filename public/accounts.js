// Shared by the server (validation) and the browser (rendering).
// `feed` says where automatic readings come from:
//   "statusline"  Claude Code's status line (statusline.js)
//   "antigravity" the local Antigravity language server, matched to the account by email
// Every account can also be logged by hand.
export const ACCOUNTS = [
  { id: "claude", name: "Claude Code", plan: "Claude Pro", feed: "statusline" },
  { id: "ag1", name: "Antigravity 1", plan: "Google AI Pro", feed: "antigravity" },
  { id: "ag2", name: "Antigravity 2", plan: "Google AI Pro", feed: "antigravity" },
  { id: "ag3", name: "Antigravity 3", plan: "Google AI Pro", feed: "antigravity" },
];

export const ACCOUNT_IDS = new Set(ACCOUNTS.map((a) => a.id));
export const ANTIGRAVITY_IDS = ACCOUNTS.filter((a) => a.feed === "antigravity").map((a) => a.id);
