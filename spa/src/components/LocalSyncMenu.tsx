import { ChevronDown, Copy, FolderSync } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";

export function LocalSyncMenu({ label, disabled, onKoinote, onAgent, sensitive = false, download = false }: {
  label: string; disabled?: boolean; onKoinote: () => void; onAgent: () => void; sensitive?: boolean; download?: boolean;
}) {
  const { t } = useI18n();
  const copy = t.space.configSnapshots;
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
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
    root.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  function choose(action: () => void) { setOpen(false); trigger.current?.focus(); action(); }
  return <div ref={root} className="relative inline-block" onBlur={(event) => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false); }} onKeyDown={(event) => {
    if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); }
    if (open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault(); const items = Array.from(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      items[(index + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
    }
  }}>
    <button ref={trigger} type="button" disabled={disabled} aria-expanded={open} aria-haspopup="menu" aria-controls={open ? id : undefined} onClick={() => setOpen((value) => !value)} className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium hover:bg-[var(--ink-wash)] disabled:opacity-50" style={{ borderColor: "var(--ink-line)", color: "var(--ink-strong)" }}><FolderSync className="h-3.5 w-3.5" />{label}<ChevronDown className="h-3.5 w-3.5" /></button>
    {open && <div ref={menu} id={id} role="menu" aria-label={label} className="absolute right-0 z-50 w-64 max-w-[85vw] rounded-xl border bg-[var(--background)] p-1.5 shadow-xl" style={{ borderColor: "var(--ink-line)", ...(position ? { left: position.left, top: position.top, right: "auto" } : { top: "calc(100% + 8px)" }) }}>
      <button type="button" role="menuitem" onClick={() => choose(onKoinote)} className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm hover:bg-[var(--ink-wash)]"><FolderSync className="h-4 w-4 shrink-0" />{download ? copy.downloadWithKoinote : copy.syncWithKoinote}</button>
      <button type="button" role="menuitem" onClick={() => choose(onAgent)} className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm hover:bg-[var(--ink-wash)]"><Copy className="h-4 w-4 shrink-0" />{copy.syncWithAgent}</button>
      <p className="pl-9 pr-3 pb-2 pt-1 text-xs leading-5" style={{ color: "var(--ink-mid)" }}>{sensitive ? copy.agentSecretHint : copy.agentTokenHint}</p>
    </div>}
  </div>;
}
