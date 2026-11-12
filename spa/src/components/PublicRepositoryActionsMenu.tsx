import { ChevronDown, MoreHorizontal, type LucideIcon } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

export type PublicRepositoryAction = {
  id: string;
  label: string;
  icon: LucideIcon;
  onSelect?: () => void;
  href?: string;
  disabled?: boolean;
  title?: string;
  danger?: boolean;
  separator?: boolean;
};

export function PublicRepositoryActionsMenu({ label, actions }: { label: string; actions: PublicRepositoryAction[] }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const initialFocus = useRef<"first" | "last">("first");
  const id = useId();
  const items = () => Array.from(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? []);

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
    const available = items();
    available[initialFocus.current === "last" ? available.length - 1 : 0]?.focus();
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  function close() { setOpen(false); trigger.current?.focus(); }
  return <div ref={root} className="relative inline-block" onBlur={(event) => {
    if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false);
  }} onKeyDown={(event) => {
    if (!open) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
    else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const available = items();
      const index = available.indexOf(document.activeElement as HTMLElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? available.length - 1 : (index + (event.key === "ArrowDown" ? 1 : available.length - 1)) % available.length;
      available[next]?.focus();
    }
  }}>
    <button ref={trigger} id={`${id}-trigger`} type="button" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => { initialFocus.current = "first"; setOpen((value) => !value); }}
      onKeyDown={(event) => {
        if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
          event.preventDefault(); initialFocus.current = event.key === "ArrowUp" ? "last" : "first"; setOpen(true);
        }
      }}
      className="inline-flex min-h-10 items-center gap-2 rounded-full border border-[var(--ink-line)] px-4 py-2 text-sm transition hover:bg-[var(--ink-wash)]">
      <MoreHorizontal className="h-4 w-4" aria-hidden="true" />{label}<ChevronDown className={`h-4 w-4 transition ${open ? "rotate-180" : ""}`} aria-hidden="true" />
    </button>
    {open && <div ref={menu} id={id} role="menu" aria-labelledby={`${id}-trigger`}
      className="absolute right-0 z-40 max-h-[calc(100dvh-2rem)] w-64 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl border border-[var(--ink-line)] bg-[var(--ink-paper-soft)] p-1.5 shadow-lg"
      style={position ? { left: position.left, top: position.top, right: "auto" } : { top: "calc(100% + 8px)" }}>
      {actions.map((action) => {
        const Icon = action.icon;
        const className = `flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm transition hover:bg-[var(--ink-wash)] focus-visible:bg-[var(--ink-wash)] disabled:opacity-50 ${action.danger ? "text-[var(--cinnabar)]" : ""}`;
        return <div key={action.id}>
          {action.separator && <div role="separator" className="my-1 border-t border-[var(--ink-line)]" />}
          {action.href ? <a href={action.href} role="menuitem" tabIndex={-1} onClick={close} className={className}><Icon className="h-4 w-4 shrink-0" aria-hidden="true" />{action.label}</a>
            : <button type="button" role="menuitem" tabIndex={-1} disabled={action.disabled} title={action.title} onClick={() => { close(); action.onSelect?.(); }} className={className}><Icon className="h-4 w-4 shrink-0" aria-hidden="true" />{action.label}</button>}
        </div>;
      })}
    </div>}
  </div>;
}
