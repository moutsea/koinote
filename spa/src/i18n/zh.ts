import type { Messages } from "./types";

export const zh: Messages = {
  nav: {
    editor: "编辑器",
    dashboard: "控制台",
    login: "登录",
    logout: "登出",
    userMenu: "账户菜单",
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
  storage: {
    title: "图床用量",
    usedOf: "已用 {used} / 共 {quota}",
    remaining: "还剩 {remaining}",
    nearLimitHint: "空间快用完了，可以删掉不再需要的文档来腾出空间。",
    fullHint: "空间已满，无法再上传图片。删掉不再需要的文档即可腾出空间。",
    loading: "读取中…",
    loadFailed: "用量读取失败",
    quotaDialogTitle: "图床空间已满",
    quotaDialogBody: "你的图床已用 {used}，配额是 {quota}，这张图没能上传。",
    quotaDialogHint:
      "删掉不再需要的文档就能腾出空间 —— 文档删除后，其中的图片会由后台任务自动清理，通常几分钟内完成。",
    quotaDialogDismiss: "知道了",
    quotaDialogManage: "去控制台看用量",
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
    rehostFailed: "有图片没能转存到图床，仍是原站地址",
    imageClickToEdit: "点击编辑图片 Markdown（备注与地址）",
    imageMarkdownLabel: "图片 Markdown 源码",
    imageBroken: "图片加载失败，点击编辑地址",
    share: "分享",
    shareTitle: "分享此文档",
    shareAccessLink: "知道链接的人可访问",
    shareAccessLinkHint: "链接随机不可猜，但拿到即可打开",
    shareTokenRotated:
      "已生成新链接：口令保护被移除，原链接立即失效。若你已把旧链接发给别人，请重新分享。",
    shareAccessPassword: "需要口令",
    shareAccessPasswordHint: "访问者需输入口令，至少 6 位",
    sharePasswordPlaceholder: "设置访问口令",
    shareEnable: "开启分享",
    shareUpdate: "更新设置",
    shareRevoke: "停止分享",
    shareRevokeConfirm: "停止分享后现有链接立即失效，重新开启会生成新链接。确定吗？",
    shareCopyLink: "复制链接",
    shareCopied: "已复制",
    shareCopyFailed: "复制失败，请手动选择链接",
    shareNotShared: "尚未分享",
    shareActive: "分享中",
    shareClose: "关闭",
    sharedBy: "由 {name} 分享",
    sharedNotFound: "链接无效或已被撤销",
    sharedPasswordPrompt: "此文档需要口令才能查看",
    sharedPasswordSubmit: "查看",
    sharedOpenApp: "了解 Koinote",
    exportLabel: "导出",
    exportMarkdown: "Markdown (.md)",
    exportHTML: "网页 (.html)",
    exportPDF: "PDF",
    exportDOCX: "Word (.docx)",
    exportPDFHint: "直接下载，文字为图片",
    exportPrint: "打印 / 另存为 PDF",
    exportPrintHint: "文字可选可搜，需在对话框选「另存为 PDF」",
    wechatExport: "微信公众号",
    wechatExportHint: "选主题后复制，直接粘贴进公众号编辑器",
    wechatTitle: "导出到微信公众号",
    wechatSubtitle:
      "样式会内联到每个元素，粘贴后排版不丢。公式转成图片上传。",
    wechatThemeLabel: "排版主题",
    themeNone: "默认排版",
    tabsLabel: "已打开的文档",
    closeTab: "关闭标签",
    newFolder: "新建文件夹",
    renameFolder: "重命名",
    deleteFolder: "删除文件夹",
    deleteFolderConfirm:
      "删除文件夹「{name}」？里面的文档和子文件夹会移到上一层，不会被删除。",
    untitledFolder: "未命名文件夹",
    folderNamePlaceholder: "文件夹名称",
    dropToRoot: "拖到此处移出文件夹",
    cannotDropIntoSelf: "不能把文件夹移进它自己的子目录",
    newSubfolder: "新建子文件夹",
    newDocumentHere: "在此新建文档",
    treeMenu: "文件树操作",
    wechatCopy: "复制到剪贴板",
    wechatCopied: "已复制，去粘贴吧",
    wechatWorking: "处理中…",
    wechatCodeNote:
      "注意：微信会剥掉 class，代码块的语法高亮无法保留，只保留等宽字体与底色。",
    wechatMathConverted: "{n} 个公式已转为图片",
    wechatMathFailed: "{n} 个公式转换失败，已降级为 LaTeX 源码",
    exportFailed: "导出失败",
    exporting: "导出中…",
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
  footer: {
    tagline:
      "Koinote 是一个所见即所得的在线 Markdown 编辑器：边写边渲染、图片直传图床、一键导出与分享。",
    brandCn: "锦鲤笔记",
    product: "产品",
    editor: "编辑器",
    dashboard: "控制台",
    home: "首页",
    built: "我们还做了",
    company: "公司",
    companyName: "Fomalhaut Labs",
    legal: "法律",
    privacy: "隐私政策",
    terms: "服务条款",
    cookies: "Cookie 政策",
    copyright: "Koinote",
    allRightsReserved: "版权所有",
    contact: "联系我们",
  },
  legal: {
    updatedLabel: "更新于",
    effectiveLabel: "生效于",
    backHome: "返回首页",
    relatedTitle: "相关条款",
    terms: {
      title: "服务条款",
      summary:
        "本条款说明你使用 Koinote 时适用的规则。继续使用即表示你同意这些条款。",
      sections: [
        {
          title: "接受条款",
          body: [
            "访问或使用 Koinote 即表示你同意遵守本服务条款。如果你不同意其中任何一条，请停止使用本服务。",
          ],
        },
        {
          title: "服务说明",
          body: ["Koinote 提供在线 Markdown 写作、存储、导出与分享功能。"],
          items: [
            "所见即所得的 Markdown 编辑与自动保存",
            "文档与文件夹管理",
            "图片上传与托管（图床）",
            "导出为 Markdown、HTML、PDF、DOCX 及微信公众号格式",
            "生成只读分享链接，可选设置访问密码",
          ],
        },
        {
          title: "账号与安全",
          body: [
            "你需要对账号下的所有活动负责，包括妥善保管密码和登录会话。如发现账号被盗用，请尽快联系我们。",
          ],
          items: [
            "不得冒用他人身份注册",
            "不得与他人共用账号凭据",
            "发现安全漏洞请负责任地告知我们，不要公开利用",
          ],
        },
        {
          title: "你的内容",
          body: [
            "你写入 Koinote 的文档和上传的图片始终归你所有。我们不主张这些内容的所有权，也不会将其用于与提供本服务无关的目的。",
            "为了运行服务，我们需要在必要范围内存储、传输和展示这些内容 —— 例如把文档存进数据库、把图片放进对象存储、在你开启分享时向访问者展示。",
          ],
        },
        {
          title: "使用限制",
          body: ["以下行为可能导致账号被暂停或终止。"],
          items: [
            "上传或分享违法内容，包括侵权作品",
            "把图床当作通用文件分发或图片外链服务使用",
            "通过自动化手段绕过额度限制，或对服务发起压力测试",
            "尝试未授权访问他人文档或分享链接",
          ],
        },
        {
          title: "分享链接",
          body: [
            "开启分享后，持有链接的人即可查看该文档，无需登录。设置访问密码可以再加一层保护，但链接一旦泄露就等同于内容泄露 —— 请自行判断哪些内容适合分享。",
            "你可以随时撤销分享或重置链接，撤销后旧链接立即失效。",
          ],
        },
        {
          title: "服务可用性",
          body: [
            "我们会尽力保持服务稳定，但不承诺永不中断。维护、升级、依赖的第三方故障都可能导致临时不可用。重要内容请自行留一份导出备份。",
          ],
        },
        {
          title: "终止",
          body: [
            "如出现滥用、欺诈、安全风险或违反本条款的行为，我们可能暂停或终止你的访问。你也可以随时停止使用本服务。",
            "账号或文档被删除后，相关的图床文件会由后台任务异步清除，通常在数分钟内完成。",
          ],
        },
        {
          title: "免责与责任限制",
          body: [
            "本服务按「现状」提供。在适用法律允许的最大范围内，我们不对因使用或无法使用本服务而产生的间接损失、数据丢失或利润损失承担责任。",
          ],
        },
        {
          title: "条款变更",
          body: [
            "我们可能更新本条款。重大变更会在本页面标注更新日期；继续使用即表示接受更新后的条款。",
          ],
        },
        {
          title: "联系",
          body: ["关于本条款的问题，可以发送至 cfjwlchangji@gmail.com。"],
        },
      ],
    },
    privacy: {
      title: "隐私政策",
      summary:
        "本政策说明 Koinote 收集哪些信息、为什么收集、如何使用和保护，以及你可以如何控制它们。",
      sections: [
        {
          title: "我们收集的信息",
          body: ["我们只收集提供服务所必需的信息。"],
          items: [
            "账号信息：邮箱、用户名、昵称、加密存储的密码哈希",
            "使用第三方登录时，由 Google 或 GitHub 返回的基本资料（邮箱、用户名、头像）",
            "你创建的内容：文档标题与正文、文件夹结构、上传的图片",
            "分享设置：分享令牌、访问密码的哈希",
            "运行日志：请求时间、IP、User-Agent 等排障与防滥用所需的记录",
          ],
        },
        {
          title: "我们不收集什么",
          body: [
            "我们没有接入第三方广告或行为分析 SDK，不会为投放广告而画像，也不会把你的文档内容用于训练模型。",
          ],
        },
        {
          title: "信息如何使用",
          body: ["收集到的信息只用于以下目的。"],
          items: [
            "提供核心功能：保存与同步文档、托管图片、生成分享链接",
            "验证身份、维持登录会话",
            "排查故障、防止滥用与攻击",
            "在你主动联系时提供支持",
          ],
        },
        {
          title: "数据存储位置",
          body: [
            "文档正文与账号信息存放在我们自建的 PostgreSQL 数据库中。图片存放在 Cloudflare R2 对象存储，通过我们的 Worker 中转访问 —— 也就是说图片的访问凭据不会下发到浏览器。",
          ],
        },
        {
          title: "第三方服务",
          body: [
            "运行 Koinote 需要依赖少量基础设施服务商，它们只在各自的服务范围内处理数据。",
          ],
          items: [
            "Cloudflare：CDN、Workers 与 R2 对象存储",
            "Google、GitHub：仅在你选择用它们登录时，用于验证身份",
          ],
        },
        {
          title: "数据保留与删除",
          body: [
            "文档在你删除后即从数据库移除；其中引用的、且没有被你其他文档引用的图片，会进入待删队列由后台任务清除。",
            "如需删除整个账号及其全部数据，请发邮件联系我们。",
          ],
        },
        {
          title: "数据安全",
          body: [
            "我们使用 HTTPS 传输、密码哈希存储、数据库权限隔离等常规手段保护数据。但任何系统都无法保证绝对安全，请勿在文档中存放银行卡号、身份证件等高度敏感的信息。",
          ],
        },
        {
          title: "你的权利",
          body: [
            "你可以随时查看和修改自己的账号信息、导出全部文档、删除文档或账号。若你所在地区的法律赋予你访问、更正、导出或删除个人数据的权利，可以通过下方邮箱行使。",
          ],
        },
        {
          title: "儿童",
          body: [
            "本服务不面向 14 周岁以下的儿童。如果我们发现此类账号，会予以删除。",
          ],
        },
        {
          title: "联系",
          body: ["隐私相关的请求可以发送至 cfjwlchangji@gmail.com。"],
        },
      ],
    },
    cookies: {
      title: "Cookie 政策",
      summary:
        "本政策说明 Koinote 使用哪些 Cookie 和浏览器存储，以及它们各自的用途。",
      sections: [
        {
          title: "必要 Cookie",
          body: [
            "我们使用一个会话 Cookie 来记住你的登录状态。它设置了 HttpOnly 和 SameSite，无法被页面脚本读取。禁用它将无法登录。",
          ],
        },
        {
          title: "浏览器本地存储",
          body: [
            "以下偏好保存在浏览器的 localStorage 里，不会发送到服务器。清空浏览器数据即可重置。",
          ],
          items: [
            "koinote-theme：浅色 / 深色主题选择",
            "koinote-locale：界面语言",
            "未登录时的本地草稿，登录后会导入到你的账号",
          ],
        },
        {
          title: "我们不使用的",
          body: [
            "没有广告 Cookie，没有跨站跟踪像素，也没有第三方行为分析脚本。",
          ],
        },
        {
          title: "第三方 Cookie",
          body: [
            "当你选择用 Google 或 GitHub 登录时，会跳转到对应站点，它们可能设置自己的 Cookie。那部分受各自的隐私政策约束。",
          ],
        },
        {
          title: "管理方式",
          body: [
            "大多数浏览器都允许查看、阻止或删除 Cookie。需要注意的是，阻止会话 Cookie 会导致无法保持登录。",
          ],
        },
        {
          title: "联系",
          body: ["关于 Cookie 的问题可以发送至 cfjwlchangji@gmail.com。"],
        },
      ],
    },
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
    image_fetch_rejected: "这个图片地址不允许抓取",
    image_fetch_failed: "没能从原站取到这张图",
    too_deep: "文件夹层级太深，无法再往里新建",
    name_too_long: "文件夹名称过长",
    invalid_move: "不能把文件夹移到这里",
    not_found: "内容不存在或已被删除",
    image_type_unsupported: "只支持 PNG / JPEG / GIF / WebP 格式",
    image_type_mismatch: "文件内容与其格式不符",
    image_svg_rejected: "出于安全考虑，不支持 SVG 图片",
    image_too_large: "图片超过 10 MB 上限",
    image_quota_exceeded: "图床空间已满，删掉不再需要的文档可腾出空间",
    image_empty: "图片内容为空",
    share_not_found: "链接无效或已被撤销",
    share_access_invalid: "分享权限设置无效",
    share_password_too_short: "口令至少 6 位",
    share_password_invalid: "口令不正确",
    too_many_requests: "尝试过于频繁，请稍后再试",
  },
};
