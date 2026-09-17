import type { AgentWorkspaceFileContent } from "./api";

const MAX_FILE_BYTES = 5 << 20;
const MAX_FILES = 200;

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
  if (files.length + (preserveReadme ? 1 : 0) > MAX_FILES) throw new Error("too many files");
  if (new Set(paths).size !== paths.length) throw new Error("duplicate file paths");
  if (files.some((file) => file.size > MAX_FILE_BYTES)) throw new Error("file too large");
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
