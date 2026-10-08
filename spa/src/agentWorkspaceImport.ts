import type { AgentWorkspaceFileContent } from "./api";
import type { ConfigVaultFile } from "./configVaultCrypto";

export const AGENT_WORKSPACE_MAX_FILE_BYTES = 5 << 20;

const AGENT_WORKSPACE_SENSITIVE_BASENAME_PATTERN = /^(?:credentials?|secrets?|cookies?|tokens?|auth(?:entication)?)(?:\.(?:json|jsonl|ya?ml|toml|ini|conf|plist|db|sqlite))?$/i;
const AGENT_WORKSPACE_SENSITIVE_PATH_PATTERN = /(?:^|\/)(?:settings\.local(?:\..*)?|config\.local(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)|.*\.(?:pem|key|p12|pfx))$/i;
const AGENT_WORKSPACE_SENSITIVE_CONTENT_PATTERNS = [
  /["'`]?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|oauth[_-]?secret|password|authorization|private[_-]?key|cookie|session[_-]?token)["'`]?\s*[:=]\s*["'`]?[-A-Za-z0-9_./+=:@$]{12,}/i,
  /\b(?:bearer|basic)\s+[-A-Za-z0-9._~+/=]{20,}/i,
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/i,
  /\b(?:sk-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AIza[A-Za-z0-9_-]{30,})\b/,
];

export type AgentWorkspaceFilteredFile = ConfigVaultFile & {
  reason: "sensitive_path" | "sensitive_content";
};

function isSensitiveExampleValue(value: string) {
  const normalized = value.trim().replace(/^['"`]|['"`]$/g, "").replace(/[;,]+$/, "");
  return /^(?:process\.env(?:\.[\w.]+)?|env\.[\w.]+|os\.environ(?:\.get)?|this\.env\.[\w.]+|config(?:\.[\w.]+)+|var\.[\w.]+|vapidKeys\.[\w.]+|request\.[\w.]+|req\.[\w.]+)$/i.test(normalized)
    || /^SecretsStoreSecret$/i.test(normalized)
    || /^(?:your|example|sample|replace|test|dummy|fake|redacted|change[-_ ]?me|xxxxx)(?:[-_ ].*)?$/i.test(normalized)
    || /^local[-_ ]dev(?:[-_ ].*)?$/i.test(normalized)
    || /^sk[-_](?:live|test)[-_]abc123(?:\.\.\.)?$/i.test(normalized)
    || /^(?:<[^>]+>|cookie[-_ ]consent|consent[-_ ]cookie|(?:zaraz[-_ ]?)?consent[-_ ]cookie)$/i.test(normalized);
}

function containsAgentWorkspaceSensitiveContent(text: string) {
  for (const pattern of AGENT_WORKSPACE_SENSITIVE_CONTENT_PATTERNS) {
    const globalPattern = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
    for (const match of text.matchAll(globalPattern)) {
      const valueStart = match[0].search(/[:=]/);
      if (valueStart >= 0 && isSensitiveExampleValue(match[0].slice(valueStart + 1))) continue;
      return true;
    }
  }
  return false;
}

const AGENT_WORKSPACE_SOURCE_ROOTS = [
  ".claude/agents", ".claude/commands", ".claude/skills", ".claude/hooks", ".claude/rules",
  ".codex/skills", ".codex/prompts", ".codex/rules",
  ".pi/agent/skills", ".pi/agent/prompts", ".pi/agent/extensions", ".pi/agent/themes",
  ".agents/skills",
  ".config/opencode/agent", ".config/opencode/agents", ".config/opencode/command", ".config/opencode/commands",
  ".config/opencode/skill", ".config/opencode/skills", ".config/opencode/plugin", ".config/opencode/plugins", ".config/opencode/tools",
  ".opencode/agent", ".opencode/agents", ".opencode/command", ".opencode/commands", ".opencode/skill", ".opencode/skills", ".opencode/plugin", ".opencode/plugins", ".opencode/tools",
  ".config/claude/skills", ".config/codex/skills", ".config/pi/agent/skills",
  ".openclaw/skills", ".hermes/skills", ".moltbot/skills", ".config/openclaw/skills", ".config/hermes/skills", ".config/moltbot/skills",
  ".gemini/commands", ".gemini/skills", ".cursor/rules", ".windsurf/rules", ".continue/rules",
];
const AGENT_WORKSPACE_SOURCE_FILES = new Set(["agents.md", "claude.md", "gemini.md"]);

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export function isAgentWorkspaceSourcePath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  if (AGENT_WORKSPACE_SOURCE_FILES.has(normalized)) return true;
  return AGENT_WORKSPACE_SOURCE_ROOTS.some((root) => normalized === root || normalized.startsWith(`${root}/`));
}

