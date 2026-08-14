import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getSession, logout as apiLogout, type User } from "./api";
import { clearAllConflictDrafts } from "./conflictDrafts";
import { isDesktopRuntime } from "./desktop/runtime";

// 会话状态集中放在 react-query 缓存的 ["session"] key 下，全站共享。
export function useSession() {
  return useQuery({
    queryKey: ["session"],
    queryFn: getSession,
    retry: false,
    staleTime: 60_000,
  });
}

export function useCurrentUser(): User | undefined {
  return useSession().data?.user;
}

// 登出后清掉会话缓存，让依赖登录态的 UI 立即刷新。
export function useLogout() {
  const queryClient = useQueryClient();
  return async () => {
    const clearClientSession = () => {
      clearAllConflictDrafts();
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
