// Koinote 前端 API 封装
// 所有请求走同源 /api/*，dev 由 Vite 代理转发到 Go 后端，prod 由 Worker 代理。
// credentials:"include" 让浏览器带上 koinote_session cookie，实现基于 cookie 的会话。

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

/**
 * 图床超额事件。超额时全局弹一次窗，而不是只在编辑器角落显示一行错误。
 *
 * 用事件而不是把回调层层传下去：上传会在三个地方失败（拖放上传、粘贴 base64、
 * 转存外链），加上 rehost 那条路，四处都要接同一个弹窗。事件让 api.ts 里
 * 构造错误的那一处广播，AppShell 里监听一次就够。
 *
 * 这是全局的，所以只用于"必须打断用户"的情况。普通上传失败仍走编辑器内的行内提示。
 */
export const IMAGE_QUOTA_EVENT = "koinote:image-quota-exceeded";

/**
 * 超额错误码。
 *
 * 两个而不是一个：图片上传超额由 Worker 回 image_quota_exceeded，
 * 文档保存超额由后端回 storage_quota_exceeded。两条路径的用户动作不同
 * （贴图 vs 打字），但要弹同一个窗 —— 都是"云端空间满了"。
 */
export const IMAGE_QUOTA_CODE = "image_quota_exceeded";
export const STORAGE_QUOTA_CODE = "storage_quota_exceeded";

const QUOTA_CODES = new Set<string>([IMAGE_QUOTA_CODE, STORAGE_QUOTA_CODE]);

export type ImageQuotaDetail = {
  usedBytes: number;
  quotaBytes: number;
  /** 分项。旧版后端可能不返回，所以是可选的 */
  documentBytes?: number;
  imageBytes?: number;
};

async function toApiError(response: Response): Promise<ApiError> {
  let message = `Request failed (${response.status})`;
  let code: string | undefined;
  let quota: ImageQuotaDetail | null = null;
  try {
    const data = await response.json();
    if (data && typeof data.error === "string") message = data.error;
    if (data && typeof data.code === "string") code = data.code;
    // 后端在 409 里回了当前用量，弹窗要用它显示"已用多少 / 共多少"
    if (
      data &&
      typeof data.usedBytes === "number" &&
      typeof data.quotaBytes === "number"
    ) {
      quota = {
        usedBytes: data.usedBytes,
        quotaBytes: data.quotaBytes,
        ...(typeof data.documentBytes === "number"
          ? { documentBytes: data.documentBytes }
          : {}),
        ...(typeof data.imageBytes === "number"
          ? { imageBytes: data.imageBytes }
          : {}),
      };
    }
  } catch {
    // 忽略解析失败，落到状态码兜底
  }

  if (code !== undefined && QUOTA_CODES.has(code) && typeof window !== "undefined") {
    // 用量缺失时给 0/0：storage.ts 的 usageRatio 把 quota<=0 当作"满"，
    // 弹窗仍然能正确表达"没空间了"，只是数字显示为 0
    window.dispatchEvent(
      new CustomEvent<ImageQuotaDetail>(IMAGE_QUOTA_EVENT, {
        detail: quota ?? { usedBytes: 0, quotaBytes: 0 },
      }),
    );
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

/**
 * 让服务端代抓一个外链图片并转存进图床。
 *
 * 为什么不在前端抓：浏览器受 CORS 限制读不到跨站图片的字节。<img> 能显示它，但
 * canvas/fetch 拿不到内容，所以「粘贴网页里的图并转存」只能由服务端代抓。
 *
 * 服务端那侧是个 SSRF 原语，防护见 worker/ssrf.ts。
 */
export function fetchImageToBucket(url: string) {
  return apiJson<{ image: UploadedImage }>("/api/images/fetch", {
    method: "POST",
    body: JSON.stringify({ url }),
  });
}

/**
 * 云端存储用量。配额的真值在后端，前端不写死。
 *
 * 分项给出是因为用户看到"满了"之后要知道该删什么 —— 只报总数的话，
 * 一个存了 400 MB 图片的人可能会去删文档，白费功夫。
 */
export type StorageUsage = {
  /** 总量，等于 documentBytes + imageBytes */
  usedBytes: number;
  /** 文档正文与标题（Postgres） */
  documentBytes: number;
  /** 图床对象（R2） */
  imageBytes: number;
  quotaBytes: number;
};

/**
 * 查当前用户的云端存储用量。
 *
 * 路径是 /api/storage/usage 而不是 /api/images/usage：Worker 对 /api/images/ 下的
 * 若干路径有专门分派，加一个同前缀的路由要改两处，容易漏。
 */
export function getStorageUsage() {
  return apiJson<StorageUsage>("/api/storage/usage");
}

export function deleteDocument(docId: string) {
  return apiJson<{ success: boolean }>(
    `/api/documents/${encodeURIComponent(docId)}`,
    { method: "DELETE" },
  );
}