export function configFilesToAgentWorkspaceImport(files: ConfigVaultFile[]) {
  if (files.length === 0) throw new Error("no agent files found");
  return files.map((file) => {
    if (file.bytes.byteLength > AGENT_WORKSPACE_MAX_FILE_BYTES) throw new Error(`file too large: ${file.path}`);
    return { path: file.path, contentBase64: bytesToBase64(file.bytes) };
  });
}

export function filterAgentWorkspaceSensitiveFiles(files: ConfigVaultFile[]) {
  const safeFiles: ConfigVaultFile[] = [];
  const filteredFiles: AgentWorkspaceFilteredFile[] = [];
  for (const file of files) {
    const path = file.path.replaceAll("\\", "/");
    const basename = path.slice(path.lastIndexOf("/") + 1);
    const envName = basename.startsWith(".env.") ? basename.slice(5).toLowerCase() : "";
    const sensitiveEnv = basename === ".env" || (envName !== "" && !["example", "sample", "template", "defaults"].includes(envName));
    if (sensitiveEnv || AGENT_WORKSPACE_SENSITIVE_BASENAME_PATTERN.test(basename) || AGENT_WORKSPACE_SENSITIVE_PATH_PATTERN.test(path)) {
      filteredFiles.push({ ...file, reason: "sensitive_path" });
      continue;
    }
    const text = new TextDecoder().decode(file.bytes);
    if (containsAgentWorkspaceSensitiveContent(text)) {
      filteredFiles.push({ ...file, reason: "sensitive_content" });
      continue;
    }
    safeFiles.push(file);
  }
  return { safeFiles, filteredFiles };
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  return Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("");
}

export function agentWorkspaceImportPath(file: Pick<File, "name" | "webkitRelativePath">) {
  const relativePath = file.webkitRelativePath;
  return relativePath ? relativePath.slice(relativePath.indexOf("/") + 1) : file.name;
}

export function isAgentWorkspaceReadme(path: string) {
  return path.toLowerCase() === "readme.md";
}

export async function prepareAgentWorkspaceImport(files: File[], readme?: AgentWorkspaceFileContent) {
  if (files.length === 0) throw new Error("no files selected");
  const paths = files.map(agentWorkspaceImportPath);
  const preserveReadme = readme && !paths.some(isAgentWorkspaceReadme);
  if (new Set(paths).size !== paths.length) throw new Error("duplicate file paths");
  if (files.some((file) => file.size > AGENT_WORKSPACE_MAX_FILE_BYTES)) throw new Error("file too large");
  const prepared = [];
  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    prepared.push({ path: agentWorkspaceImportPath(file), contentBase64: btoa(binary), mimeType: file.type || undefined });
  }
  if (preserveReadme) {
    prepared.push({ path: readme.path, contentBase64: readme.contentBase64, mimeType: readme.mimeType });
  }
  return prepared;
}

export function decodeAgentWorkspaceText(value: string) {
  return new TextDecoder().decode(Uint8Array.from(atob(value), (character) => character.charCodeAt(0)));
}
