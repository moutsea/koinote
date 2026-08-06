import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import {
  createDocument,
  createFolder,
  createShare,
  deleteDocument,
  deleteFolder,
  getDocument,
  getEditorTabs,
  listDocuments,
  listFolders,
  moveDocument,
  moveFolder,
  putEditorTabs,
  renameFolder,
  revokeShare,
  updateDocument,
  type Document,
  type DocumentShare,
  type DocumentSummary,
  type EditorTabs,
  type Folder,
  type ShareAccess,
} from "./api";

// 列表与单篇分开缓存：列表频繁失效（标题/时间会变），单篇按 docId 各自独立。
const LIST_KEY = ["documents"] as const;
const docKey = (docId: string) => ["document", docId] as const;

export function useDocumentList(
  enabled: boolean,
): UseQueryResult<DocumentSummary[]> {
  return useQuery({
    queryKey: LIST_KEY,
    queryFn: async () => (await listDocuments()).documents,
    enabled,
    retry: false,
  });
}

export function useDocument(docId: string | undefined) {
  return useQuery({
    queryKey: docKey(docId ?? ""),
    queryFn: async () => (await getDocument(docId!)).document,
    enabled: Boolean(docId),
    retry: false,
    // 编辑器内自带防抖保存，重新聚焦时不要拉取覆盖正在编辑的内容
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });
}

export function useCreateDocument() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params?: { title?: string; content?: string }) =>
      createDocument(params),
    onSuccess: ({ document }) => {
      queryClient.setQueryData(docKey(document.docId), document);
      void queryClient.invalidateQueries({ queryKey: LIST_KEY });
    },
  });
}

export function useDeleteDocument() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (docId: string) => deleteDocument(docId),
    onSuccess: (_result, docId) => {
      queryClient.removeQueries({ queryKey: docKey(docId) });
      void queryClient.invalidateQueries({ queryKey: LIST_KEY });
    },
  });
}

// 保存走 mutation 但不自动失效列表：编辑中每次防抖保存都刷列表会太吵。
// 由调用方在标题变化时按需刷新。
export function useSaveDocument() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      docId,
      title,
      content,
      theme,
    }: {
      docId: string;
      title: string;
      content: string;
      theme?: string;
    }) => updateDocument(docId, { title, content, theme }),
    onSuccess: ({ document }) => {
      queryClient.setQueryData(docKey(document.docId), document);
    },
  });
}

// ---------- 文件夹 ----------

const FOLDERS_KEY = ["folders"] as const;

export function useFolderList(enabled: boolean) {
  return useQuery({
    queryKey: FOLDERS_KEY,
    queryFn: listFolders,
    enabled,
    select: (data) => data.folders,
  });
}

/**
 * 文件夹的五种写操作共用一套失效逻辑。
 *
 * 移动、删除都会改到文档的归属（删文件夹时子项提到父级），所以文档列表也要失效 ——
 * 只失效 folders 的话侧栏里文档会留在原位，直到下次别的原因触发重取。
 */
function useFolderMutation<TArgs, TResult>(fn: (args: TArgs) => Promise<TResult>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: FOLDERS_KEY });
      void queryClient.invalidateQueries({ queryKey: LIST_KEY });
    },
  });
}

export function useCreateFolder() {
  return useFolderMutation((args: { name: string; parentFolderId: string | null }) =>
    createFolder(args),
  );
}

export function useRenameFolder() {
  return useFolderMutation((args: { folderId: string; name: string }) =>
    renameFolder(args.folderId, args.name),
  );
}

export function useDeleteFolder() {
  return useFolderMutation((folderId: string) => deleteFolder(folderId));
}

export function useMoveFolder() {
  return useFolderMutation(
    (args: { folderId: string; parentFolderId: string | null }) =>
      moveFolder(args.folderId, args.parentFolderId),
  );
}

export function useMoveDocument() {
  return useFolderMutation((args: { docId: string; folderId: string | null }) =>
    moveDocument(args.docId, args.folderId),
  );
}

// ---------- 编辑器标签页 ----------

const TABS_KEY = ["editor-tabs"] as const;

/**
 * 服务端的标签组。只在进入编辑器时读一次用于恢复会话 ——
 * staleTime: Infinity 是必要的：之后的真相在客户端，重新拉取会把用户刚开的标签
 * 覆盖回旧状态。
 */
export function useEditorTabs(enabled: boolean) {
  return useQuery({
    queryKey: TABS_KEY,
    queryFn: getEditorTabs,
    enabled,
    staleTime: Infinity,
    retry: false,
  });
}

/**
 * 同步标签组。
 *
 * 不做乐观更新也不失效缓存：客户端状态才是真相，服务端只是备份。回写缓存是为了
 * 同一会话内二次进入编辑器时不倒退。
 */
export function useSyncEditorTabs() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: EditorTabs) => putEditorTabs(params),
    onSuccess: (result) => {
      queryClient.setQueryData(TABS_KEY, result);
    },
  });
}

// ---------- 分享 ----------

export function useCreateShare() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      docId,
      access,
      password,
    }: {
      docId: string;
      access: ShareAccess;
      password?: string;
    }) => createShare(docId, { access, password }),
    onSuccess: (_result, { docId }) => {
      // 分享状态挂在单篇文档上，刷它以拿到最新 token
      void queryClient.invalidateQueries({ queryKey: docKey(docId) });
    },
  });
}

export function useRevokeShare() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (docId: string) => revokeShare(docId),
    onSuccess: (_result, docId) => {
      void queryClient.invalidateQueries({ queryKey: docKey(docId) });
    },
  });
}

// 供编辑器在标题变化后手动刷新侧边栏列表
export function useRefreshDocumentList() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: LIST_KEY });
}

export type { Document, DocumentShare, DocumentSummary, Folder, ShareAccess };
