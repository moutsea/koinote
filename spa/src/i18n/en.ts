import type { Messages } from "./types";

export const en: Messages = {
  nav: {
    editor: "Editor",
    pricing: "Pricing",
    docs: "Docs",
    mcpGuide: "MCP integration",
    versionHistoryGuide: "Version control",
    dashboard: "Dashboard",
    documents: "My documents",
    trash: "Trash",
    invitations: "Invite friends",
    admin: "Admin",
    login: "Log in",
    logout: "Log out",
    userMenu: "Account menu",
  },
  home: {
    badge: "Markdown × Agents, built for writing",
    title: "Writing, back to its purest form",
    subtitle:
      "Koinote is a Typora-style online Markdown editor. Render as you type, upload images inline, and let your agents work safely with your documents.",
    ctaStart: "Start writing",
    ctaRegister: "Create account",
    features: [
      {
        title: "What you see is what you get",
        desc: "Typora-style single-pane editing. Render as you type — no split source/preview.",
      },
      {
        title: "Markdown fidelity",
        desc: "CommonMark at the core. Import and export round-trip cleanly, migrate anytime.",
      },
      {
        title: "Deep image hosting",
        desc: "Drag & paste to upload. Bring your own image host; keep clean links in the body.",
      },
      {
        title: "Agent collaboration",
        desc: "Connect Codex, Claude Code, OpenCode, and other agents through MCP with scoped document access.",
      },
      {
        title: "Easy export & share",
        desc: "Markdown / HTML export out of the box. Share via read-only links in one click.",
      },
      {
        title: "Auto save",
        desc: "Saved as you type, with revision conflicts preventing browser and agent edits from silently overwriting each other.",
      },
    ],
    mcp: {
      eyebrow: "Open MCP access",
      title: "Bring agents into your writing workflow",
      description:
        "No browser extension required. Create a revocable, expiring personal token and let standard MCP clients such as Codex, Claude Code, and OpenCode search, read, and edit Koinote documents within the scope you grant.",
      agents: "Works with Streamable HTTP MCP clients",
      steps: [
        {
          title: "Scope access",
          desc: "Issue read-only or read-write tokens, then reveal, copy, or revoke them anytime.",
        },
        {
          title: "Write safely",
          desc: "Every mutation checks the document revision, so conflicts never overwrite silently.",
        },
        {
          title: "Keep recovery points",
          desc: "Members can tune full history, with a latest safety snapshot even when it is off.",
        },
      ],
      cta: "See membership benefits",
    },
  },
  pricing: {
    eyebrow: "Simple, transparent pricing",
    title: "Upgrade once, write with confidence",
    subtitle:
      "Free covers everyday writing. Lifetime adds more storage, MCP access, and version history with one payment.",
    freeName: "Free",
    freeDescription:
      "Everything needed to start writing and try the complete editor workflow.",
    freePrice: "Free",
    freePeriod: "Use it for as long as you like",
    lifetimeName: "Lifetime",
    lifetimeDescription: "Built for long-term writing and agent collaboration.",
    lifetimePeriod: "One payment, lifetime access",
    recommended: "Recommended",
    included: "What's included",
    freeFeatures: [
      "{storage} cloud storage for documents and images",
      "Full Markdown editing, autosave, and cross-device sync",
      "Image hosting, exports, and read-only sharing",
      "Earn extra cloud storage by inviting friends",
    ],
    lifetimeFeatures: [
      "{storage} cloud storage for documents and images",
      "MCP access for Codex, Claude Code, OpenCode, and other agents",
      "Configurable version history and safety-snapshot recovery",
      "Access to future AI capabilities",
      "Everything in Free",
    ],
    loginToUpgrade: "Log in to upgrade",
    manageMembership: "Manage membership and MCP",
    active: "Your lifetime membership is active",
    loading: "Loading current prices…",
    loadFailed: "Could not load pricing. Please try again.",
    unavailable: "Online checkout is not configured for this deployment.",
    faqTitle: "Frequently asked questions",
    faqs: [
      {
        question: "Is this a subscription?",
        answer:
          "No. Lifetime membership is a one-time payment with no automatic renewal.",
      },
      {
        question: "What can MCP do?",
        answer:
          "It lets authorized agents search, read, create, append, update, restore, and move documents to trash. Permanent deletion remains a web-only action.",
      },
      {
        question: "Can I recover after disabling full MCP history?",
        answer:
          "Yes. Member Agent writes always maintain at least the latest safety snapshot, sharing the normal version limits.",
      },
      {
        question: "Are the AI features available now?",
        answer:
          "Not yet. Lifetime membership includes eligibility for future AI capabilities as they are released.",
      },
    ],
  },
  mcpGuide: {
    eyebrow: "MCP integration guide",
    title: "Let your agents work safely with your documents",
    subtitle:
      "Connect Codex, Claude Code, OpenCode, OpenClaw, or any compatible Streamable HTTP MCP client to Koinote.",
    overviewTitle: "How it works",
    overviewBody:
      "Your agent provides the model capability. Koinote does not call an LLM or need a model API key; it handles authorization, document tools, revision conflicts, and audit records.",
    setupTitle: "Before you start",
    setupSteps: [
      { title: "Activate Lifetime", desc: "MCP is a Lifetime benefit." },
      {
        title: "Create a personal token",
        desc: "Choose read-only or read/write access and a fixed or permanent lifetime in Dashboard.",
      },
      {
        title: "Configure your client",
        desc: "Use the matching setup below for https://koinote.app/mcp.",
      },
    ],
    clientsTitle: "Connect each agent",
    clientsSubtitle:
      "A token is an account credential. Keep it in an environment variable or secure client storage, and never commit it to a repository.",
    clientDescriptions: [
      "Register the remote MCP in ~/.codex/config.toml, read the token from an environment variable, then restart Codex.",
      "Use the Claude Code CLI to add an HTTP MCP server with its Bearer authorization header.",
      "Declare a remote MCP in a global or project opencode.json and inject the header from an environment variable.",
      "Register the Streamable HTTP server with OpenClaw CLI, then run doctor to probe its tools.",
      "WorkBuddy and other clients only need Streamable HTTP support and a configurable Authorization header.",
    ],
    tokenPlaceholder:
      "Replace the placeholder with the token created in Dashboard",
    verifyLabel: "Try these prompts after setup",
    usageTitle: "Using Koinote from an agent",
    usageBody:
      "No special syntax is required. Say that you want to work with Koinote and the agent will select the MCP tools. Name the document and desired outcome explicitly for replacement or trash operations.",
    prompts: [
      "List the five documents I edited most recently in Koinote.",
      "Write an article about remote work and save it to Koinote.",
      "Find ‘Product launch checklist’ and append a post-launch review section.",
      "Move ‘Old draft’ to trash, but do not permanently delete it.",
    ],
    permissionsTitle: "Permissions and deletion boundaries",
    permissions: [
      "Read-only tokens can list, search, and read documents and history, but cannot change content.",
      "Read/write tokens can create, append, update, restore versions, and move documents into or out of trash.",
      "Agents cannot permanently delete documents; that requires confirmation in the web trash page.",
      "Tokens can be revoked individually and stop working when expired or membership becomes inactive.",
    ],
    tokensCta: "Create an MCP token",
    historyCta: "Learn about version control",
    pricingCta: "View membership benefits",
  },
  versionGuide: {
    eyebrow: "Version control guide",
    title: "Keep every important change recoverable",
    subtitle:
      "Learn how Koinote retains versions, coordinates browser and agent edits, and restores content after a mistake.",
    overviewTitle: "How version history works",
    overviewBody:
      "Browser edits and MCP writes share one revision and history policy. Versions support review and recovery, while revision checks prevent stale content from silently replacing newer work.",
    availabilityTitle: "Membership and retention limits",
    availabilityBody:
      "Version history is a Lifetime benefit. Each document can retain 1–100 versions, while the whole account shares a cap of 100; the oldest entries are pruned first when a limit is exceeded.",
    featuresTitle: "Core capabilities",
    features: [
      {
        title: "Throttled snapshots",
        desc: "Regular browser edits are grouped over time instead of creating a version on every autosave.",
      },
      {
        title: "Flexible limits",
        desc: "Enable or disable history and choose a per-document retention limit from 1 to 100.",
      },
      {
        title: "Safety snapshot",
        desc: "Even with full MCP history off, the latest recoverable state is kept before an agent replacement.",
      },
      {
        title: "Conflict detection",
        desc: "Updates require the latest revision. A stale write fails instead of replacing newer content.",
      },
      {
        title: "Undoable restores",
        desc: "The current state is saved before restoring an older version, so the restore can be reversed.",
      },
    ],
    webTitle: "Review and restore on the web",
    webSteps: [
      "Open Version history from the editor toolbar to see the versions retained for the current document.",
      "Each entry records its time and source: web editor, MCP agent, or a previous restore.",
      "Restoring makes that version current while preserving the pre-restore state as another recovery point.",
    ],
    mcpTitle: "Version policy for MCP writes",
    mcpRules: [
      "Choose separately whether agent writes retain full history.",
      "Turning full history off does not remove the safety snapshot for whole-document replacement.",
      "Authorized read/write MCP clients can inspect and update the policy; read-only tokens can only inspect it.",
    ],
    safetyTitle: "Recommended settings",
    safetyBody:
      "Keep version history and full MCP history enabled for important documents. Balance the per-document value against the shared 100-version account cap, and have agents read the latest revision before replacing a document.",
    settingsCta: "Change history settings",
    mcpCta: "View MCP integration",
    pricingCta: "View membership benefits",
  },
  auth: {
    loginTitle: "Welcome back",
    loginSubtitle: "Log in to continue writing",
    registerTitle: "Create your account",
    registerSubtitle: "Sign up and start writing",
    username: "Username",
    usernamePlaceholder: "Pick a name",
    email: "Email",
    emailPlaceholder: "you@example.com",
    identifier: "Username or email",
    identifierPlaceholder: "Username or email",
    password: "Password",
    passwordPlaceholderLogin: "Enter your password",
    passwordPlaceholderRegister: "At least 6 characters",
    confirmPassword: "Confirm password",
    confirmPasswordPlaceholder: "Enter the password again",
    verificationCode: "Email verification code",
    verificationCodePlaceholder: "6-digit code",
    sendVerificationCode: "Send code",
    resendVerificationCode: "Send again",
    sendingVerificationCode: "Sending…",
    verificationSent: "Verification code sent. Check your inbox.",
    verificationMockFilled: "The local test code was filled in automatically.",
    emailVerificationRequired:
      "Your password is correct. Please verify your email to continue.",
    verifyEmailTitle: "Email not verified",
    verifyEmailDescription:
      "Send a code to the email below. You will be logged in after verification.",
    verifyAndLogin: "Verify and log in",
    backToLogin: "Back to login",
    submitLogin: "Log in",
    submitRegister: "Sign up",
    processing: "Processing…",
    noAccount: "Don't have an account?",
    hasAccount: "Already have an account?",
    toRegister: "Sign up",
    toLogin: "Log in",
    passwordMismatch: "The two passwords do not match",
    requestFailed: "Request failed, please try again",
    orDivider: "or",
    continueWithGoogle: "Continue with Google",
    continueWithGitHub: "Continue with GitHub",
    emailRegistration: "Sign up with email",
    collapseEmailRegistration: "Hide email sign-up",
    invitationCode: "Invitation code (optional)",
    invitationCodePlaceholder: "Enter a 16-character code",
    invitationRewardTitle: "A friend sent you 500 MB of storage",
    invitationBonusHint:
      "Finish with Google, GitHub, or email. Your friend also receives 500 MB when you join.",
    haveInvitationCode: "Have an invitation code?",
    forgotPassword: "Forgot password?",
    resetPasswordTitle: "Reset your password",
    resetPasswordDescription:
      "Enter your account email and we will send a one-time code. The page shows the same result whether or not the address exists.",
    newPassword: "New password",
    resetPasswordSubmit: "Reset password",
    resetPasswordSuccess:
      "Your password has been reset. Sign in with the new password; old sessions on other devices are no longer valid.",
    resetCodeSent:
      "If this email belongs to a password account, a code has been sent. Check your inbox.",
  },
  security: {
    title: "Account security",
    description:
      "Changing your password keeps this device signed in and immediately invalidates older sessions elsewhere.",
    oauthOnly:
      "This account currently signs in with Google or GitHub and does not have a Koinote password to change.",
    currentPassword: "Current password",
    newPassword: "New password",
    confirmPassword: "Confirm new password",
    changePassword: "Change password",
    changingPassword: "Changing…",
    passwordChanged:
      "Password changed. Older sessions on other devices have been signed out.",
    sessionsTitle: "Login sessions",
    sessionsDescription:
      "Keep this browser signed in and immediately sign out other browsers and devices.",
    invalidateSessions: "Sign out other devices",
    invalidatingSessions: "Signing out…",
    sessionsInvalidated:
      "Older sessions on other devices have been signed out.",
  },
  storage: {
    title: "Cloud storage",
    documents: "Documents",
    images: "Images",
    usedOf: "{used} of {quota} used",
    remaining: "{remaining} left",
    nearLimitHint:
      "You're running low on cloud storage. Permanently delete documents from Trash to free space.",
    fullHint:
      "Cloud storage is full, so new documents and images can't be saved. Permanently delete unneeded documents from Trash to free space.",
    loading: "Loading…",
    loadFailed: "Couldn't load storage usage",
    quotaDialogTitle: "Cloud storage is full",
    quotaDialogBody:
      "You've used {used} of your {quota} cloud storage, so that didn't go through.",
    quotaDialogHint:
      "Documents in Trash still use storage. After permanent deletion, unreferenced images are cleaned up by a background job.",
    quotaDialogDismiss: "Got it",
    quotaDialogManage: "View usage",
  },
  membership: {
    title: "Koinote Lifetime",
    lifetimeBadge: "Lifetime",
    activeBadge: "Active",
    description:
      "A one-time upgrade for more room to write, plus access to future AI features.",
    oneTimePayment: "One-time payment, yours for life",
    currencyLabel: "Payment currency",
    currencyHint: "Stripe Checkout will charge you in the selected currency.",
    storageBenefit: "10 GB cloud storage",
    aiBenefit: "Access to future AI features",
    aiComingSoon: "AI features are coming later",
    purchase: "Get lifetime access",
    redirecting: "Opening secure checkout…",
    activeTitle: "Lifetime membership unlocked",
    activeDescription:
      "Your account includes 10 GB of cloud storage and future AI access.",
    unavailable: "Membership checkout is not configured on this deployment.",
    loadFailed: "Couldn't load membership status.",
    checkoutSuccess: "Payment confirmed. Your lifetime membership is active.",
    checkoutPending:
      "Payment is still being confirmed. Your access will update automatically.",
    checkoutCancelled: "Checkout was cancelled. You were not charged.",
    checkoutFailed: "Checkout couldn't be completed. Please try again.",
  },
  mcp: {
    title: "Agent document access (MCP)",
    description:
      "Let Codex, Claude Code, OpenCode, and other standard MCP agents read or edit your Koinote documents within the scope you grant.",
    membersOnly:
      "MCP access is a paid-member benefit. Upgrade to create revocable tokens with a fixed or permanent lifetime.",
    upgrade: "Upgrade to lifetime",
    tokenName: "Token name",
    scope: "Scope",
    readOnly: "Read only",
    readWrite: "Read and write",
    expiry: "Expires in",
    days: "{n} days",
    neverExpires: "Never expires",
    editExpiry: "Edit expiry",
    saveExpiry: "Save expiry",
    cancelExpiry: "Cancel editing",
    expiryUpdateFailed: "Could not update the expiry. Please try again.",
    create: "Create token",
    createFailed: "Could not create the token. Please try again.",
    secretStored:
      "The token is stored encrypted and can be viewed or copied again below.",
    activeTokens: "Active tokens",
    loading: "Loading…",
    loadFailed: "Could not load tokens",
    empty: "No active tokens yet.",
    expires: "Expires",
    lastUsed: "Last used",
    reveal: "View",
    hide: "Hide",
    revealFailed: "Could not reveal the token. Please try again.",
    legacyNotRevealable:
      "This legacy token cannot be recovered. It still works, or you can revoke and recreate it.",
    revoke: "Revoke",
    revokeConfirm:
      "Connected agents will lose access immediately. Revoke this token?",
  },
  documentHistorySettings: {
    title: "Version history",
    description:
      "Choose whether documents keep recovery versions and how web and Agent writes are retained.",
    membersOnly:
      "Version history is a lifetime membership benefit. Upgrade to configure retention.",
    enabled: "Enable version history",
    enabledHint:
      "Turning this off stops new browser snapshots without deleting retained versions; Agent writes still keep the latest safety snapshot.",
    perDocumentMax: "Versions per document",
    limitHint:
      "This is a per-document limit; all documents share the account-wide cap of {accountMax} versions. Lowering it prunes older snapshots immediately.",
    mcpEnabled: "Keep full history for MCP writes",
    mcpEnabledHint:
      "When off, Agent writes still keep the latest safety snapshot so a full replacement remains recoverable. It counts toward the version limits.",
    loading: "Loading version history settings…",
    loadFailed: "Could not load version history settings",
    save: "Save settings",
    saved: "Settings saved",
    saveFailed: "Could not save settings. Please try again.",
  },
  invitations: {
    title: "Invitation rewards",
    headline: "Invite a friend — you both get {reward}",
    description:
      "When a friend registers through your personal link, both accounts permanently gain {reward} of cloud storage.",
    copyLink: "Copy invitation link",
    copied: "Copied",
    successful: "Successful invites",
    earned: "Earned from invites",
    totalBonus: "Total bonus storage",
    note: "Rewards are granted when the new account is created, up to {limit} per account. Existing accounts cannot claim or repeat them.",
    loading: "Loading invitation details…",
    loadFailed: "Couldn't load invitation details",
  },
  dashboard: {
    greeting: "Hi, {name}",
    subtitle: "This is your writing dashboard.",
    newDoc: "New document",
    account: "Account",
    username: "Username",
    notSet: "Not set",
    joinedAt: "Joined",
    loading: "Loading…",
    loginRequired: "Please log in",
    loginRequiredHint: "You need to log in to access your account pages.",
    goLogin: "Go to login",
  },
  documentsPage: {
    title: "My documents",
    subtitle: "View and continue editing documents saved in the cloud.",
    emptyHint: "No cloud documents yet. ",
    emptyLinkText: "Create your first document",
  },
  search: {
    button: "Search",
    title: "Search all documents",
    placeholder: "Search titles and content…",
    hint: "Press ⌘K / Ctrl+K anywhere",
    startTyping: "Enter a keyword to search your titles and Markdown content.",
    noResults: "No matching documents.",
    loadFailed: "Search failed. Please try again.",
    titleMatch: "Title match",
    contentMatch: "Content match",
  },
  transfer: {
    importButton: "Import files",
    importFolderButton: "Import folder",
    exportButton: "Export all",
    importing: "Importing documents and images…",
    exporting: "Packaging documents and images…",
    importSuccess: "Imported {count} documents.",
    exportSuccess: "Your migration archive is ready.",
    importFailed:
      "Import failed. Check the file format, image sizes, and storage quota.",
    exportFailed: "Export failed. Please try again.",
    importHint:
      "Supports .md files, folders, and ZIP archives; referenced images migrate with them.",
  },
  trashPage: {
    title: "Trash",
    subtitle:
      "Documents are kept for 30 days and continue to use cloud storage during that time.",
    backToDocuments: "Back to documents",
    empty: "Trash is empty.",
    deletesOn: "Permanently deleted on {date}",
    restore: "Restore",
    deletePermanently: "Delete permanently",
    permanentWarning:
      "Permanent deletion also removes version history and cannot be undone. Continue?",
    typeToConfirm: "Type “{title}” to confirm permanent deletion:",
    loadFailed: "Could not load trash. Please try again.",
    actionFailed:
      "The action failed. Check the confirmation text or try again.",
  },
  invitationsPage: {
    title: "Invite friends",
    subtitle: "Share your personal invitation link and track rewards.",
  },
  admin: {
    title: "Admin",
    subtitle: "Monitor site growth, memberships, revenue, and operations.",
    refresh: "Refresh",
    loading: "Loading site metrics…",
    loginRequired: "Log in with an administrator account first.",
    goLogin: "Log in",
    forbidden: "This page is available to administrators only.",
    loadFailed: "Metrics could not be loaded. Please try again later.",
    today: "Today",
    trafficUnavailable: "Cloudflare traffic metrics are unavailable",
    trafficNotConfigured:
      "A read-only Analytics token has not been configured. Business metrics are unaffected.",
    trafficUpstreamError:
      "Cloudflare Analytics could not be reached. Business metrics remain available.",
    trafficNote:
      "UV and PV use Cloudflare edge HTTP Analytics and may include legitimate crawlers and allowed automated traffic.",
    pageViews: "Page views",
    uniqueVisitors: "Unique visitors",
    requests: "HTTP requests",
    bandwidth: "Edge bandwidth",
    newUsers: "New users",
    newMembers: "New members",
    orders: "Orders",
    overview: "All-time business metrics",
    totalUsers: "Total users",
    verifiedUsers: "Verified users",
    lifetimeMembers: "Lifetime members",
    conversionRate: "Member conversion",
    documents: "Documents",
    images: "Image objects",
    storageUsed: "Site storage used",
    totalOrders: "Total orders",
    revenue: "Revenue by currency",
    noRevenue: "No completed payments yet.",
    todayRevenue: "Revenue today",
    orderCount: "{count} orders",
    trend: "Last 30 days",
    trendHint: "Daily new users, members, and orders in the site timezone.",
    recentUsers: "Recent users",
    recentPayments: "Recent payments",
    noUsers: "No users yet.",
    noPayments: "No payments yet.",
    user: "User",
    status: "Status",
    joinedAt: "Joined",
    verified: "Email verified",
    unverified: "Email unverified",
    free: "Free",
    lifetime: "Lifetime",
    amount: "Amount",
    paidAt: "Paid",
    generatedAt: "Updated {time} · {timeZone}",
    funnel: "Product funnel",
    funnelHint:
      "Counts first-time milestones only; document content, titles, search terms, and filenames are never recorded.",
    registered: "Registered",
    firstDocument: "First document",
    firstUpload: "First upload",
    firstExport: "First export",
    mcpConnected: "MCP connected",
    checkoutStarted: "Checkout started",
    checkoutCompleted: "Payment completed",
    retention: "User retention",
    retentionHint:
      "Exact D1 / D7 / D30 return rates by UTC registration date, for users who joined after tracking began.",
    day1Retention: "D1 retention",
    day7Retention: "D7 retention",
    day30Retention: "D30 retention",
    retentionSample: "{returned} / {eligible} users",
  },
  editor: {
    placeholder:
      'Start writing… type "# " for a heading, "- " for a list, "```" for a code block',
    saving: "Saving…",
    saved: "Saved",
    charCount: "{n} chars",
    saveFailed: "Save failed",
    resolveConflict: "Resolve conflict",
    conflictTitle: "This document changed elsewhere",
    conflictDescription:
      "Your local draft is on the left and the latest cloud version is on the right. Edit the merged draft on the left, or accept the cloud version.",
    localDraft: "Local draft (editable)",
    remoteVersion: "Latest cloud version",
    useRemote: "Use cloud version",
    saveMerged: "Save merged draft",
    conflictLoadFailed:
      "Could not load the cloud version. Your local draft remains saved in this browser.",
    conflictSaveFailed:
      "The document changed again while saving. Reload and merge again.",
    history: "History",
    historyTitle: "Version history",
    historyDescription:
      "Inspect and restore the versions currently retained for this document.",
    historyEmpty: "No recovery versions yet.",
    historyLoadFailed: "Could not load version history",
    historyRestoreFailed: "Could not restore this version",
    historyConflict:
      "The document changed again. Close and reopen version history.",
    restoreVersion: "Restore this version",
    historySource: { web: "Web editor", mcp: "MCP Agent", restore: "Restore" },
    historySafetySnapshot: "Safety snapshot",
    untitled: "Untitled",
    titlePlaceholder: "Document title",
    loginRequired: "Please sign in first",
    loginRequiredHint: "Sign in to create and manage your documents",
    goLogin: "Sign in",
    loading: "Loading…",
    notFound: "This document doesn't exist or has been deleted",
    backToList: "Back to documents",
    documentsPanel: "Documents",
    outlinePanel: "Outline",
    newDocument: "New document",
    deleteDocument: "Move to trash",
    deleteConfirm:
      "Move “{title}” to trash? You can restore it within 30 days.",
    deleteSaveFailed:
      "The latest changes could not be saved, so the document was not deleted. Check your connection and try again.",
    emptyDocuments: "No documents yet — create one above",
    emptyOutline: "Type “# ” to add a heading; the outline appears here",
    collapsePanel: "Collapse panel",
    expandPanel: "Expand panel",
    resizeDocuments: "Resize documents panel",
    resizeOutline: "Resize outline panel",
    uploadFailed: "Image upload failed",
    uploadingImages: "Uploading {n}…",
    rehostFailed:
      "Some images could not be copied to your image store and still point at the original site",
    imageClickToEdit: "Click to edit image Markdown (caption and URL)",
    imageMarkdownLabel: "Image Markdown source",
    imageBroken: "Image failed to load — click to edit the URL",
    imageRetrying: "Loading image, retrying…",
    share: "Share",
    shareTitle: "Share this document",
    shareAccessLink: "Anyone with the link",
    shareAccessLinkHint:
      "The link is random and unguessable, but works for anyone who has it",
    shareTokenRotated:
      "A new link was generated: removing the password invalidated the old link immediately. If you already sent the old one, share again.",
    shareAccessPassword: "Password required",
    shareAccessPasswordHint:
      "Visitors must enter a password, at least 6 characters",
    sharePasswordPlaceholder: "Set an access password",
    shareEnable: "Enable sharing",
    shareUpdate: "Update settings",
    shareRevoke: "Stop sharing",
    shareRevokeConfirm:
      "Existing links stop working immediately, and re-enabling creates a new one. Continue?",
    shareCopyLink: "Copy link",
    shareCopied: "Copied",
    shareCopyFailed: "Copy failed — select the link manually",
    shareNotShared: "Not shared",
    shareActive: "Sharing",
    shareClose: "Close",
    sharedBy: "Shared by {name}",
    sharedNotFound: "This link is invalid or has been revoked",
    sharedPasswordPrompt: "This document requires a password",
    sharedPasswordSubmit: "View",
    sharedOpenApp: "About Koinote",
    sharedViews: "{count} reads",
    copyToMine: "Copy to my Koinote",
    copyingToMine: "Copying…",
    copiedToMine: "Copied. Opening the document…",
    copyToMineFailed:
      "Copy failed. Check your storage quota or the image status.",
    loginToCopy: "Sign in to copy to my Koinote",
    exportLabel: "Export",
    exportMarkdown: "Markdown (.md)",
    exportHTML: "Web page (.html)",
    exportPDF: "PDF",
    exportDOCX: "Word (.docx)",
    exportPDFHint: "Downloads directly; text becomes an image",
    exportPrint: "Print / Save as PDF",
    exportPrintHint:
      "Selectable, searchable text — choose “Save as PDF” in the dialog",
    mediaExport: "Export to publishing platforms",
    mediaExportHint: "Optimized for WeChat, Zhihu, and Juejin",
    mediaTitle: "Export to a publishing platform",
    mediaSubtitle:
      "Choose a destination and we will copy the format best suited to its editor.",
    mediaPlatformLabel: "Publishing platform",
    mediaWechat: "WeChat",
    mediaWechatHint: "Styled rich text",
    mediaZhihu: "Zhihu",
    mediaZhihuHint: "Adapted rich text",
    mediaJuejin: "Juejin",
    mediaJuejinHint: "Native Markdown",
    mediaCopy: "Copy to clipboard",
    mediaCopied: "Copied — go paste it",
    mediaWorking: "Working…",
    mediaRichTextNote:
      "Code highlighting, captions, and formulas become pasteable rich text. The destination may still sanitize some styles.",
    mediaMarkdownNote:
      "Copies complete Markdown with the article title, ready to paste into Juejin.",
    mediaImagesUnreachable:
      "{n} image(s) may be unreachable by the destination ({hosts}). Preview after pasting.",
    wechatThemeLabel: "Theme",
    themeNone: "Default styling",
    tabsLabel: "Open documents",
    closeTab: "Close tab",
    newFolder: "New folder",
    renameFolder: "Rename",
    deleteFolder: "Delete folder",
    deleteFolderConfirm:
      "Delete folder “{name}”? Documents and subfolders inside will move up one level, not be deleted.",
    untitledFolder: "Untitled folder",
    folderNamePlaceholder: "Folder name",
    dropToRoot: "Drop here to move out of any folder",
    cannotDropIntoSelf: "Cannot move a folder into its own subfolder",
    newSubfolder: "New subfolder",
    newDocumentHere: "New document here",
    treeMenu: "File tree actions",
    wechatMathConverted: "{n} formula(s) converted to images",
    wechatMathFailed: "{n} formula(s) failed; fell back to LaTeX source",
    wechatMathTemporaryQuotaExceeded:
      "Temporary formula-image storage is full. {n} formula(s) fell back to LaTeX; try again after older export images expire.",
    exportFailed: "Export failed",
    exporting: "Exporting…",
    importedLocalDraft: "Local draft imported",
    toolbar: {
      bold: "Bold",
      italic: "Italic",
      strike: "Strikethrough",
      code: "Inline code",
      heading1: "Heading 1",
      heading2: "Heading 2",
      heading3: "Heading 3",
      bulletList: "Bullet list",
      orderedList: "Numbered list",
      taskList: "Task list",
      blockquote: "Quote",
      codeBlock: "Code block",
      link: "Link",
      linkPrompt: "Enter the URL",
      hint: "Formatting toolbar",
    },
    sample: `# Welcome to Koinote

This is a **Typora-style** WYSIWYG Markdown editor — render as you type, no split source/preview.

## Try these

- Type \`# \` to make a heading
- Type \`- \` to make a list
- Type \`> \` to make a quote
- Type three backticks to make a code block

> Everything is stored as faithful Markdown, ready to export anytime.

\`\`\`js
function hello(name) {
  return \`Hello, \${name}!\`;
}
\`\`\`

| Feature | Supported |
|---------|-----------|
| Heading | ✅ |
| Table   | ✅ |
| Code highlight | ✅ |

- [x] Task lists supported
- [ ] Something still to do
`,
  },
  common: {
    theme: "Toggle theme",
    language: "Language",
  },
  changelog: {
    eyebrow: "Always improving",
    title: "Changelog",
    subtitle: "See what Koinote adds, improves, and fixes in every release.",
    unreleased: "Coming next",
    sourceLink: "View the source on GitHub",
    sourceNote:
      "This page is generated from the same CHANGELOG.md maintained in the open-source repository.",
    categories: {
      Added: "Added",
      Changed: "Changed",
      Fixed: "Fixed",
      Security: "Security",
      Deprecated: "Deprecated",
      Removed: "Removed",
    },
  },
  footer: {
    tagline:
      "Koinote is a WYSIWYG online Markdown editor: render as you type, upload images straight to your image store, export and share in one click.",
    brandCn: "锦鲤笔记",
    product: "Product",
    editor: "Editor",
    pricing: "Pricing",
    dashboard: "Dashboard",
    mcpGuide: "MCP integration guide",
    versionHistoryGuide: "Version control guide",
    home: "Home",
    built: "We also built",
    company: "Company",
    companyName: "Fomalhaut Labs",
    legal: "Legal",
    privacy: "Privacy Policy",
    terms: "Terms of Service",
    cookies: "Cookie Policy",
    copyright: "Koinote",
    allRightsReserved: "All rights reserved",
    contact: "Contact",
    changelog: "Changelog",
  },
  legal: {
    updatedLabel: "Updated",
    effectiveLabel: "Effective",
    backHome: "Back to home",
    relatedTitle: "Related policies",
    terms: {
      title: "Terms of Service",
      summary:
        "These terms govern your use of Koinote. By continuing to use the service, you agree to them.",
      sections: [
        {
          title: "Acceptance of Terms",
          body: [
            "By accessing or using Koinote you agree to be bound by these terms. If you disagree with any part of them, please stop using the service.",
          ],
        },
        {
          title: "What the Service Does",
          body: [
            "Koinote provides online Markdown writing, storage, export, and sharing.",
          ],
          items: [
            "WYSIWYG Markdown editing with autosave",
            "Document and folder management",
            "Image upload and hosting",
            "Export to Markdown, HTML, PDF, DOCX, and formats adapted for WeChat, Zhihu, and Juejin",
            "Read-only share links, optionally password-protected",
          ],
        },
        {
          title: "Your Account",
          body: [
            "You are responsible for all activity under your account, including keeping your password and sessions secure. If you believe your account has been compromised, contact us promptly.",
          ],
          items: [
            "Do not register under someone else's identity",
            "Do not share your credentials",
            "Report security issues to us responsibly rather than exploiting them publicly",
          ],
        },
        {
          title: "Your Content",
          body: [
            "The documents you write and the images you upload remain yours. We claim no ownership over them and will not use them for anything unrelated to running the service.",
            "To operate the service we do need to store, transmit, and display that content as required — writing documents to the database, putting images in object storage, and showing them to visitors when you enable sharing.",
          ],
        },
        {
          title: "Acceptable Use",
          body: ["The following may lead to suspension or termination."],
          items: [
            "Uploading or sharing unlawful content, including infringing material",
            "Using the image store as general file distribution or image hotlinking",
            "Circumventing quotas through automation, or load-testing the service",
            "Attempting unauthorized access to other people's documents or share links",
          ],
        },
        {
          title: "Share Links",
          body: [
            "Once sharing is enabled, anyone holding the link can view that document without logging in. A password adds a second layer, but a leaked link is a leaked document — judge for yourself what is appropriate to share.",
            "You can revoke sharing or rotate the link at any time; old links stop working immediately.",
          ],
        },
        {
          title: "Availability",
          body: [
            "We aim to keep the service stable but do not promise uninterrupted access. Maintenance, upgrades, and third-party outages can all cause temporary downtime. Keep your own exported backup of anything important.",
          ],
        },
        {
          title: "Termination",
          body: [
            "We may suspend or terminate access in cases of abuse, fraud, security risk, or breach of these terms. You may stop using the service at any time.",
            "Documents first enter a 30-day trash. Related images are removed asynchronously only after permanent deletion or expiry, and only when no other document references them.",
          ],
        },
        {
          title: "Disclaimer and Limitation of Liability",
          body: [
            'The service is provided "as is". To the maximum extent permitted by applicable law, we are not liable for indirect losses, data loss, or lost profits arising from your use of or inability to use the service.',
          ],
        },
        {
          title: "Changes to These Terms",
          body: [
            "We may update these terms. Material changes will be reflected in the update date on this page; continued use means you accept the updated terms.",
          ],
        },
        {
          title: "Contact",
          body: [
            "Questions about these terms can be sent to cfjwlchangji@gmail.com.",
          ],
        },
      ],
    },
    privacy: {
      title: "Privacy Policy",
      summary:
        "This policy explains what information Koinote collects, why, how it is used and protected, and how you can control it.",
      sections: [
        {
          title: "Information We Collect",
          body: ["We collect only what is necessary to provide the service."],
          items: [
            "Account data: email, username, display name, and a hashed password",
            "When you use social sign-in, the basic profile returned by Google or GitHub (email, username, avatar)",
            "Content you create: document titles and bodies, folder structure, uploaded images",
            "Share settings: share tokens and hashed access passwords",
            "Operational logs: request time, IP, and User-Agent, as needed for debugging and abuse prevention",
            "First-party product metrics: completion times for registration, first document, first upload, first export, first MCP call, and checkout; at most one activity date per account per day; shared pages retain only an aggregate read count",
          ],
        },
        {
          title: "What We Do Not Collect",
          body: [
            "There are no third-party advertising or behavioural analytics SDKs. We do not profile you for ad targeting, and we do not use your document content to train models. Product metrics never store document titles, bodies, search terms, imported filenames, or share-reader identities.",
          ],
        },
        {
          title: "How We Use Information",
          body: ["Collected information is used only for the following."],
          items: [
            "Providing core features: saving and syncing documents, hosting images, generating share links",
            "Authenticating you and maintaining your session",
            "Diagnosing faults and preventing abuse or attacks",
            "Understanding aggregate registration, first creation, upload, export, MCP, checkout conversion, and D1/D7/D30 retention",
            "Responding when you contact us for support",
          ],
        },
        {
          title: "Where Data Is Stored",
          body: [
            "Document bodies and account data live in our self-hosted PostgreSQL database. Images live in Cloudflare R2 and are served through our Worker — meaning storage credentials are never sent to the browser.",
          ],
        },
        {
          title: "Third Parties",
          body: [
            "Running Koinote relies on a small number of infrastructure providers, each processing data only within its own role.",
          ],
          items: [
            "Cloudflare: CDN, Workers, and R2 object storage",
            "Google and GitHub: identity verification, only if you choose to sign in with them",
            "Stripe: membership payment processing, receiving the email, amount, currency, and payment identifiers needed for checkout",
            "Feishu: optional internal payment notifications containing only the Koinote user ID, amount, currency, and order identifiers — never email addresses or document content",
          ],
        },
        {
          title: "Retention and Deletion",
          body: [
            "Documents first enter a 30-day trash, where content, versions, images, and storage usage remain. After permanent deletion or expiry, images not referenced by another document are queued for background deletion.",
            "To delete your entire account and all its data, email us.",
          ],
        },
        {
          title: "Security",
          body: [
            "We use HTTPS in transit, hashed password storage, and database permission isolation. No system can be guaranteed perfectly secure, so please do not keep highly sensitive material such as card numbers or identity documents in your notes.",
          ],
        },
        {
          title: "Your Rights",
          body: [
            "You can view and change your account details, export all of your documents, and delete documents or your account at any time. Where your local law grants rights to access, correct, export, or erase personal data, you can exercise them via the email below.",
          ],
        },
        {
          title: "Children",
          body: [
            "The service is not directed at children under 14. If we discover such an account, we will delete it.",
          ],
        },
        {
          title: "Contact",
          body: ["Privacy requests can be sent to cfjwlchangji@gmail.com."],
        },
      ],
    },
    cookies: {
      title: "Cookie Policy",
      summary:
        "This policy explains which cookies and browser storage Koinote uses, and what each is for.",
      sections: [
        {
          title: "Essential Cookies",
          body: [
            "We use a single session cookie to remember that you are signed in. It is HttpOnly and SameSite, so page scripts cannot read it. Blocking it makes signing in impossible.",
          ],
        },
        {
          title: "Browser Local Storage",
          body: [
            "The following preferences are kept in your browser's localStorage and never sent to the server. Clearing browser data resets them.",
          ],
          items: [
            "koinote-theme: light or dark theme choice",
            "koinote-locale: interface language",
            "Local drafts written while signed out, imported into your account after you sign in",
          ],
        },
        {
          title: "What We Do Not Use",
          body: [
            "No advertising cookies, no cross-site tracking pixels, no third-party behavioural analytics scripts.",
          ],
        },
        {
          title: "Third-Party Cookies",
          body: [
            "Choosing to sign in with Google or GitHub redirects you to their site, which may set its own cookies. That is governed by their respective privacy policies.",
          ],
        },
        {
          title: "Managing Cookies",
          body: [
            "Most browsers let you inspect, block, or delete cookies. Note that blocking the session cookie will prevent you from staying signed in.",
          ],
        },
        {
          title: "Contact",
          body: [
            "Questions about cookies can be sent to cfjwlchangji@gmail.com.",
          ],
        },
      ],
    },
  },
  errors: {
    bad_request: "Invalid request",
    missing_fields: "Username, email and password are all required",
    invalid_email: "Invalid email format",
    invalid_invitation_code:
      "That invitation code is invalid. Check it and try again",
    email_already_registered: "This email is already registered",
    verification_code_required: "Enter the email verification code",
    invalid_verification_code: "The verification code is incorrect",
    verification_code_expired: "The verification code expired. Send a new one",
    verification_attempts_exceeded:
      "Too many incorrect attempts. Send a new code",
    verification_rate_limited:
      "Too many verification requests. Please try again later",
    email_send_failed:
      "The verification email could not be sent. Please try again",
    email_not_verified: "This email address has not been verified",
    email_already_verified:
      "This email is already verified. Return to the regular login",
    password_too_short: "Password must be at least 6 characters",
    conflict: "Email or username is already taken",
    invalid_credentials: "Incorrect account or password",
    current_password_incorrect: "The current password is incorrect",
    password_not_available: "This account does not have a Koinote password",
    unauthorized: "Not logged in",
    session_expired: "Session expired",
    server_error: "Server error, please try again later",
    oauth_unsupported: "Unsupported login provider",
    oauth_not_configured: "This login method is not configured yet",
    oauth_denied: "Authorization was cancelled",
    oauth_missing_params: "OAuth callback is missing parameters",
    oauth_invalid_state: "Login session expired, please try again",
    oauth_exchange_failed: "Failed to complete sign-in, please try again",
    oauth_profile_failed: "Could not read your profile from the provider",
    oauth_sync_failed: "Failed to sync your account, please try again",
    title_too_long: "Title is too long",
    content_too_large: "Document is too large to save",
    image_fetch_rejected: "That image address is not allowed",
    image_fetch_failed: "Could not fetch that image from its original site",
    too_deep: "Folders are nested too deep to create another one inside",
    name_too_long: "Folder name is too long",
    invalid_move: "Cannot move that folder here",
    not_found: "This item doesn't exist or has been deleted",
    image_type_unsupported: "Only PNG, JPEG, GIF and WebP are supported",
    image_type_mismatch: "File contents don't match the declared format",
    image_svg_rejected: "SVG images aren't supported, for security reasons",
    image_too_large: "Image exceeds the 10 MB limit",
    image_quota_exceeded:
      "Image storage is full — permanently delete unneeded documents from Trash",
    storage_quota_exceeded:
      "Cloud storage is full — permanently delete unneeded documents from Trash",
    image_empty: "The image is empty",
    share_not_found: "This link is invalid or has been revoked",
    share_access_invalid: "Invalid share access level",
    share_password_too_short: "Password must be at least 6 characters",
    share_password_invalid: "Incorrect password",
    too_many_requests: "Too many attempts — please try again later",
  },
};
