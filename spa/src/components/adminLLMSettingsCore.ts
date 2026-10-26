import { replaceEqualDeep } from "@tanstack/react-query";
import type { AdminLLMSetting } from "../api";

export type AdminLLMSettingsData = { settings: AdminLLMSetting[] };

// Query reads and writes share this merge rule. Even a response that cannot be
// aborted must never roll a channel back to an older server version.
export function mergeAdminLLMSettings(
  previous: AdminLLMSettingsData | undefined,
  incoming: AdminLLMSettingsData,
): AdminLLMSettingsData {
  return replaceEqualDeep(previous, {
    settings: incoming.settings.map((setting) => {
      const current = previous?.settings.find((value) => value.kind === setting.kind);
      return current && current.version > setting.version ? current : setting;
    }),
  });
}
