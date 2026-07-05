#!/usr/bin/env node
// Convert a Claude Code session .jsonl transcript into readable Markdown.
import { readFileSync, writeFileSync } from "fs";

const SRC = process.argv[2];
const OUT = process.argv[3] || "chat-export.md";
const MAX = 1200; // truncate long tool inputs/outputs

const trunc = (s) => {
  s = String(s ?? "");
  return s.length > MAX ? s.slice(0, MAX) + `\n…[truncated ${s.length - MAX} chars]` : s;
};

const lines = readFileSync(SRC, "utf8").split("\n").filter(Boolean);
const out = ["# Chat Export — Static Ads / DebtWise session", ""];

for (const line of lines) {
  let o;
  try { o = JSON.parse(line); } catch { continue; }
  if (o.type !== "user" && o.type !== "assistant") continue;
  const msg = o.message;
  if (!msg) continue;
  const role = msg.role === "assistant" ? "Assistant" : "User";
  const ts = o.timestamp ? ` _(${o.timestamp})_` : "";
  const parts = [];

  const content = msg.content;
  if (typeof content === "string") {
    parts.push(content);
  } else if (Array.isArray(content)) {
    for (const b of content) {
      if (b.type === "text") parts.push(b.text);
      else if (b.type === "thinking") continue; // internal reasoning, skip
      else if (b.type === "tool_use") {
        const input = trunc(JSON.stringify(b.input));
        parts.push(`\n> 🛠️ **tool_use** \`${b.name}\`\n> \`\`\`json\n> ${input.replace(/\n/g, "\n> ")}\n> \`\`\``);
      } else if (b.type === "tool_result") {
        let c = b.content;
        if (Array.isArray(c)) c = c.map((x) => (x.type === "text" ? x.text : `[${x.type}]`)).join("\n");
        parts.push(`\n> 📤 **tool_result**\n> \`\`\`\n> ${trunc(c).replace(/\n/g, "\n> ")}\n> \`\`\``);
      } else if (b.type === "image") {
        parts.push("\n> 🖼️ [image]");
      }
    }
  }

  const body = parts.join("\n").trim();
  if (!body) continue;
  out.push(`## ${role}${ts}`, "", body, "");
}

writeFileSync(OUT, out.join("\n"), "utf8");
console.log(`Wrote ${OUT} — ${out.length} blocks from ${lines.length} transcript lines.`);
