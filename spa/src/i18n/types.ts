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
    download: string;
    pricing: string;
    docs: string;
    mcpGuide: string;
    versionHistoryGuide: string;
    dashboard: string;
    documents: string;
    trash: string;
    invitations: string;
    admin: string;
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
    ctaDownload: string;
    ctaRegister: string;
    features: Array<{ title: string; desc: string }>;
    mcp: {
      eyebrow: string;
      title: string;
      description: string;
      agents: string;
      steps: Array<{ title: string; desc: string }>;
      cta: string;
    };
  };
  pricing: {
    eyebrow: string;
    title: string;
    subtitle: string;
    freeName: string;
    freeDescription: string;
    freePrice: string;
    freePeriod: string;
    lifetimeName: string;
    lifetimeDescription: string;
    lifetimePeriod: string;
    recommended: string;
    included: string;
    freeFeatures: string[];
    lifetimeFeatures: string[];
    loginToUpgrade: string;
    manageMembership: string;
    active: string;
    loading: string;
    loadFailed: string;
    unavailable: string;
    faqTitle: string;
    faqs: Array<{ question: string; answer: string }>;
  };
  mcpGuide: {
    eyebrow: string;
    title: string;
    subtitle: string;
    overviewTitle: string;
    overviewBody: string;
    setupTitle: string;
    setupSteps: Array<{ title: string; desc: string }>;
    clientsTitle: string;
    clientsSubtitle: string;
    clientDescriptions: string[];
    tokenPlaceholder: string;
    verifyLabel: string;
    usageTitle: string;
    usageBody: string;
    prompts: string[];
    permissionsTitle: string;
    permissions: string[];
    tokensCta: string;
    historyCta: string;
    pricingCta: string;
  };
  versionGuide: {
    eyebrow: string;
    title: string;
    subtitle: string;
    overviewTitle: string;
    overviewBody: string;
    availabilityTitle: string;
    availabilityBody: string;
    featuresTitle: string;
    features: Array<{ title: string; desc: string }>;
    webTitle: string;
    webSteps: string[];
    mcpTitle: string;
    mcpRules: string[];
    safetyTitle: string;
    safetyBody: string;
    settingsCta: string;
    mcpCta: string;
    pricingCta: string;
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
    verificationCode: string;
    verificationCodePlaceholder: string;
    sendVerificationCode: string;
    resendVerificationCode: string;
    sendingVerificationCode: string;
    verificationSent: string;
    verificationMockFilled: string;
    emailVerificationRequired: string;
    verifyEmailTitle: string;
    verifyEmailDescription: string;
    verifyAndLogin: string;
    backToLogin: string;
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
    emailRegistration: string;
    collapseEmailRegistration: string;
    invitationCode: string;
    invitationCodePlaceholder: string;
    invitationRewardTitle: string;
    invitationBonusHint: string;
    haveInvitationCode: string;
    forgotPassword: string;
    resetPasswordTitle: string;
    resetPasswordDescription: string;
    newPassword: string;
    resetPasswordSubmit: string;
    resetPasswordSuccess: string;
    resetCodeSent: string;
  };
  security: {
    title: string;
    description: string;
    oauthOnly: string;
    currentPassword: string;
    newPassword: string;
    confirmPassword: string;
    changePassword: string;
    changingPassword: string;
    passwordChanged: string;
    sessionsTitle: string;
    sessionsDescription: string;
    invalidateSessions: string;
    invalidatingSessions: string;
    sessionsInvalidated: string;
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
  membership: {
    title: string;
    lifetimeBadge: string;
    activeBadge: string;
    description: string;
    oneTimePayment: string;
    currencyLabel: string;
    currencyHint: string;
    storageBenefit: string;
    aiBenefit: string;
    aiComingSoon: string;
    purchase: string;
    redirecting: string;
    activeTitle: string;
    activeDescription: string;
    unavailable: string;
    loadFailed: string;
    checkoutSuccess: string;
    checkoutPending: string;
    checkoutCancelled: string;
    checkoutFailed: string;
  };
  mcp: {
    title: string;
    description: string;
    membersOnly: string;
    upgrade: string;
    tokenName: string;
    scope: string;
    readOnly: string;
    readWrite: string;
    expiry: string;
    days: string;
    neverExpires: string;
    editExpiry: string;
    saveExpiry: string;
    cancelExpiry: string;
    expiryUpdateFailed: string;
    create: string;
    createFailed: string;
    secretStored: string;
    activeTokens: string;
    loading: string;
    loadFailed: string;
    empty: string;
    expires: string;
    lastUsed: string;
    reveal: string;
    hide: string;
    revealFailed: string;
    legacyNotRevealable: string;
    revoke: string;
    revokeConfirm: string;
  };
  documentHistorySettings: {
    title: string;
    description: string;
    membersOnly: string;
    enabled: string;
    enabledHint: string;
    perDocumentMax: string;
    limitHint: string;
    mcpEnabled: string;
    mcpEnabledHint: string;
    loading: string;
    loadFailed: string;
    save: string;
    saved: string;
    saveFailed: string;
  };
  invitations: {
    title: string;
    headline: string;
    description: string;
    copyLink: string;
    copied: string;
    successful: string;
    earned: string;
    totalBonus: string;
    note: string;
    loading: string;
    loadFailed: string;
  };
  dashboard: {
    greeting: string; // 用 {name} 占位
    subtitle: string;
    newDoc: string;
    account: string;
    username: string;
    notSet: string;
    joinedAt: string;
    loading: string;
    loginRequired: string;
    loginRequiredHint: string;
    goLogin: string;
  };
  documentsPage: {
    title: string;
    subtitle: string;
    emptyHint: string;
    emptyLinkText: string;
  };
  search: {
    button: string;
    title: string;
    placeholder: string;
    hint: string;
    startTyping: string;
    noResults: string;
    loadFailed: string;
    titleMatch: string;
    contentMatch: string;
  };
  transfer: {
    importButton: string;
    importFolderButton: string;
    exportButton: string;
    importing: string;
    exporting: string;
    importSuccess: string;
    exportSuccess: string;
    importFailed: string;
    exportFailed: string;
    importHint: string;
  };
  trashPage: {
    title: string;
    subtitle: string;
    backToDocuments: string;
    empty: string;
    deletesOn: string;
    restore: string;
    deletePermanently: string;
    permanentWarning: string;
    typeToConfirm: string;
    loadFailed: string;
    actionFailed: string;
  };
  invitationsPage: {
    title: string;
    subtitle: string;
  };
  admin: {
    title: string;
    subtitle: string;
    refresh: string;
    loading: string;
    loginRequired: string;
    goLogin: string;
    forbidden: string;
    loadFailed: string;
    today: string;
    trafficUnavailable: string;
    trafficNotConfigured: string;
    trafficUpstreamError: string;
    trafficNote: string;
    pageViews: string;
    uniqueVisitors: string;
    requests: string;
    bandwidth: string;
    newUsers: string;
    newMembers: string;
    orders: string;
    overview: string;
    totalUsers: string;
    verifiedUsers: string;
    lifetimeMembers: string;
    conversionRate: string;
    documents: string;
    images: string;
    storageUsed: string;
    totalOrders: string;
    revenue: string;
    noRevenue: string;
    todayRevenue: string;
    orderCount: string;
    trend: string;
    trendHint: string;
    recentUsers: string;
    recentPayments: string;
    noUsers: string;
    noPayments: string;
    user: string;
    status: string;
    joinedAt: string;
    verified: string;
    unverified: string;
    free: string;
    lifetime: string;
    amount: string;
    paidAt: string;
    generatedAt: string;
    funnel: string;
    funnelHint: string;
    registered: string;
    firstDocument: string;
    firstUpload: string;
    firstExport: string;
    mcpConnected: string;
    checkoutStarted: string;
    checkoutCompleted: string;
    retention: string;
    retentionHint: string;
    day1Retention: string;
    day7Retention: string;
    day30Retention: string;
    retentionSample: string;
  };
  editor: {
    placeholder: string;
    saving: string;
    saved: string;
    saveFailed: string;
    resolveConflict: string;
    conflictTitle: string;
    conflictDescription: string;
    localDraft: string;
    remoteVersion: string;
    useRemote: string;
    saveMerged: string;
    conflictLoadFailed: string;
    conflictSaveFailed: string;
    history: string;
    historyTitle: string;
    historyDescription: string;
    historyEmpty: string;
    historyLoadFailed: string;
    historyRestoreFailed: string;
    historyConflict: string;
    restoreVersion: string;
    historySource: Record<"web" | "mcp" | "restore", string>;
    historySafetySnapshot: string;
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
    sharedViews: string;
    copyToMine: string;
    copyingToMine: string;
    copiedToMine: string;
    copyToMineFailed: string;
    loginToCopy: string;
    // 导出
    exportLabel: string;
    exportMarkdown: string;
    exportHTML: string;
    exportPDF: string;
    exportDOCX: string;
    exportPDFHint: string;
    exportPrint: string;
    exportPrintHint: string;
    mediaExport: string;
    mediaExportHint: string;
    mediaTitle: string;
    mediaSubtitle: string;
    mediaPlatformLabel: string;
    mediaWechat: string;
    mediaWechatHint: string;
    mediaZhihu: string;
    mediaZhihuHint: string;
    mediaJuejin: string;
    mediaJuejinHint: string;
    mediaCopy: string;
    mediaCopied: string;
    mediaWorking: string;
    mediaRichTextNote: string;
    mediaMarkdownNote: string;
    mediaImagesUnreachable: string;
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
    wechatMathConverted: string;
    wechatMathFailed: string;
    wechatMathTemporaryQuotaExceeded: string;
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
  changelog: {
    eyebrow: string;
    title: string;
    subtitle: string;
    unreleased: string;
    newLabel: string;
    sourceLink: string;
    sourceNote: string;
    categories: Record<string, string>;
  };
  desktopAuth: {
    eyebrow: string;
    title: string;
    description: string;
    permissionsTitle: string;
    permissionDocuments: string;
    permissionOffline: string;
    permissionIdentity: string;
    approve: string;
    cancel: string;
    signIn: string;
    invalid: string;
    failed: string;
  };
  desktopSync: {
    synced: string;
    syncing: string;
    offline: string;
    pending: string;
    error: string;
    conflicts: string;
    conflictsTitle: string;
    conflictsDescription: string;
    keepLocal: string;
    useCloud: string;
    close: string;
    logoutWarning: string;
    logoutSaveFailed: string;
  };
  footer: {
    tagline: string;
    brandCn: string;
    product: string;
    editor: string;
    download: string;
    pricing: string;
    dashboard: string;
    mcpGuide: string;
    versionHistoryGuide: string;
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
    changelog: string;
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
