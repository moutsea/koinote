// 支持的语言。默认 en（面向全球），zh/fr/ja 依次。
export const LOCALES = ["en", "zh", "fr", "ja"] as const;
export type Locale = (typeof LOCALES)[number];

export const LOCALE_LABELS: Record<Locale, string> = {
  en: "English",
  zh: "中文",
  fr: "Français",
  ja: "日本語",
};

// 完整文案结构。每个语言文件都必须实现它，TS 保证不漏 key。
export interface Messages {
  nav: {
    editor: string;
    dashboard: string;
    login: string;
    logout: string;
    /** 账户菜单触发器的无障碍名。按钮上显示的是用户名，读屏需要知道它是个菜单 */
    userMenu: string;
  };
  home: {
    badge: string;
    title: string;
    subtitle: string;
    ctaStart: string;
    ctaRegister: string;
    features: Array<{ title: string; desc: string }>;
  };
  auth: {
    loginTitle: string;
    loginSubtitle: string;
    registerTitle: string;
    registerSubtitle: string;
    username: string;
    usernamePlaceholder: string;
    email: string;
    emailPlaceholder: string;
    identifier: string;
    identifierPlaceholder: string;
    password: string;
    passwordPlaceholderLogin: string;
    passwordPlaceholderRegister: string;
    confirmPassword: string;
    confirmPasswordPlaceholder: string;
    submitLogin: string;
    submitRegister: string;
    processing: string;
    noAccount: string;
    hasAccount: string;
    toRegister: string;
    toLogin: string;
    passwordMismatch: string;
    requestFailed: string;
    orDivider: string;
    continueWithGoogle: string;
    continueWithGitHub: string;
  };
  storage: {
    /** 控制台卡片标题 */
    title: string;
    /** 「已用 {used} / 共 {quota}」 */
    usedOf: string;
    /** 「还剩 {remaining}」 */
    remaining: string;
    /** 分项标签：文档 */
    documents: string;
    /** 分项标签：图片 */
    images: string;
    /** 接近上限时的提示 */
    nearLimitHint: string;
    /** 已满时的提示 */
    fullHint: string;
    loading: string;
    loadFailed: string;
    /** 超额弹窗 */
    quotaDialogTitle: string;
    quotaDialogBody: string;
    quotaDialogHint: string;
    quotaDialogDismiss: string;
    quotaDialogManage: string;
  };
  dashboard: {
    greeting: string; // 用 {name} 占位
    subtitle: string;
    newDoc: string;
    account: string;
    username: string;
    notSet: string;
    joinedAt: string;
    myDocs: string;
    emptyHint: string; // 含「去编辑器」链接文案前后段
    emptyLinkText: string;
    loading: string;
    loginRequired: string;
    loginRequiredHint: string;
    goLogin: string;
  };
  editor: {
    placeholder: string;
    saving: string;
    saved: string;
    saveFailed: string;
    charCount: string; // 用 {n} 占位
    sample: string;
    untitled: string;
    titlePlaceholder: string;
    loginRequired: string;
    loginRequiredHint: string;
    goLogin: string;
    loading: string;
    notFound: string;
    backToList: string;
    // 侧边栏
    documentsPanel: string;
    outlinePanel: string;
    newDocument: string;
    deleteDocument: string;
    deleteConfirm: string; // 用 {title} 占位
    deleteSaveFailed: string;
    emptyDocuments: string;
    emptyOutline: string;
    collapsePanel: string;
    expandPanel: string;
    resizeDocuments: string;
    resizeOutline: string;
    uploadFailed: string;
    uploadingImages: string; // 用 {n} 占位
    rehostFailed: string;
    imageClickToEdit: string;
    imageMarkdownLabel: string;
    imageBroken: string;
    /** 重试期间的提示，与 imageBroken 分开：那 4 秒里说"加载失败"会让人以为没救了 */
    imageRetrying: string;
    // 分享
    share: string;
    shareTitle: string;
    shareAccessLink: string;
    shareAccessLinkHint: string;
    shareTokenRotated: string;
    shareAccessPassword: string;
    shareAccessPasswordHint: string;
    sharePasswordPlaceholder: string;
    shareEnable: string;
    shareUpdate: string;
    shareRevoke: string;
    shareRevokeConfirm: string;
    shareCopyLink: string;
    shareCopied: string;
    shareCopyFailed: string;
    shareNotShared: string;
    shareActive: string;
    shareClose: string;
    // 分享页（公开视图）
    sharedBy: string; // 用 {name} 占位
    sharedNotFound: string;
    sharedPasswordPrompt: string;
    sharedPasswordSubmit: string;
    sharedOpenApp: string;
    // 导出
    exportLabel: string;
    exportMarkdown: string;
    exportHTML: string;
    exportPDF: string;
    exportDOCX: string;
    exportPDFHint: string;
    exportPrint: string;
    exportPrintHint: string;
    wechatExport: string;
    wechatExportHint: string;
    wechatTitle: string;
    wechatSubtitle: string;
    wechatThemeLabel: string;
    themeNone: string;
    tabsLabel: string;
    closeTab: string;
    newFolder: string;
    renameFolder: string;
    deleteFolder: string;
    deleteFolderConfirm: string;
    untitledFolder: string;
    folderNamePlaceholder: string;
    dropToRoot: string;
    cannotDropIntoSelf: string;
    newSubfolder: string;
    newDocumentHere: string;
    treeMenu: string;
    wechatCopy: string;
    wechatCopied: string;
    wechatWorking: string;
    wechatCodeNote: string;
    wechatMathConverted: string;
    wechatMathFailed: string;
    wechatImagesUnreachable: string; // 用 {n} 和 {hosts} 占位
    exportFailed: string;
    exporting: string;
    importedLocalDraft: string;
    // 工具栏
    toolbar: {
      bold: string;
      italic: string;
      strike: string;
      code: string;
      heading1: string;
      heading2: string;
      heading3: string;
      bulletList: string;
      orderedList: string;
      taskList: string;
      blockquote: string;
      codeBlock: string;
      link: string;
      linkPrompt: string;
      hint: string;
    };
  };
  common: {
    theme: string;
    language: string;
  };
  footer: {
    tagline: string;
    brandCn: string;
    product: string;
    editor: string;
    dashboard: string;
    home: string;
    built: string;
    company: string;
    companyName: string;
    legal: string;
    privacy: string;
    terms: string;
    cookies: string;
    copyright: string;
    allRightsReserved: string;
    contact: string;
  };
  legal: {
    /** 「更新于 / 生效于」两个标签，日期由代码按 locale 格式化 */
    updatedLabel: string;
    effectiveLabel: string;
    backHome: string;
    relatedTitle: string;
    privacy: LegalDoc;
    terms: LegalDoc;
    cookies: LegalDoc;
  };
  // 后端错误码 → 文案。key 与 Go 后端返回的 code 对齐。
  errors: Record<string, string>;
}

/** 一份法律文档：标题 + 摘要 + 若干条款 */
export interface LegalDoc {
  title: string;
  summary: string;
  sections: LegalSection[];
}

export interface LegalSection {
  title: string;
  /** 段落。每项一段 */
  body: string[];
  /** 可选的要点列表，渲染成 ul */
  items?: string[];
}
