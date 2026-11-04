// Reads OpenAI Codex account info from ~/.codex/auth.json on this machine.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function readCodexAuth() {
  const p = join(homedir(), ".codex", "auth.json");
  if (!existsSync(p)) return null;
  try {
    const data = JSON.parse(readFileSync(p, "utf8"));
    const idToken = data.tokens?.id_token;
    if (!idToken) return null;
    const parts = idToken.split(".");
    if (parts.length < 2) return null;
    const payload = JSON.parse(Buffer.from(parts[1], "base64").toString("utf8"));
    const email = payload.email || null;
    const planType = payload["https://api.openai.com/auth"]?.chatgpt_plan_type || "ChatGPT";
    const plan = `ChatGPT (${planType.charAt(0).toUpperCase() + planType.slice(1)})`;
    return {
      email,
      plan,
      accountId: data.tokens?.account_id || null,
      authMode: data.auth_mode || "chatgpt",
    };
  } catch {
    return null;
  }
}
