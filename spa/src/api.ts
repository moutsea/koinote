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

// 曾有第三档 "public"，与 "link" 行为完全相同，已删。
// 存量数据由后端 normalizeShareAccess 归一成 "link"，前端不必再认它。
export type ShareAccess = "link" | "password";

export type DocumentShare = {
  token: string;
  access: ShareAccess;
  requiresPassword: boolean;
  /** 后端因放宽权限换了新 token，老链接已失效 —— 需要提示用户重新分享 */
  tokenRotated?: boolean;
};

export type Document = {
  docId: string;
  title: string;
  /** 微信排版主题 id，空串表示不套主题 */
  theme: string;
  content: string;
  createdAt?: string | null;
  updatedAt?: string | null;
  /** null 表示未分享 */
  share?: DocumentShare | null;
};

/** 公开分享视图：不含任何内部标识 */
export type SharedDocument = {
  title: string;
  theme?: string;
  content: string;
  updatedAt?: string | null;
  ownerName?: string;
};

// 列表接口不返回 content，只够侧边栏渲染
export type DocumentSummary = {
  docId: string;
  title: string;
  /** null 表示在根下 */
  folderId: string | null;
  updatedAt?: string | null;
};

export function listDocuments() {
  return apiJson<{ documents: DocumentSummary[] }>("/api/documents");
}

export function createDocument(params?: {
  title?: string;
  content?: string;
  /** 直接建在这个文件夹里。省掉「建到根下再移动」那一步的闪烁 */
  folderId?: string | null;
}) {
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
  params: { title: string; content: string; theme?: string },
) {
  return apiJson<{ document: Document }>(
    `/api/documents/${encodeURIComponent(docId)}`,
    { method: "PUT", body: JSON.stringify(params) },
  );
}

// ---------- 文件夹 ----------

export type Folder = {
  folderId: string;
  name: string;
  /** null 表示在根下 */
  parentFolderId: string | null;
};

export function listFolders() {
  return apiJson<{ folders: Folder[] }>("/api/folders");
}

export function createFolder(params: {
  name: string;
  parentFolderId: string | null;
}) {
  return apiJson<{ folder: Folder }>("/api/folders", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

export function renameFolder(folderId: string, name: string) {
  return apiJson<{ folder: Folder }>(
    `/api/folders/${encodeURIComponent(folderId)}`,
    { method: "PUT", body: JSON.stringify({ name }) },
  );
}

export function deleteFolder(folderId: string) {
  return apiJson<{ ok: boolean }>(
    `/api/folders/${encodeURIComponent(folderId)}`,
    { method: "DELETE" },
  );
}

export function moveFolder(folderId: string, parentFolderId: string | null) {
  return apiJson<{ ok: boolean }>(
    `/api/folders/${encodeURIComponent(folderId)}/parent`,
    { method: "PUT", body: JSON.stringify({ parentFolderId }) },
  );
}

export function moveDocument(docId: string, folderId: string | null) {
  return apiJson<{ ok: boolean }>(
    `/api/documents/${encodeURIComponent(docId)}/folder`,
    { method: "PUT", body: JSON.stringify({ folderId }) },
  );
}

// ---------- 编辑器标签页 ----------

export type EditorTabs = {
  tabs: string[];
  /** null 表示一个都没打开 */
  activeDocId: string | null;
};

export function getEditorTabs() {
  return apiJson<EditorTabs>("/api/editor/tabs");
}

export function putEditorTabs(params: EditorTabs) {
  return apiJson<EditorTabs>("/api/editor/tabs", {
    method: "PUT",
    body: JSON.stringify(params),
  });
}

// ---------- 分享 ----------

export function createShare(
  docId: string,
  params: { access: ShareAccess; password?: string },
) {
  return apiJson<{ share: DocumentShare }>(
    `/api/documents/${encodeURIComponent(docId)}/share`,
    { method: "POST", body: JSON.stringify(params) },
  );
}

export function revokeShare(docId: string) {
  return apiJson<{ success: boolean }>(
    `/api/documents/${encodeURIComponent(docId)}/share`,
    { method: "DELETE" },
  );
}

/** 公开读取。口令档时返回 { requiresPassword: true }，不含正文。 */
export function getSharedDocument(token: string) {
  return apiJson<{ document?: SharedDocument; requiresPassword?: boolean }>(
    `/api/share/${encodeURIComponent(token)}`,
  );
}

export function verifySharePassword(token: string, password: string) {
  return apiJson<{ document: SharedDocument }>(
    `/api/share/${encodeURIComponent(token)}/verify`,
    { method: "POST", body: JSON.stringify({ password }) },
  );
}

// ---------- 图片 ----------

export type UploadedImage = {
  key: string;
  url: string;
  size: number;
  contentType: string;
};

// Worker 侧按 magic byte 校验真实类型，允许的集合与之保持一致
const UPLOADABLE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export function isUploadableImage(file: File): boolean {
  return UPLOADABLE_TYPES.has(file.type);
}

/**
 * 上传图片到 R2（由 Worker 处理，不经过 Go 后端）。
 *
 * 直接发原始字节而非 FormData：Worker 读的是 request.arrayBuffer()，
 * multipart 的分隔符会混进字节流，导致文件头校验失败。
 * 也因此不能复用 apiJson —— 它会强制 Content-Type: application/json，
 * 而 Worker 要拿这个头与真实文件头比对。
 */
export async function uploadImage(file: File): Promise<UploadedImage> {
  if (!isUploadableImage(file)) {
    // 前端先挡一道：服务端也会拒，但等一趟往返才报错体验更差
    throw new ApiError(415, "Unsupported image type", "image_type_unsupported");
  }

  const response = await fetch("/api/images", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": file.type },
    body: file,
  });
  if (!response.ok) {
    throw await toApiError(response);
  }
  const data = (await response.json()) as { image: UploadedImage };
  return data.image;
}

export function deleteDocument(docId: string) {
  return apiJson<{ success: boolean }>(
    `/api/documents/${encodeURIComponent(docId)}`,
    { method: "DELETE" },
  );
}
