import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSlug from "rehype-slug";
import rehypeSanitize from "rehype-sanitize";
import type { RootContent } from "hast";
import type { AgentWorkspaceFile } from "../api";
import { getPublicAgentRepositoryFile, type PublicAgentRepository } from "../agentRepositorySharing";
import { repositoryAnchorID, repositoryFileHref, repositoryResource } from "../agentRepositoryMarkdown";
import { useI18n } from "../i18n";
import { lowlight } from "./editor/lowlight";

function codeNodes(nodes: RootContent[]): ReactNode {
  return nodes.map((node, index) => node.type === "text" ? node.value : node.type === "element"
    ? <span key={index} className={Array.isArray(node.properties.className) ? node.properties.className.join(" ") : undefined}>{codeNodes(node.children)}</span> : null);
}

function HighlightedCode({ children, className }: { children?: ReactNode; className?: string }) {
  const language = /(?:^|\s)language-([\w+-]+)/.exec(className ?? "")?.[1];
  const highlighted = useMemo(() => {
    if (!language || typeof children !== "string" || children.length > 64 * 1024 || !lowlight.registered(language)) return children;
    try { return codeNodes(lowlight.highlight(language, children).children); } catch { return children; }
  }, [children, language]);
  return <code className={className}>{highlighted}</code>;
}

function SnapshotImage({ repository, file, alt, width, height }: { repository: PublicAgentRepository; file: AgentWorkspaceFile; alt?: string; width?: string | number; height?: string | number }) {
  const { t } = useI18n();
  const placeholder = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [url, setUrl] = useState<string>();
  const mime = file.mimeType.split(";")[0].toLowerCase();
  const supported = /^image\/(png|jpeg|gif|webp|avif|svg\+xml)$/.test(mime);
  useEffect(() => {
    if (!supported) return;
    if (typeof IntersectionObserver === "undefined") { setVisible(true); return; }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: "300px" });
    if (placeholder.current) observer.observe(placeholder.current);
    return () => observer.disconnect();
  }, [supported]);
  const image = useQuery({
    queryKey: ["public-agent-file", repository.workspaceId, repository.revision, file.fileId, file.sha256],
    queryFn: ({ signal }) => getPublicAgentRepositoryFile(repository, file.fileId, signal), retry: false,
    enabled: supported && visible, staleTime: 60_000, gcTime: 60_000,
  });
  useEffect(() => {
    setUrl(undefined);
    if (!image.data || image.data.file.sha256 !== file.sha256) return;
    if (!supported) return;
    const bytes = Uint8Array.from(atob(image.data.file.contentBase64), (char) => char.charCodeAt(0));
    const objectURL = URL.createObjectURL(new Blob([bytes], { type: mime }));
    setUrl(objectURL);
    return () => URL.revokeObjectURL(objectURL);
  }, [image.data, file.sha256, mime, supported]);
  return url ? <img src={url} alt={alt ?? ""} width={width} height={height} loading="lazy" decoding="async" referrerPolicy="no-referrer" />
    : <span ref={placeholder} className="repository-image-placeholder">{alt || (supported && image.isPending ? t.agentWorkspace.loadingFile : t.agentWorkspace.transferPreviewFailed)}{image.isError && <button type="button" className="ml-2 underline" onClick={() => void image.refetch()}>{t.agentWorkspace.refresh}</button>}</span>;
}

const remarkPlugins = [remarkGfm];
// Sanitization runs after raw HTML and heading IDs are parsed, protecting against
// script execution and DOM clobbering while retaining GitHub-compatible markup.
const rehypePlugins = [rehypeRaw, rehypeSlug, rehypeSanitize];

export function RepositoryMarkdown({ content, filePath = "README.md", repository, onOpenFile, fragment }: {
  content: string;
  filePath?: string;
  repository?: PublicAgentRepository;
  onOpenFile?: (fileId: number, fragment?: string) => void;
  fragment?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!fragment) return;
    const target = document.getElementById(repositoryAnchorID(fragment));
    if (target && root.current?.contains(target)) target.scrollIntoView?.({ block: "start" });
  }, [content, fragment]);
  return <div ref={root} className="repository-markdown">
    <Markdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={{
      code: ({ children, className }) => <HighlightedCode className={className}>{children}</HighlightedCode>,
      a: ({ href, children, id: elementID, node }) => {
        const id = elementID ?? (typeof node?.properties.name === "string" ? node.properties.name : undefined);
        const resource = repositoryResource(href ?? "", filePath, repository?.files ?? [], repository?.githubSource);
        if (!resource) return <span id={id}>{children}</span>;
        const file = resource.file ?? (resource.href.startsWith("#") ? repository?.files.find((item) => item.path === filePath) : undefined);
        if (file && repository && onOpenFile) return <a id={id} href={repositoryFileHref(repository.workspaceId, file.path, resource.fragment)} onClick={(event) => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.defaultPrevented) return;
          event.preventDefault(); onOpenFile(file.fileId, resource.fragment);
        }}>{children}</a>;
        if (resource.href.startsWith("#")) return <a id={id} href={`#${repositoryAnchorID(resource.fragment ?? "")}`}>{children}</a>;
        return <a id={id} href={resource.href} target="_blank" rel="noopener noreferrer">{children}</a>;
      },
      img: ({ src, alt, width, height }) => {
        const resource = repositoryResource(typeof src === "string" ? src : "", filePath, repository?.files ?? [], repository?.githubSource, true);
        if (resource?.file && repository) return <SnapshotImage key={`${repository.revision}:${resource.file.fileId}:${resource.file.sha256}`} repository={repository} file={resource.file} alt={alt} width={width} height={height} />;
        return resource ? <img src={resource.href} alt={alt ?? ""} width={width} height={height} loading="lazy" decoding="async" referrerPolicy="no-referrer" /> : <span>{alt}</span>;
      },
      // A raw picture source would bypass snapshot resolution and the image URL policy.
      // Keep its img fallback, which goes through the same renderer as Markdown images.
      source: () => null,
      // Give wide tables their own scrollbar without widening the reading column.
      table: ({ children }) => <div className="repository-markdown-table"><table>{children}</table></div>,
    }}>{content}</Markdown>
  </div>;
}
