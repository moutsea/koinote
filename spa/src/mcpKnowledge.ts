// Public MCP content shared by the browser and the edge renderer.
// Tool names and scopes are checked against the Go registrations in test:mcp.
export const MCP_ENDPOINT = "https://koinote.app/mcp";
export const MCP_CONFIG_SYNC_ENDPOINT = "https://koinote.app/api/config-sync/mcp";
export const MCP_CONNECTIONS = [
  { id: "documents", name: "koinote", endpoint: MCP_ENDPOINT },
  { id: "repositories", name: "koinote-agent", endpoint: MCP_ENDPOINT },
  { id: "configSync", name: "koinote-config-sync", endpoint: MCP_CONFIG_SYNC_ENDPOINT },
] as const;
export const MCP_TOKEN_SETUP = "export KOINOTE_MCP_TOKEN='knt_mcp_...'";

export type MCPToolGroup = {
  connection: "documents" | "repositories" | "configSync";
  kind: "read" | "write" | "external";
  scopes: readonly string[];
  tools: readonly string[];
};

export const MCP_TOOL_GROUPS: readonly MCPToolGroup[] = [
  {
    connection: "documents", kind: "read", scopes: ["read", "write", "publish"],
    tools: [
      "list_documents", "search_documents", "get_document", "list_document_versions",
      "get_document_version", "list_trashed_documents", "get_document_history_settings", "list_folders",
      "list_wechat_accounts", "get_wechat_geo_summary", "list_document_themes", "get_agent_credits",
      "get_document_outline", "get_document_context", "compare_document_versions", "find_text_in_document",
    ],
  },
  {
    connection: "documents", kind: "write", scopes: ["write"],
    tools: [
      "create_document", "append_to_document", "update_document", "restore_document_version",
      "trash_document", "restore_trashed_document", "update_document_history_settings", "create_folder",
      "rename_folder", "move_folder", "move_document", "batch_move_documents", "delete_folder",
      "update_document_metadata", "apply_text_patch",
    ],
  },
  { connection: "documents", kind: "write", scopes: ["write", "publish"], tools: ["update_wechat_geo_summary"] },
  { connection: "documents", kind: "external", scopes: ["write", "publish"], tools: ["generate_wechat_geo_summary"] },
  { connection: "documents", kind: "external", scopes: ["write"], tools: ["sync_document_to_feishu"] },
  { connection: "documents", kind: "external", scopes: ["publish"], tools: ["push_wechat_draft"] },
  {
    connection: "repositories", kind: "read", scopes: ["agent_read", "agent_write"],
    tools: [
      "list_agent_workspaces", "get_agent_workspace", "read_agent_workspace_file", "get_agent_workspace_prompt",
      "get_agent_workspace_storage", "list_agent_workspace_commits", "get_agent_workspace_commit", "read_agent_workspace_commit_file",
    ],
  },
  {
    connection: "repositories", kind: "write", scopes: ["agent_write"],
    tools: ["create_agent_workspace", "manage_agent_workspace", "update_agent_workspace", "restore_agent_workspace_commit"],
  },
  { connection: "configSync", kind: "read", scopes: ["knt_config_sync_…"], tools: ["get_config_sync_snapshot", "read_config_sync_envelope"] },
];

export const MCP_CLIENTS = [
  {
    id: "codex", page: "mcpCodex", name: "Codex", path: "/docs/mcp/codex",
    source: "https://developers.openai.com/codex/mcp/",
    blocks: [{ label: "~/.codex/config.toml", code: `[mcp_servers.koinote]
url = "${MCP_ENDPOINT}"
bearer_token_env_var = "KOINOTE_MCP_TOKEN"` }],
  },
  {
    id: "claude-code", page: "mcpClaudeCode", name: "Claude Code", path: "/docs/mcp/claude-code",
    source: "https://code.claude.com/docs/en/mcp",
    blocks: [{ label: ".mcp.json", code: `{
  "mcpServers": {
    "koinote": {
      "type": "http",
      "url": "${MCP_ENDPOINT}",
      "headers": { "Authorization": "Bearer \${KOINOTE_MCP_TOKEN}" }
    }
  }
}` }],
  },
  {
    id: "opencode", page: "mcpOpenCode", name: "OpenCode", path: "/docs/mcp/opencode",
    source: "https://opencode.ai/docs/mcp-servers/",
    blocks: [
      { label: "OpenCode V2 · opencode.json", code: `{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "koinote": {
        "type": "remote",
        "url": "${MCP_ENDPOINT}",
        "oauth": false,
        "headers": { "Authorization": "Bearer {env:KOINOTE_MCP_TOKEN}" }
      }
    }
  }
}` },
      { label: "OpenCode V1 · opencode.json", code: `{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "koinote": {
      "type": "remote",
      "url": "${MCP_ENDPOINT}",
      "oauth": false,
      "headers": { "Authorization": "Bearer {env:KOINOTE_MCP_TOKEN}" }
    }
  }
}` },
    ],
  },
  {
    id: "openclaw", page: "mcpOpenClaw", name: "OpenClaw", path: "/docs/mcp/openclaw",
    source: "https://docs.openclaw.ai/cli/mcp/registry",
    blocks: [{ label: "Bash", code: `openclaw mcp add koinote \\
  --url ${MCP_ENDPOINT} \\
  --transport streamable-http --no-probe \\
  --header 'Authorization=Bearer \${KOINOTE_MCP_TOKEN}'

openclaw mcp doctor koinote --probe` }],
  },
] as const;

export type MCPClientId = typeof MCP_CLIENTS[number]["id"];
export type MCPClientPage = typeof MCP_CLIENTS[number]["page"];
