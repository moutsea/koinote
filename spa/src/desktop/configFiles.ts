import { invoke } from "@tauri-apps/api/core";
import type { ConfigVaultFile } from "../configVaultCrypto";

type DesktopConfigFile = { path: string; bytes: number[] };

export async function desktopPickConfigFiles(): Promise<ConfigVaultFile[]> {
  const files = await invoke<DesktopConfigFile[]>("desktop_pick_config_files");
  return files.map((file) => ({ path: file.path, bytes: new Uint8Array(file.bytes) }));
}

export async function desktopScanConfigFiles(): Promise<ConfigVaultFile[]> {
  const files = await invoke<DesktopConfigFile[]>("desktop_scan_config_files");
  return files.map((file) => ({ path: file.path, bytes: new Uint8Array(file.bytes) }));
}

export async function desktopScanAgentWorkspaceFiles(): Promise<ConfigVaultFile[]> {
  const files = await invoke<DesktopConfigFile[]>("desktop_scan_agent_workspace_files");
  return files.map((file) => ({ path: file.path, bytes: new Uint8Array(file.bytes) }));
}

export async function desktopRestoreConfigFiles(files: ConfigVaultFile[], locale = "en"): Promise<number> {
  return invoke<number>("desktop_restore_config_files", {
    files: files.map((file) => ({ path: file.path, bytes: Array.from(file.bytes) })),
    locale,
  });
}

export async function desktopRestoreConfigFilesToHome(files: ConfigVaultFile[], locale = "en"): Promise<number> {
  return invoke<number>("desktop_restore_config_files_to_home", {
    files: files.map((file) => ({ path: file.path, bytes: Array.from(file.bytes) })),
    locale,
  });
}
