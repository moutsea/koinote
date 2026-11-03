export const AGENT_PANEL_OPEN = "koinote:agent-panel-open";
export function openAgentOrganizer() {
  window.dispatchEvent(new CustomEvent(AGENT_PANEL_OPEN, { detail: { action: "organize" } }));
}
export const AGENT_DOCUMENT_CHANGED = "koinote:agent-document-changed";
export type AgentFocus = {
  title: string;
  path: string;
  docId: string;
  prepare: () => Promise<boolean>;
};
let focusedDocument: AgentFocus | null = null;
const focusListeners = new Set<() => void>();
export function setAgentFocus(focus: AgentFocus) {
  focusedDocument = focus;
  focusListeners.forEach((listener) => listener());
  return () => {
    if (focusedDocument === focus) {
      focusedDocument = null;
      focusListeners.forEach((listener) => listener());
    }
  };
}
export const getAgentFocus = () => focusedDocument;
export const subscribeAgentFocus = (listener: () => void) => {
  focusListeners.add(listener);
  return () => {
    focusListeners.delete(listener);
  };
};
export function notifyAgentDocumentChange(docId?: string) {
  window.dispatchEvent(
    new CustomEvent(AGENT_DOCUMENT_CHANGED, { detail: { docId } }),
  );
}
