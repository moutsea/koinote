export type MediaPlatform = "wechat" | "zhihu" | "juejin";
export type MediaExportFormat = "rich-text" | "markdown";

export function mediaExportFormat(platform: MediaPlatform): MediaExportFormat {
  return platform === "juejin" ? "markdown" : "rich-text";
}

export function buildMediaMarkdown(title: string, body: string): string {
  const heading = title.trim().replace(/\s+/g, " ");
  if (!heading) return body;
  return `# ${heading}\n\n${body}`;
}
