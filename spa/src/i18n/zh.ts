import type { Messages } from "./types";

export const zh: Messages = {
  nav: {
    editor: "编辑器",
    dashboard: "控制台",
    login: "登录",
    logout: "登出",
  },
  home: {
    badge: "Markdown × AI，为创作而生",
    title: "写作，回到最纯粹的样子",
    subtitle:
      "Koinote 是一个 Typora 式的在线 Markdown 编辑器。边写边渲染、图床直连、AI 贴身协作，让你专注内容本身。",
    ctaStart: "立即开始写作",
    ctaRegister: "注册账号",
    features: [
      {
        title: "所见即所得",
        desc: "Typora 式单栏编辑，边写边渲染，告别源码/预览分屏。",
      },
      {
        title: "Markdown 保真",
        desc: "以 CommonMark 为核心，导入导出往返一致，随时迁移。",
      },
      {
        title: "图床深度集成",
        desc: "拖拽粘贴即传，接你自己的图床，正文只存干净链接。",
      },
      {
        title: "AI 贴合创作",
        desc: "续写、润色、翻译、配图，侧边栏助手随叫随到。",
      },
      {
        title: "便捷导出分享",
        desc: "Markdown / HTML 基础导出，只读链接一键分享。",
      },
      {
        title: "自动保存",
        desc: "输入即存，永不丢稿，云端多端同步（订阅解锁）。",
      },
    ],
  },
  auth: {
    loginTitle: "欢迎回来",
    loginSubtitle: "登录以继续你的创作",
    registerTitle: "创建账号",
    registerSubtitle: "注册后即可开始写作",
    username: "用户名",
    usernamePlaceholder: "给自己起个名字",
    email: "邮箱",
    emailPlaceholder: "you@example.com",
    identifier: "用户名或邮箱",
    identifierPlaceholder: "用户名或邮箱",
    password: "密码",
    passwordPlaceholderLogin: "输入密码",
    passwordPlaceholderRegister: "至少 6 位",
    confirmPassword: "确认密码",
    confirmPasswordPlaceholder: "再输一次密码",
    submitLogin: "登录",
    submitRegister: "注册",
    processing: "处理中…",
    noAccount: "还没有账号？",
    hasAccount: "已经有账号了？",
    toRegister: "注册",
    toLogin: "登录",
    passwordMismatch: "两次输入的密码不一致",
    requestFailed: "请求失败，请重试",
    orDivider: "或",
    continueWithGoogle: "使用 Google 登录",
    continueWithGitHub: "使用 GitHub 登录",
  },
  dashboard: {
    greeting: "你好，{name}",
    subtitle: "这是你的创作控制台。",
    newDoc: "新建文档",
    account: "账号",
    username: "用户名",
    notSet: "未设置",
    joinedAt: "加入时间",
    myDocs: "我的文档",
    emptyHint: "还没有云端文档。文档管理功能即将上线，",
    emptyLinkText: "先去编辑器",
    loading: "加载中…",
    loginRequired: "请先登录",
    loginRequiredHint: "登录后才能访问控制台。",
    goLogin: "去登录",
  },
  editor: {
    placeholder: "开始写点什么…… 输入 “# ” 变标题，“- ” 变列表，“```” 变代码块",
    saving: "保存中…",
    saved: "已保存",
    charCount: "{n} 字",
    saveFailed: "保存失败",
    untitled: "未命名文档",
    titlePlaceholder: "文档标题",
    loginRequired: "请先登录",
    loginRequiredHint: "登录后即可创建和管理你的文档",
    goLogin: "去登录",
    loading: "加载中…",
    notFound: "文档不存在或已被删除",
    backToList: "返回文档列表",
    documentsPanel: "文档",
    outlinePanel: "大纲",
    newDocument: "新建文档",
    deleteDocument: "删除文档",
    deleteConfirm: "确定删除《{title}》？此操作无法撤销。",
    emptyDocuments: "还没有文档，点上方新建一篇",
    emptyOutline: "输入 “# ” 添加标题，大纲会自动出现",
    collapsePanel: "收起面板",
    expandPanel: "展开面板",
    resizeDocuments: "调整文档面板宽度",
    resizeOutline: "调整大纲面板宽度",
    uploadFailed: "图片上传失败",
    uploadingImages: "上传中 {n} 张…",
    importedLocalDraft: "已导入本地草稿",
    toolbar: {
      bold: "粗体",
      italic: "斜体",
      strike: "删除线",
      code: "行内代码",
      heading1: "一级标题",
      heading2: "二级标题",
      heading3: "三级标题",
      bulletList: "无序列表",
      orderedList: "有序列表",
      taskList: "任务列表",
      blockquote: "引用",
      codeBlock: "代码块",
      link: "链接",
      linkPrompt: "输入链接地址",
      hint: "格式工具栏",
    },
    sample: `# 欢迎使用 Koinote

这是一个 **Typora 式** 的所见即所得 Markdown 编辑器 —— 边写边渲染，无需源码/预览分栏。

## 试试这些

- 输入 \`# \` 开头会变成标题
- 输入 \`- \` 会变成列表
- 输入 \`> \` 会变成引用
- 输入三个反引号会变成代码块

> 所有内容都以 Markdown 保真存储，随时导出。

\`\`\`js
function hello(name) {
  return \`Hello, \${name}!\`;
}
\`\`\`

| 特性 | 支持 |
|------|------|
| 标题 | ✅ |
| 表格 | ✅ |
| 代码高亮 | ✅ |

- [x] 支持任务列表
- [ ] 还没做完的事
`,
  },
  common: {
    theme: "切换主题",
    language: "语言",
  },
  errors: {
    bad_request: "请求格式错误",
    missing_fields: "用户名、邮箱、密码均为必填",
    invalid_email: "邮箱格式不正确",
    password_too_short: "密码至少 6 位",
    conflict: "邮箱或用户名已被注册",
    invalid_credentials: "账号或密码错误",
    unauthorized: "未登录",
    session_expired: "会话已失效",
    server_error: "服务器错误，请稍后重试",
    oauth_unsupported: "不支持的登录方式",
    oauth_not_configured: "该登录方式尚未配置",
    oauth_denied: "已取消授权",
    oauth_missing_params: "OAuth 回调参数缺失",
    oauth_invalid_state: "登录会话已过期，请重试",
    oauth_exchange_failed: "登录未能完成，请重试",
    oauth_profile_failed: "无法从平台读取你的资料",
    oauth_sync_failed: "账号同步失败，请重试",
    title_too_long: "标题过长",
    content_too_large: "文档过大，无法保存",
    not_found: "内容不存在或已被删除",
    image_type_unsupported: "只支持 PNG / JPEG / GIF / WebP 格式",
    image_type_mismatch: "文件内容与其格式不符",
    image_svg_rejected: "出于安全考虑，不支持 SVG 图片",
    image_too_large: "图片超过 10 MB 上限",
    image_empty: "图片内容为空",
  },
};
