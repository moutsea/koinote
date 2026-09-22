import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  getMediaPlatformSettings,
  MEDIA_PLATFORM_SETTINGS_QUERY_KEY,
  updateMediaPlatformSettings,
  type MediaPlatformSettings,
} from "../../api";
import { useI18n } from "../../i18n";

const DEFAULT_SETTINGS: MediaPlatformSettings = {
  wechatEnabled: true,
  zhihuEnabled: true,
  xEnabled: true,
};

export function MediaPlatformToggle({
  platform,
  label,
  description,
}: {
  platform: keyof MediaPlatformSettings;
  label: string;
  description: string;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const settingsQuery = useQuery({
    queryKey: MEDIA_PLATFORM_SETTINGS_QUERY_KEY,
    queryFn: getMediaPlatformSettings,
    retry: false,
  });
  const settings = settingsQuery.data?.settings ?? DEFAULT_SETTINGS;
  const mutation = useMutation({
    mutationFn: updateMediaPlatformSettings,
    onSuccess: (result) => {
      queryClient.setQueryData(MEDIA_PLATFORM_SETTINGS_QUERY_KEY, result);
      setError(null);
    },
    onError: (caught) => {
      const code = caught instanceof ApiError ? caught.code : undefined;
      setError((code && t.errors[code]) || t.settingsPage.mediaSettingsSaveFailed);
    },
  });

  const disabled = settingsQuery.isLoading || settingsQuery.isFetching || mutation.isPending;
  const enabled = settings[platform];

  return (
    <div className="mt-5">
      <label className="flex cursor-pointer items-center gap-3">
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{label}</span>
          <span className="mt-0.5 block text-xs leading-5 text-neutral-500 dark:text-neutral-400">{description}</span>
        </span>
        <input
          type="checkbox"
          checked={enabled}
          disabled={disabled || settingsQuery.isError}
          onChange={() => {
            setError(null);
            mutation.mutate({ ...settings, [platform]: !enabled });
          }}
          className="h-4 w-4 shrink-0 accent-[var(--cinnabar)]"
          aria-label={label}
        />
        <span className="w-14 shrink-0 text-right text-xs text-neutral-500 dark:text-neutral-400">
          {enabled ? t.settingsPage.mediaEnabled : t.settingsPage.mediaDisabled}
        </span>
      </label>
      {settingsQuery.isLoading && <p className="mt-2 text-xs text-neutral-400">{t.settingsPage.mediaSettingsLoading}</p>}
      {settingsQuery.isError && <p className="mt-2 text-xs text-red-600 dark:text-red-400" role="alert">{t.settingsPage.mediaSettingsLoadFailed}</p>}
      {error && <p className="mt-2 text-xs text-red-600 dark:text-red-400" role="alert">{error}</p>}
    </div>
  );
}
