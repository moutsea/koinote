import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, FileText, Folder } from "lucide-react";
import { interpolate, useI18n } from "../../i18n";
import type { TreeFolder, TreeLevel } from "./tree";
import {
  automaticFolderIds, buildOrganizerPickerTree, defaultOrganizerSelection, documentIdsIn,
  organizerSelectionState, toggleOrganizerSelection,
  type OrganizerPickerDocument, type OrganizerPickerFolder, type OrganizerSelectionState,
} from "./aiOrganizerSelectionCore";

const buttonClass = "rounded-lg border border-black/10 px-2.5 py-1.5 text-xs hover:bg-black/5 disabled:opacity-40 dark:border-white/15 dark:hover:bg-white/10";

function SelectionBox({ state, label, disabled, onChange }: {
  state: OrganizerSelectionState; label: string; disabled: boolean; onChange: (checked: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = state === "some"; }, [state]);
  return <input ref={ref} type="checkbox" aria-label={label} checked={state === "all"} disabled={disabled}
    onChange={event => onChange(event.target.checked)} className="h-4 w-4 shrink-0 accent-cinnabar-500" />;
}

// Lets the user pick exactly which documents are re-filed. Picking a folder
// picks every document beneath it; documents with local sync conflicts are
// shown but cannot be picked.
export function AIOrganizerDocumentPicker({ folders, documents, selected, unavailable, disabled, onChange }: {
  folders: OrganizerPickerFolder[]; documents: OrganizerPickerDocument[]; selected: ReadonlySet<string>;
  unavailable: ReadonlySet<string>; disabled: boolean; onChange: (next: Set<string>) => void;
}) {
  const { t } = useI18n(); const l = t.editor.aiOrganizer;
  const tree = useMemo(() => buildOrganizerPickerTree(folders, documents), [folders, documents]);
  const automatic = useMemo(() => automaticFolderIds(folders), [folders]);
  const [expanded, setExpanded] = useState(new Set<string>());
  const available = (ids: string[]) => ids.filter(id => !unavailable.has(id));
  const all = available(documents.map(doc => doc.docId));
  const selectedCount = all.filter(id => selected.has(id)).length;

  function toggleExpanded(id: string) {
    setExpanded(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function folderRow(folder: TreeFolder, depth: number) {
    const ids = available(documentIdsIn(folder));
    const open = expanded.has(folder.folderId);
    const count = ids.filter(id => selected.has(id)).length;
    return <li key={folder.folderId} data-picker-folder={folder.folderId}>
      <div className="flex min-h-9 items-center gap-1.5 rounded-lg pr-2 hover:bg-black/[0.03] dark:hover:bg-white/5" style={{ paddingLeft: depth * 18 + 4 }}>
        <button type="button" aria-expanded={open} aria-label={`${open ? l.collapse : l.expand}: ${folder.name}`} onClick={() => toggleExpanded(folder.folderId)} className="rounded p-1 hover:bg-black/5 dark:hover:bg-white/10">
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
        <SelectionBox state={organizerSelectionState(ids, selected)} label={interpolate(l.selectFolder, { name: folder.name })}
          disabled={disabled || ids.length === 0} onChange={checked => onChange(toggleOrganizerSelection(selected, ids, checked))} />
        <Folder className="h-4 w-4 shrink-0 text-cinnabar-500" aria-hidden="true" />
        <span className="min-w-0 truncate text-sm">{folder.name}</span>
        {automatic.has(folder.folderId) && <span className="shrink-0 rounded bg-amber-50 px-1.5 py-0.5 text-[11px] text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">{l.automaticFolder}</span>}
        <span className="ml-auto shrink-0 text-xs tabular-nums text-neutral-500">{count}/{ids.length}</span>
      </div>
      {open && level(folder, depth + 1)}
    </li>;
  }
  function level(node: TreeLevel, depth: number) {
    if (!node.folders.length && !node.docs.length) return null;
    return <ul role="group" className="space-y-0.5">
      {node.folders.map(folder => folderRow(folder, depth))}
      {node.docs.map(doc => {
        const title = doc.title || t.editor.untitled;
        const blocked = unavailable.has(doc.docId);
        return <li key={doc.docId} data-picker-document={doc.docId}>
          <label className={`flex min-h-9 items-center gap-1.5 rounded-lg pr-2 hover:bg-black/[0.03] dark:hover:bg-white/5 ${blocked ? "opacity-50" : "cursor-pointer"}`} style={{ paddingLeft: depth * 18 + 30 }}>
            <input type="checkbox" checked={!blocked && selected.has(doc.docId)} disabled={disabled || blocked}
              onChange={event => onChange(toggleOrganizerSelection(selected, [doc.docId], event.target.checked))} className="h-4 w-4 shrink-0 accent-cinnabar-500" />
            <FileText className="h-4 w-4 shrink-0 text-neutral-400" aria-hidden="true" />
            <span className="min-w-0 truncate text-sm">{title}</span>
          </label>
        </li>;
      })}
    </ul>;
  }

  return <section aria-labelledby="ai-organizer-picker-title">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 id="ai-organizer-picker-title" className="text-sm font-medium">{l.pickerTitle}</h3>
      <span role="status" className="text-xs text-neutral-500">{interpolate(l.selectedCount, { count: selectedCount })}</span>
    </div>
    <p className="mt-1 text-xs leading-relaxed text-neutral-500">{l.pickerHint}</p>
    <div className="mt-3 flex flex-wrap gap-2">
      <button type="button" disabled={disabled || !all.length} onClick={() => onChange(new Set(all))} className={buttonClass}>{l.selectAll}</button>
      <button type="button" disabled={disabled || !selectedCount} onClick={() => onChange(new Set())} className={buttonClass}>{l.selectNone}</button>
      <button type="button" disabled={disabled} onClick={() => onChange(defaultOrganizerSelection(folders, documents))} className={buttonClass}>{l.selectDefault}</button>
      <button type="button" disabled={!folders.length} onClick={() => setExpanded(current => current.size ? new Set() : new Set(folders.map(folder => folder.folderId)))} className={buttonClass}>{expanded.size ? l.collapseAll : l.expandAll}</button>
    </div>
    <div className="mt-3 max-h-[45dvh] overflow-y-auto rounded-lg border border-black/5 p-1.5 dark:border-white/10">
      {documents.length ? level(tree, 0) : <p className="p-3 text-sm text-neutral-500">{l.pickerEmpty}</p>}
    </div>
  </section>;
}
