import { mcpKnowledge } from "../spa/src/i18n/mcpKnowledge";
import { MCP_CLIENTS, MCP_CONNECTIONS } from "../spa/src/mcpKnowledge";
import { LOCALES } from "../spa/src/i18n/types";

// A fixed public index. Never load account data or repository-internal documents.
const body = [
  "# Koinote",
  "",
  `> ${mcpKnowledge.en.positioning}`,
  "",
  "## Public pages",
  "",
  "- [Koinote](https://koinote.app/)",
  "- [Documentation](https://koinote.app/docs)",
  "- [MCP knowledge base](https://koinote.app/docs/mcp)",
  ...MCP_CLIENTS.map((client) => `- [${client.name} setup](https://koinote.app${client.path})`),
  "- [Version history](https://koinote.app/docs/version-history)",
  "- [Membership and pricing](https://koinote.app/pricing)",
  "- [Privacy](https://koinote.app/privacy)",
  "",
  "## MCP connections",
  "",
  "Transport is Streamable HTTP with Bearer credentials.",
  ...MCP_CONNECTIONS.map((connection) => `- ${connection.name} — ${connection.endpoint}\n  ${mcpKnowledge.en.connections[connection.id].description}`),
  "",
  "## External effects and credits",
  "",
  ...mcpKnowledge.en.effects.map((text) => `- ${text}`),
  ...LOCALES.flatMap((locale) => [
    "", `## ${locale}`, "",
    mcpKnowledge[locale].positioning, "",
    mcpKnowledge[locale].membership, "",
    mcpKnowledge[locale].limitsSummary,
  ]),
  "",
].join("\n");

export function llmsTxt(request: Request): Response {
  return new Response(request.method === "HEAD" ? null : body, {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" },
  });
}
