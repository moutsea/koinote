import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import {
  createDocument,
  deleteDocument,
  getDocument,
  listDocuments,
  updateDocument,
  type Document,
  type DocumentSummary,
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
    }: {
      docId: string;
      title: string;
      content: string;
    }) => updateDocument(docId, { title, content }),
    onSuccess: ({ document }) => {
      queryClient.setQueryData(docKey(document.docId), document);
    },
  });
}

// 供编辑器在标题变化后手动刷新侧边栏列表
export function useRefreshDocumentList() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: LIST_KEY });
}

export type { Document, DocumentSummary };
