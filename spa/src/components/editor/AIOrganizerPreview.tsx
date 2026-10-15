import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, FileText, Folder, FolderPlus, GripVertical, Plus, Search, Tags, X } from "lucide-react";
import type { DocumentOrganization } from "../../api";
import { interpolate, useI18n } from "../../i18n";
import { organizationChoices, organizationPath, type OrganizationDraft } from "./aiOrganizerCore";
import {
  buildOrganizationPreview, changeOrganizationTags, moveOrganizationDocument,
  previewTagCounts, type PreviewDestination, type PreviewDirectory, type PreviewTagChange,
} from "./aiOrganizerPreviewCore";

const inputClass = "w-full rounded-lg border border-black/10 bg-white px-2.5 py-2 text-sm outline-none focus:border-cinnabar-400 dark:border-white/15 dark:bg-neutral-900";
const buttonClass = "rounded-lg border border-black/10 px-3 py-2 text-sm hover:bg-black/5 disabled:opacity-40 dark:border-white/15 dark:hover:bg-white/10";
type DropTarget = { directory: PreviewDirectory; anchor?: { docId: string; edge: "before" | "after" } };

const dragType = "application/x-koinote-organization-document";

export function AIOrganizerPreview({ data, drafts, busy, onChange }: {
  data: DocumentOrganization["data"]; drafts: Record<string, OrganizationDraft>; busy: boolean;
  onChange: (update: (current: Record<string, OrganizationDraft>) => Record<string, OrganizationDraft>) => void;
}) {
  const { t } = useI18n(); const l = t.editor.aiOrganizer;
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const [extras, setExtras] = useState<PreviewDestination[]>([]);
  const [expandedDocument, setExpandedDocument] = useState<string | null>(null);
  const [creatingIn, setCreatingIn] = useState<string | null>(null);
  const [manageTags, setManageTags] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [tagName, setTagName] = useState("");
  const [renameTag, setRenameTag] = useState<{ from: string; value: string } | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [hover, setHover] = useState<DropTarget | null>(null);
  const [draggedDocument, setDraggedDocument] = useState<string | null>(null);
  const treeViewport = useRef<HTMLElement>(null);
  const dragging = useRef<string | null>(null);
  const orderFocus = useRef<{ docId: string; direction: string } | null>(null);
  const tree = useMemo(() => buildOrganizationPreview(data.items, data.folders, drafts, extras, data.timeFolders, data.folderCounts), [data.items, data.folders, data.timeFolders, data.folderCounts, drafts, extras]);
  useEffect(() => {
    const pending = orderFocus.current;
    if (!pending) return;
    orderFocus.current = null;
    const row = [...(treeViewport.current?.querySelectorAll<HTMLElement>("[data-preview-document]") ?? [])].find(node => node.dataset.previewDocument === pending.docId);
    const controls = [...(row?.querySelectorAll<HTMLButtonElement>("[data-move-document]") ?? [])];
    const target = controls.find(button => button.dataset.moveDocument === pending.direction && !button.disabled) ?? controls.find(button => !button.disabled);
    target?.focus({ preventScroll: true });
    target?.scrollIntoView?.({ block: "nearest" });
  }, [tree]);
  const tagCounts = useMemo(() => previewTagCounts(drafts), [drafts]);
  const selectedCount = data.items.filter(item => drafts[item.docId]?.selected).length;
  useEffect(() => {
    if (expandedDocument && !data.items.some(item => item.docId === expandedDocument)) setExpandedDocument(null);
    if (creatingIn && !tree.directories.has(creatingIn)) setCreatingIn(null);
  }, [expandedDocument, creatingIn, data.items, tree.directories]);
  function finishDrag() { dragging.current = null; setDraggedDocument(null); setHover(null); }
  useEffect(() => { if (busy) finishDrag(); }, [busy]);
  useEffect(() => {
    if (!hover || hover.anchor || !collapsed.has(hover.directory.key)) return;
    const key = hover.directory.key;
    const timer = window.setTimeout(() => setCollapsed(current => { const next = new Set(current); next.delete(key); return next; }), 500);
    return () => window.clearTimeout(timer);
  }, [hover?.directory.key, Boolean(hover?.anchor), collapsed]);

  useEffect(() => {
    const cancel = (event: KeyboardEvent) => {
      if (event.key === "Escape" && dragging.current) { event.stopImmediatePropagation(); finishDrag(); }
    };
    window.addEventListener("keydown", cancel, true);
    return () => window.removeEventListener("keydown", cancel, true);
  }, []);

  const directoryOptions = useMemo(() => {
    const values = [...tree.directories.values()].map(node => ({ node, name: node.path.join(" / ") || l.root }));
    const counts = new Map<string, number>(); const seen = new Map<string, number>();
    for (const { name } of values) counts.set(name, (counts.get(name) ?? 0) + 1);
    return values.map(({ node, name }) => {
      const index = (seen.get(name) ?? 0) + 1; seen.set(name, index);
      return { node, name: counts.get(name)! > 1 ? interpolate(l.duplicateFolder, { name, index }) : name };
    }).sort((a, b) => a.node === tree.root ? -1 : b.node === tree.root ? 1 : a.name.localeCompare(b.name));
  }, [tree, l.root, l.duplicateFolder]);

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    const folders = new Set<string>(); const documents = new Set<string>();
    function visit(node: PreviewDirectory, parentMatch: boolean): boolean {
      const match = !query || parentMatch || Boolean(node.name && node.name.toLowerCase().includes(query));
      for (const item of node.documents) {
        const tags = drafts[item.docId]?.selected ? drafts[item.docId].tags : item.tags;
        if (match || [item.title, ...tags].some(value => value.toLowerCase().includes(query))) documents.add(item.docId);
      }
      const childMatches = node.children.map(child => visit(child, match)).some(Boolean);
      if (match || childMatches || node.documents.some(item => documents.has(item.docId))) { folders.add(node.key); return true; }
      return false;
    }
    visit(tree.root, false);
    return { folders, documents };
  }, [tree, search, drafts]);

  function update(docId: string, patch: Partial<OrganizationDraft>) {
    if (busy) return;
    onChange(current => current[docId] ? { ...current, [docId]: { ...current[docId], ...patch } } : current);
    setError("");
  }
  function toggleDirectory(key: string) {
    setCollapsed(current => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }
  function move(docId: string, target: PreviewDirectory, anchor?: DropTarget["anchor"]) {
    if (busy || !data.items.some(item => item.docId === docId)) return;
    if (anchor?.docId === docId) return;
    try {
      moveOrganizationDocument(drafts, docId, target, data.folders, data.items, anchor);
      onChange(current => moveOrganizationDocument(current, docId, target, data.folders, data.items, anchor));
    } catch { setError(l.invalid); return; }
    setCollapsed(new Set()); setSearch(""); setExpandedDocument(current => current === docId ? docId : null); setError("");
    setNotice(anchor ? l.orderUpdated : interpolate(l.movedTo, { name: target.path.join(" / ") || l.root }));
  }
  function dropProps(directory: PreviewDirectory, anchorDocId?: string) {
    const targetAt = (event: DragEvent): DropTarget => ({ directory, ...(anchorDocId ? { anchor: {
      docId: anchorDocId, edge: event.clientY < event.currentTarget.getBoundingClientRect().top + event.currentTarget.getBoundingClientRect().height / 2 ? "before" as const : "after" as const,
    } } : {}) });
    return {
      onDragOver: (event: DragEvent) => {
        if (busy || !dragging.current) return;
        event.preventDefault(); event.stopPropagation();
        if (dragging.current === anchorDocId) { event.dataTransfer.dropEffect = "none"; setHover(null); return; }
        event.dataTransfer.dropEffect = "move";
        const next = targetAt(event);
        setHover(current => current?.directory.key === next.directory.key && current?.anchor?.docId === next.anchor?.docId && current?.anchor?.edge === next.anchor?.edge ? current : next);
      },
      onDragLeave: (event: DragEvent) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHover(current => current?.directory.key === directory.key && current?.anchor?.docId === anchorDocId ? null : current);
      },
      onDrop: (event: DragEvent) => {
        event.preventDefault(); event.stopPropagation();
        const docId = dragging.current; const target = targetAt(event); finishDrag();
        if (!busy && docId && event.dataTransfer.getData(dragType) === docId) move(docId, target.directory, target.anchor);
      },
    };
  }
  function addDirectory(parent: PreviewDirectory) {
    if (busy || !folderName.trim()) return;
    try {
      const [choice] = organizationChoices({ temporary: { selected: true, folderId: parent.folderId, newPath: [...parent.newFolders, folderName.trim()].join("/"), tags: [] } }, data.folders);
      setExtras(current => current.some(value => value.folderId === choice.folderId && JSON.stringify(value.newFolders) === JSON.stringify(choice.newFolders)) ? current : [...current, choice]);
      setCreatingIn(null); setFolderName(""); setSearch(""); setCollapsed(new Set()); setError("");
    } catch (e) { setError(e instanceof Error && e.message === "organization_ambiguous_folder" ? l.ambiguousFolder : l.invalid); }
  }
  function changeTags(change: PreviewTagChange) {
    if (busy || !selectedCount) return;
    try {
      // Validate the entire operation before changing any document.
      changeOrganizationTags(drafts, change);
      onChange(current => changeOrganizationTags(current, change));
      setRenameTag(null); setTagName(""); setError(""); setNotice(l.tagsUpdated);
    } catch (e) { setError(e instanceof Error && e.message === "organization_tag_limit" ? l.tagLimit : l.invalid); }
  }
  function renderDirectory(node: PreviewDirectory, siblings: PreviewDirectory[] = [tree.root]) {
    const isRoot = node === tree.root;
    const sameNames = siblings.filter(sibling => sibling.name === node.name);
    const name = isRoot ? l.root : sameNames.length > 1 ? interpolate(l.duplicateFolder, { name: node.name, index: sameNames.indexOf(node) + 1 }) : node.name;
    const expanded = isRoot || Boolean(search.trim()) || !collapsed.has(node.key);
    const folderLabel = <>
      {!isRoot && (expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />)}
      <Folder className="h-4 w-4 shrink-0 text-cinnabar-500" /><span className="truncate font-medium">{name}</span>
      {node.newFolders.length > 0 && <span className="shrink-0 rounded bg-cinnabar-50 px-1.5 py-0.5 text-[10px] text-cinnabar-700 dark:bg-cinnabar-950 dark:text-cinnabar-300">{l.newDirectory}</span>}
      <span className="ml-auto tabular-nums text-xs text-neutral-400">{node.count}</span>
    </>;
    return <li key={node.key} data-preview-folder={node.key}>
      <div {...dropProps(node)} className={`group flex items-center gap-2 rounded-lg px-2 py-1 ${hover?.directory.key === node.key && !hover.anchor ? "bg-cinnabar-100 ring-1 ring-cinnabar-400 dark:bg-cinnabar-900/40" : "hover:bg-black/[0.03] dark:hover:bg-white/5"}`}>
        {isRoot ? <div className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-sm">{folderLabel}</div> : <button type="button" aria-expanded={expanded} onClick={() => toggleDirectory(node.key)} className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left text-sm" title={node.path.join(" / ")}>{folderLabel}</button>}
        <button type="button" data-create-directory aria-label={interpolate(l.createFolderAt, { name })} title={interpolate(l.createFolderAt, { name })} aria-expanded={creatingIn === node.key} disabled={busy || node.path.length >= 8} onClick={() => { setCreatingIn(current => current === node.key ? null : node.key); setFolderName(""); setError(""); }} className="shrink-0 rounded p-1.5 text-neutral-400 hover:bg-black/5 hover:text-cinnabar-600 disabled:opacity-30 dark:hover:bg-white/10"><FolderPlus className="h-4 w-4" /></button>
      </div>
      {creatingIn === node.key && <form onSubmit={event => { event.preventDefault(); addDirectory(node); }} className="my-2 ml-5 space-y-2 rounded-lg border border-dashed border-black/15 p-3 dark:border-white/15">
        <label className="block text-xs text-neutral-500">{interpolate(l.createFolderAt, { name })}<input autoFocus aria-label={l.directoryName} value={folderName} placeholder={l.directoryName} disabled={busy} onChange={event => setFolderName(event.target.value)} className={`${inputClass} mt-2`} /></label>
        <div className="flex flex-wrap items-center gap-2"><button disabled={busy || !folderName.trim()} className={buttonClass}>{l.createDirectory}</button><button type="button" onClick={() => setCreatingIn(null)} className="px-2 py-2 text-sm text-neutral-500">{l.cancel}</button><p className="text-xs leading-relaxed text-neutral-500">{l.emptyFolderHint}</p></div>
      </form>}
      {expanded && <ul className={isRoot ? "space-y-0.5" : "ml-3 space-y-0.5 border-l border-black/10 pl-1.5 sm:ml-4 sm:pl-2 dark:border-white/10"}>
        {node.children.filter(child => visible.folders.has(child.key)).map(child => renderDirectory(child, node.children))}
        {node.documents.filter(item => visible.documents.has(item.docId)).map(item => {
          const draft = drafts[item.docId];
          const title = item.title || t.editor.untitled;
          const tags = draft?.selected ? draft.tags : item.tags;
          const detail = item.notAnalyzed ? l.notAnalyzed : item.needsReview ? (item.failureStatus ? interpolate(l.providerItem, { status: item.failureStatus }) : l.needsReview) : item.reason;
          const open = expandedDocument === item.docId;
          const position = node.documents.findIndex(sibling => sibling.docId === item.docId);
          return <li key={item.docId} data-preview-document={item.docId} {...dropProps(node, item.docId)} className={`relative rounded-lg ${draggedDocument === item.docId ? "opacity-50" : ""} ${open ? "bg-cinnabar-50/60 ring-1 ring-inset ring-cinnabar-200 dark:bg-cinnabar-950/20 dark:ring-cinnabar-900" : "hover:bg-black/[0.03] dark:hover:bg-white/5"}`}>
            {hover?.anchor?.docId === item.docId && <span data-preview-insertion={hover.anchor.edge} className={`pointer-events-none absolute inset-x-0 z-10 h-0.5 rounded bg-cinnabar-500 ${hover.anchor.edge === "before" ? "top-0" : "bottom-0"}`} />}
            <div data-document-drag-row draggable={!busy && Boolean(draft)} onDragStart={event => {
              if (busy || !draft || (event.target as HTMLElement).closest("input, select, textarea, [data-order-control]")) { event.preventDefault(); return; }
              event.stopPropagation(); dragging.current = item.docId; setDraggedDocument(item.docId);
              event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData(dragType, item.docId);
            }} onDragEnd={event => { event.stopPropagation(); finishDrag(); }} className="flex cursor-grab select-none items-center gap-2 px-2 py-2 active:cursor-grabbing">
              <span title={l.dragHint} className="shrink-0 text-neutral-400 dark:text-neutral-500"><GripVertical className="h-4 w-4" /></span>
              <input type="checkbox" data-preview-include={item.docId} checked={draft?.selected ?? false} disabled={busy || !draft} onChange={event => update(item.docId, { selected: event.target.checked })} aria-label={interpolate(l.includeDocument, { title })} className="shrink-0 accent-cinnabar-500" />
              <button type="button" data-edit-document draggable={!busy && Boolean(draft)} aria-expanded={open} aria-controls={`organization-document-${item.docId}`} onClick={() => setExpandedDocument(current => current === item.docId ? null : item.docId)} className="flex min-w-0 flex-1 cursor-grab items-center gap-2 text-left active:cursor-grabbing" title={l.dragHint}>
                <span className="min-w-0 flex-1"><span className="flex items-center gap-2 text-sm"><FileText className="h-4 w-4 shrink-0 text-neutral-400" /><span className="truncate">{title}</span></span>
                  <span className="mt-1 flex flex-wrap gap-1 pl-6 text-[11px] text-neutral-500">
                    {!draft?.selected && <span>{item.notAnalyzed ? l.notAnalyzedShort : item.needsReview ? l.reviewShort : l.keptInPlace}</span>}
                    {tags.filter(Boolean).map((tag, index) => <span key={index} className="max-w-32 truncate rounded bg-black/5 px-1.5 dark:bg-white/10">#{tag}</span>)}
                  </span>
                </span>
                {open ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-neutral-400" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-neutral-400" />}
              </button>
              <div data-order-control className="flex shrink-0 items-center">
                {([[-1, ArrowUp, l.moveUp], [1, ArrowDown, l.moveDown]] as const).map(([step, Icon, label]) => <button key={step} type="button" data-move-document={step < 0 ? "up" : "down"} draggable={false} aria-label={interpolate(label, { title })} title={interpolate(label, { title })} disabled={busy || !draft || !node.documents[position + step]} onClick={() => {
                  const sibling = node.documents[position + step];
                  if (sibling) {
                    orderFocus.current = { docId: item.docId, direction: step < 0 ? "up" : "down" };
                    move(item.docId, node, { docId: sibling.docId, edge: step < 0 ? "before" : "after" });
                  }
                }} className="flex h-9 w-9 cursor-pointer items-center justify-center rounded text-neutral-500 hover:bg-black/5 hover:text-cinnabar-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cinnabar-500 disabled:cursor-default disabled:opacity-25 dark:hover:bg-white/10"><Icon className="h-4 w-4" /></button>)}
              </div>
            </div>
            {open && draft && <article id={`organization-document-${item.docId}`} aria-label={title} className="mx-3 border-t border-cinnabar-200/60 py-3 sm:ml-12 dark:border-cinnabar-900/60">
              <p className="break-words text-sm font-medium sm:hidden">{title}</p>
              <p className="text-xs leading-relaxed text-neutral-500">{detail}</p>
              <p className="mt-2 break-words text-xs text-neutral-500">{l.originalFolder}: {organizationPath(data.folders, item.folderId).join(" / ") || l.root}</p>
              {!draft.selected && <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">{l.excludedHint}</p>}
              <fieldset disabled={busy} className="mt-3 space-y-3">
                <label className="block text-xs text-neutral-500">{l.folder}<select data-destination-select aria-label={`${title} — ${l.folder}`} value={node.key} onChange={event => { const target = tree.directories.get(event.target.value); if (target) move(item.docId, target); }} className={`${inputClass} mt-1.5`}>{directoryOptions.map(({ node: option, name: optionName }) => <option key={option.key} value={option.key}>{optionName}</option>)}</select></label>
                <div className="text-xs text-neutral-500"><p>{l.tags}<span className="ml-2 text-neutral-400">{l.tagsHint}</span></p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">{draft.tags.map((tag, index) => <div key={index} className="flex w-full items-center gap-1 sm:w-48"><input aria-label={`${title} — ${l.tags} ${index + 1}`} className={`${inputClass} min-w-0 flex-1`} value={tag} onChange={event => update(item.docId, { tags: draft.tags.map((value, i) => i === index ? event.target.value : value) })} /><button type="button" aria-label={`${l.removeTag}: ${tag}`} onClick={() => update(item.docId, { tags: draft.tags.filter((_, i) => i !== index) })} className="rounded p-1.5 hover:bg-black/5 dark:hover:bg-white/10"><X className="h-4 w-4" /></button></div>)}
                    <button type="button" disabled={busy || draft.tags.length >= 5} onClick={() => update(item.docId, { tags: [...draft.tags, ""] })} className="flex items-center gap-1 rounded px-2 py-2 hover:bg-black/5 disabled:opacity-40 dark:hover:bg-white/10"><Plus className="h-3.5 w-3.5" />{l.addTag}</button>
                  </div>
                </div>
              </fieldset>
            </article>}
          </li>;
        })}
      </ul>}
    </li>;
  }
  return <section className="min-w-0 overflow-hidden rounded-xl border border-black/10 bg-white dark:border-white/10 dark:bg-neutral-900" aria-label={l.preview}>
    <div className="border-b border-black/5 p-4 dark:border-white/10">
      <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold">{l.preview}</h3><span className="text-xs text-neutral-500">{interpolate(l.selected, { count: selectedCount })}</span></div>
      <p className="mt-2 text-xs leading-relaxed text-neutral-500">{l.treeHint}</p>
      {tree.removedDirectoryCount > 0 && <p className="mt-2 text-xs leading-relaxed text-neutral-500">{interpolate(l.cleanupTimeFolders, { count: tree.removedDirectoryCount })}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label className="relative min-w-0 flex-1 basis-40"><Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-neutral-400" /><input type="search" aria-label={l.searchTree} placeholder={l.searchTree} value={search} onChange={event => setSearch(event.target.value)} className={`${inputClass} pl-8`} /></label>
        <button type="button" title={l.expandAll} aria-label={l.expandAll} onClick={() => setCollapsed(new Set())} className="rounded p-2 hover:bg-black/5 dark:hover:bg-white/10"><ChevronDown className="h-4 w-4" /></button>
        <button type="button" title={l.collapseAll} aria-label={l.collapseAll} onClick={() => setCollapsed(new Set(tree.directories.keys()))} className="rounded p-2 hover:bg-black/5 dark:hover:bg-white/10"><ChevronRight className="h-4 w-4" /></button>
        <button type="button" aria-expanded={manageTags} aria-controls="organization-tag-manager" onClick={() => setManageTags(current => !current)} className={`${buttonClass} flex items-center gap-1.5 ${manageTags ? "bg-black/5 dark:bg-white/10" : ""}`}><Tags className="h-4 w-4" />{l.manageTags}</button>
      </div>
      {error && <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
      {notice && <p role="status" className="mt-3 text-xs text-emerald-700 dark:text-emerald-300">{notice}</p>}
      {manageTags && <div id="organization-tag-manager" className="mt-3 space-y-3 border-t border-black/5 pt-3 dark:border-white/10">
        <p className="text-xs leading-relaxed text-neutral-500">{interpolate(l.tagScope, { count: selectedCount })}</p>
        <form onSubmit={event => { event.preventDefault(); changeTags({ kind: "add", value: tagName }); }} className="flex gap-2"><input aria-label={l.bulkTag} placeholder={l.bulkTag} value={tagName} disabled={busy || !selectedCount} onChange={event => setTagName(event.target.value)} className={`${inputClass} min-w-0 flex-1`} /><button disabled={busy || !selectedCount || !tagName.trim()} className={`${buttonClass} shrink-0`}>{l.addTag}</button></form>
        <div className="grid max-h-[28dvh] gap-2 overflow-y-auto sm:grid-cols-2 lg:grid-cols-3">{tagCounts.map(tag => <div key={tag.name} className="min-w-0 rounded-lg border border-black/5 p-2.5 dark:border-white/10">
          {renameTag?.from === tag.name ? <form onSubmit={event => { event.preventDefault(); changeTags({ kind: "rename", from: tag.name, value: renameTag.value }); }} className="space-y-2"><input autoFocus aria-label={l.renameTag} value={renameTag.value} disabled={busy} onChange={event => setRenameTag({ from: tag.name, value: event.target.value })} className={inputClass} /><div className="flex gap-2"><button disabled={busy || !renameTag.value.trim()} className={buttonClass}>{l.saveTag}</button><button type="button" onClick={() => setRenameTag(null)} className="px-2 text-sm text-neutral-500">{l.cancel}</button></div></form> : <>
            <div className="flex items-start gap-2"><span className="min-w-0 flex-1 break-words text-sm">#{tag.name}</span><span className="text-xs tabular-nums text-neutral-400">{tag.count}</span></div>
            <div className="mt-2 flex gap-3 text-xs text-neutral-500"><button type="button" disabled={busy} onClick={() => setRenameTag({ from: tag.name, value: tag.name })} className="underline disabled:opacity-40">{l.renameTag}</button><button type="button" disabled={busy} aria-label={`${l.removeTag}: ${tag.name}`} onClick={() => changeTags({ kind: "remove", from: tag.name })} className="underline disabled:opacity-40">{l.removeTag}</button></div>
          </>}
        </div>)}</div>
        {!tagCounts.length && <p className="text-sm text-neutral-500">{l.noTags}</p>}
      </div>}
    </div>
    <nav ref={treeViewport} aria-label={l.preview} onDragOverCapture={event => {
      if (!dragging.current || busy) return;
      const viewport = treeViewport.current;
      if (!viewport) return;
      const bounds = viewport.getBoundingClientRect();
      if (event.clientY < bounds.top + 36) viewport.scrollTop -= 14;
      else if (event.clientY > bounds.bottom - 36) viewport.scrollTop += 14;
    }} className="max-h-[52dvh] min-h-48 overflow-auto p-2"><ul>{renderDirectory(tree.root)}</ul>{search && visible.documents.size === 0 && visible.folders.size === 0 && <p className="px-4 py-8 text-center text-sm text-neutral-500">{l.noMatches}</p>}</nav>
    <p className="border-t border-black/5 px-4 py-3 text-xs leading-relaxed text-neutral-500 dark:border-white/10">{l.previewScope}</p>
  </section>;
}
