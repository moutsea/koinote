import {
  queryOptions,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { ApiError, getSession, logout as apiLogout, type User } from "./api";
import { clearAllConflictDrafts } from "./conflictDrafts";
import { isDesktopRuntime } from "./desktop/runtime";

export type SessionSnapshot = Awaited<ReturnType<typeof getSession>> & {
  revocationVersion?: number;
};

// 会话状态集中放在 react-query 缓存的 ["session"] key 下，全站共享。
export function sessionQueryOptions(queryClient: QueryClient) {
  const revocationVersion = () =>
    queryClient.getQueryData<SessionSnapshot>(["session"])?.revocationVersion ?? 0;
  return queryOptions({
    queryKey: ["session"],
    queryFn: async ({ signal }) => {
      try {
        const session = await getSession();
        return { ...session, revocationVersion: revocationVersion() };
      } catch (error) {
        // 已取消的旧会话请求不能撤销随后建立的新会话或清除它的分享缓存。
        if (signal.aborted) throw error;
        if (
          error instanceof ApiError &&
          (error.status === 401 || error.status === 403)
        ) {
          // 后台刷新失败会保留旧 data。明确失效时必须写入匿名状态，
          // 同时取消/移除全文查询；网络故障则继续保留原会话。
          queryClient.removeQueries({
            queryKey: ["share"],
            predicate: (query) => query.queryKey[2] !== "guest",
          });
          // 匿名查询可能在 Cookie 变化前已发出，或曾在会话接口暂时
          // 不可用时拿到全文。重置这些查询，避免迟到响应恢复旧内容。
          // 已完成的匿名预览则保留，避免移除活跃查询后停留在 loading。
          const guestQueries = queryClient.getQueryCache().findAll({
            queryKey: ["share"],
            predicate: (query) => {
              const data = query.state.data as
                | { document?: { isPreview: boolean } }
                | undefined;
              return (
                query.queryKey[2] === "guest" &&
                (data?.document?.isPreview === false ||
                  query.state.fetchStatus === "fetching")
              );
            },
          });
          for (const query of guestQueries) {
            void queryClient.resetQueries({ queryKey: query.queryKey, exact: true });
          }
          // 即使 user 一直为 null，也要通知页面撤销本地解锁及旧请求。
          return { user: null, revocationVersion: revocationVersion() + 1 };
        }
        throw error;
      }
    },
    retry: false,
    staleTime: 60_000,
  });
}

export function useSession() {
  return useQuery(sessionQueryOptions(useQueryClient()));
}

export function useCurrentUser(): User | undefined {
  return useSession().data?.user ?? undefined;
}

// 登出后清掉会话缓存，让依赖登录态的 UI 立即刷新。
export function useLogout() {
  const queryClient = useQueryClient();
  return async () => {
    const clearClientSession = () => {
      clearAllConflictDrafts();
      queryClient.removeQueries({ queryKey: ["share"] });
      queryClient.setQueryData(["session"], undefined);
      queryClient.removeQueries({ queryKey: ["session"] });
    };
    if (isDesktopRuntime()) {
      try {
        await apiLogout();
      } finally {
        // 桌面端无论服务端或本地缓存清理结果如何都会删除钥匙串凭证；
        // React Query 也必须同步退出，不能继续显示旧账号。
        clearClientSession();
      }
      return;
    }
    await apiLogout();
    clearClientSession();
  };
}
