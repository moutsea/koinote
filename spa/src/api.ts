// Koinote 前端 API 封装
// 所有请求走同源 /api/*，dev 由 Vite 代理转发到 Go 后端，prod 由 Worker 代理。
// credentials:"include" 让浏览器带上 ka_session cookie，实现基于 cookie 的会话。

export type User = {
  id: number;
  authUserId: string;
  email: string;
  username?: string | null;
  nickname?: string | null;
  avatarUrl?: string | null;
  isVerified: boolean;
  isAdmin: boolean;
  createdAt?: string | null;
  updatedAt?: string | null;
};

// 带后端错误码的错误对象：code 供前端 i18n 翻译，message 为英文兜底。
export class ApiError extends Error {
  code?: string;
  status: number;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

async function toApiError(response: Response): Promise<ApiError> {
  let message = `Request failed (${response.status})`;
  let code: string | undefined;
  try {
    const data = await response.json();
    if (data && typeof data.error === "string") message = data.error;
    if (data && typeof data.code === "string") code = data.code;
  } catch {
    // 忽略解析失败，落到状态码兜底
  }
  return new ApiError(response.status, message, code);
}

export async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "include",
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    throw await toApiError(response);
  }
  return response.json() as Promise<T>;
}

export function register(params: {
  username: string;
  email: string;
  password: string;
}) {
  return apiJson<{ user: User }>("/api/auth/register", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

export function login(identifier: string, password: string) {
  return apiJson<{ user: User }>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username: identifier, password }),
  });
}

export function logout() {
  return apiJson<{ success: boolean }>("/api/auth/logout", { method: "POST" });
}

export function getSession() {
  return apiJson<{ user: User }>("/api/auth/session");
}

// ---------- 文档 ----------

export type Document = {
  docId: string;
  title: string;
  content: string;
  createdAt?: string | null;
  updatedAt?: string | null;
};

// 列表接口不返回 content，只够侧边栏渲染
export type DocumentSummary = {
  docId: string;
  title: string;
  updatedAt?: string | null;
};

export function listDocuments() {
  return apiJson<{ documents: DocumentSummary[] }>("/api/documents");
}

export function createDocument(params?: { title?: string; content?: string }) {
  return apiJson<{ document: Document }>("/api/documents", {
    method: "POST",
    body: JSON.stringify(params ?? {}),
  });
}

export function getDocument(docId: string) {
  return apiJson<{ document: Document }>(
    `/api/documents/${encodeURIComponent(docId)}`,
  );
}

export function updateDocument(
  docId: string,
  params: { title: string; content: string },
) {
  return apiJson<{ document: Document }>(
    `/api/documents/${encodeURIComponent(docId)}`,
    { method: "PUT", body: JSON.stringify(params) },
  );
}

export function deleteDocument(docId: string) {
  return apiJson<{ success: boolean }>(
    `/api/documents/${encodeURIComponent(docId)}`,
    { method: "DELETE" },
  );
}
