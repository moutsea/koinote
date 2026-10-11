import { Link } from "@tanstack/react-router";
import { ChevronDown, Compass, FolderPlus, Github, Plus, Settings2 } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";

type CreateActions = { onCreate: () => void; onGitHubImport: () => void };

export function AgentRepositoryActions({ canCreate, onCreate, onGitHubImport }: CreateActions & { canCreate: boolean }) {
  const { t } = useI18n();
  const linkClassName = "inline-flex items-center gap-1.5 rounded-lg border border-[var(--ink-line)] px-3 py-2 text-xs font-semibold text-[var(--ink-strong)] transition-colors hover:bg-[var(--ink-wash)]";
  return (
    <div className="flex max-w-full flex-wrap items-center justify-end gap-2">
      <Link to="/repositories" className={linkClassName}>
        <Compass className="h-3.5 w-3.5" aria-hidden="true" />
        {t.agentWorkspace.publicRepositories}
      </Link>
      <Link to="/space/settings" className={linkClassName}>
        <Settings2 className="h-3.5 w-3.5" aria-hidden="true" />
        {t.agentWorkspace.settingsTab}
      </Link>
      {canCreate && <AgentRepositoryCreateMenu onCreate={onCreate} onGitHubImport={onGitHubImport} />}
    </div>
  );
}

export function AgentRepositoryCreateMenu({ onCreate, onGitHubImport }: CreateActions) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const initialFocus = useRef(0);
  const id = useId();

  useLayoutEffect(() => {
    if (!open) { setPosition(null); return; }
    const place = () => {
      if (!root.current || !menu.current || !Number.isFinite(window.innerWidth)) return;
      const anchor = root.current.getBoundingClientRect();
      const popup = menu.current.getBoundingClientRect();
      const left = Math.max(8, Math.min(anchor.right - popup.width, window.innerWidth - popup.width - 8)) - anchor.left;
      const above = anchor.bottom + popup.height + 8 > window.innerHeight && anchor.top > popup.height + 8;
      setPosition({ left, top: above ? -popup.height - 8 : anchor.height + 8 });
    };
    place();
    window.addEventListener("resize", place);
    document.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); document.removeEventListener("scroll", place, true); };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", outside);
    menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[initialFocus.current]?.focus();
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  function choose(action: () => void) { setOpen(false); trigger.current?.focus(); action(); }
  const itemClassName = "flex w-full items-start gap-3 rounded-lg px-3 py-3 text-left text-[var(--ink-strong)] hover:bg-[var(--ink-wash)] focus-visible:bg-[var(--ink-wash)]";

  return (
    <div ref={root} className="relative inline-block text-left" onBlur={(event) => {
      if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false);
    }} onKeyDown={(event) => {
      if (!open) return;
      if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus();
      } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
        items[next]?.focus();
      }
    }}>
      <button ref={trigger} id={`${id}-trigger`} type="button" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
        onClick={() => { initialFocus.current = 0; setOpen((value) => !value); }}
        onKeyDown={(event) => {
          if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault(); initialFocus.current = event.key === "ArrowUp" ? 1 : 0; setOpen(true);
          }
        }}
        className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--ink-strong)] px-3 py-2 text-xs font-semibold text-[var(--ink-paper)] shadow-sm transition-opacity hover:opacity-90">
        <Plus className="h-3.5 w-3.5" aria-hidden="true" />{t.agentWorkspace.newRepository}
        <ChevronDown className={`h-3.5 w-3.5 ${open ? "rotate-180" : ""}`} aria-hidden="true" />
      </button>
      {open && (
        <div ref={menu} id={id} role="menu" aria-labelledby={`${id}-trigger`}
          className="absolute right-0 z-50 w-72 max-w-[calc(100vw-2rem)] rounded-xl border border-[var(--ink-line)] bg-[var(--ink-paper-soft)] p-1.5 shadow-lg"
          style={position ? { left: position.left, top: position.top, right: "auto" } : { top: "calc(100% + 8px)" }}>
          <button type="button" role="menuitem" tabIndex={-1} onClick={() => choose(onCreate)} className={itemClassName}>
            <FolderPlus className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="min-w-0"><span className="block text-sm font-semibold">{t.agentWorkspace.createDirectly}</span><span className="mt-1 block text-xs leading-5 text-[var(--ink-mid)]">{t.agentWorkspace.createDirectlyDescription}</span></span>
          </button>
          <button type="button" role="menuitem" tabIndex={-1} onClick={() => choose(onGitHubImport)} className={itemClassName}>
            <Github className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="min-w-0"><span className="block text-sm font-semibold">{t.agentWorkspace.githubImport}</span><span className="mt-1 block text-xs leading-5 text-[var(--ink-mid)]">{t.agentWorkspace.githubImportOptionDescription}</span></span>
          </button>
        </div>
      )}
    </div>
  );
}
