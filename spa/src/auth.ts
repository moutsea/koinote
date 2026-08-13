import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getSession, logout as apiLogout, type User } from "./api";
import { clearAllConflictDrafts } from "./conflictDrafts";

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
    await apiLogout();
    clearAllConflictDrafts();
    queryClient.setQueryData(["session"], undefined);
    queryClient.removeQueries({ queryKey: ["session"] });
  };
}
