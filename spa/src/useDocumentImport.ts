import { createContext, createElement, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError, getSession } from "./api";
import { IMPORT_ACCOUNT_CHANGED_CODE, ImportInterruptedError, type ImportDocumentsResult } from "./documentImportCore";

const DocumentImportContext = createContext<(ReturnType<typeof useImportTask> & { accountChanged: boolean }) | null>(null);

// The shell retains the task while route pages mount/unmount. Authentication
// changes and explicit dismissal still release the old account's plan.
export function DocumentImportProvider({ owner, children }: { owner: string | undefined; children: ReactNode }) {
  // Only a generic stop notice crosses account boundaries; document counts and
  // results remain inside the keyed account provider.
  const [accountChanged, setAccountChanged] = useState(false);
  const reportAccountChanged = useCallback(() => setAccountChanged(true), []);
  const dismissAccountChanged = useCallback(() => setAccountChanged(false), []);
  return createElement(AccountImportProvider, { key: owner ?? "guest", owner, children, accountChanged, reportAccountChanged, dismissAccountChanged });
}

function AccountImportProvider({ owner, children, accountChanged, reportAccountChanged, dismissAccountChanged }: {
  owner: string | undefined; children: ReactNode; accountChanged: boolean;
  reportAccountChanged: () => void; dismissAccountChanged: () => void;
}) {
  const task = useImportTask(owner, reportAccountChanged, dismissAccountChanged);
  return createElement(DocumentImportContext.Provider, { value: { ...task, accountChanged } }, children);
}

export function useDocumentImport() {
  const task = useContext(DocumentImportContext);
  if (!task) throw new Error("DocumentImportProvider is required");
  return task;
}

function useImportTask(owner: string | undefined, reportAccountChanged: () => void, dismissAccountChanged: () => void) {
  const queryClient = useQueryClient();
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const active = useRef<AbortController | null>(null);
  const pendingRef = useRef<ImportInterruptedError | null>(null);
  const [pending, setPending] = useState<ImportInterruptedError | null>(null);
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<ImportDocumentsResult | null>(null);
  const dismissNotice = useCallback(() => { setResult(null); dismissAccountChanged(); }, [dismissAccountChanged]);

  useEffect(() => {
    setPending(null);
    setBusy(false);
    setWaiting(false);
    setProgress(null);
    return () => {
      active.current?.abort();
      active.current = null;
      void pendingRef.current?.discard();
      pendingRef.current = null;
    };
  }, [owner]);

  const discard = useCallback(() => {
    const previous = pendingRef.current;
    pendingRef.current = null;
    setPending(null);
    setProgress(null);
    void previous?.discard();
  }, []);

  const run = useCallback(async (
    files?: File[],
    targetFolderId?: string | null,
  ) => {
    const capturedOwner = ownerRef.current;
    const previous = pendingRef.current;
    if (!capturedOwner || active.current || (files && previous) || (!files && !previous?.canResume)) return null;
    dismissNotice();
    const controller = new AbortController();
    active.current = controller;
    pendingRef.current = null;
    setPending(null);
    setBusy(true);
    setWaiting(false);
    if (files) setProgress(null);
    const onProgress = (done: number, total: number) => {
      if (active.current === controller) setProgress({ done, total });
    };
    const assertActive = () => {
      controller.signal.throwIfAborted();
      if (ownerRef.current !== capturedOwner) {
        controller.abort();
        controller.signal.throwIfAborted();
      }
    };
    const options = {
      owner: capturedOwner,
      signal: controller.signal,
      assertActive,
      checkSession: async () => {
        assertActive();
        try {
          const session = await getSession();
          if (session.user?.authUserId === capturedOwner) {
            assertActive();
            return;
          }
        } catch (error) {
          if (!(error instanceof ApiError) || (error.status !== 401 && error.status !== 403)) throw error;
        }
        if (!controller.signal.aborted) {
          reportAccountChanged();
          controller.abort();
          await queryClient.invalidateQueries({ queryKey: ["session"] });
        }
        assertActive();
      },
      onWaitingChange: (value: boolean) => {
        if (active.current === controller) setWaiting(value);
      },
    };
    try {
      let result;
      if (files) {
        const { importDocumentsFromFiles } = await import("./documentTransfer");
        assertActive();
        result = await importDocumentsFromFiles(files, onProgress, targetFolderId, options);
      } else {
        result = await previous!.resume(onProgress, options);
      }
      assertActive();
      setPending(null);
      setResult(result);
      return result;
    } catch (error) {
      if (error instanceof ApiError && error.code === IMPORT_ACCOUNT_CHANGED_CODE) {
        controller.abort();
        setPending(null);
        reportAccountChanged();
        await queryClient.invalidateQueries({ queryKey: ["session"] });
        return null;
      }
      if (controller.signal.aborted || ownerRef.current !== capturedOwner) {
        if (active.current === controller) setPending(null);
        return null;
      }
      if (error instanceof ImportInterruptedError) {
        pendingRef.current = error;
        setPending(error);
      }
      throw error;
    } finally {
      // Partial writes are already durable and must be visible after a failure.
      await Promise.allSettled([
        queryClient.invalidateQueries({ queryKey: ["documents"] }),
        queryClient.invalidateQueries({ queryKey: ["folders"] }),
        queryClient.invalidateQueries({ queryKey: ["storage-usage"] }),
      ]);
      if (active.current === controller) {
        active.current = null;
        setBusy(false);
        setWaiting(false);
      }
    }
  }, [queryClient, dismissNotice, reportAccountChanged]);

  return { run, discard, pending, busy, waiting, progress, result, dismissNotice, blocked: busy || Boolean(pending) };
}
