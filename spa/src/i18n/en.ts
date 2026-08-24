import type { Messages } from "./types";

export const en: Messages = {
  nav: {
    editor: "Editor",
    download: "Download",
    pricing: "Upgrade",
    docs: "Docs",
    docsHome: "Documentation home",
    aiGuide: "AI optimization",
    mcpGuide: "MCP integration",
    versionHistoryGuide: "Version control",
    dashboard: "Dashboard",
    aiSettings: "AI settings",
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
    ctaDownload: "Download desktop app",
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
      "AI optimization with 1,000 credits, or use your own LLM",
      "Ten advanced management, writing, product, research, and technical templates",
      "Everything in Free",
    ],
    loginToUpgrade: "Log in to upgrade",
    manageMembership: "Manage AI and MCP",
    active: "Your lifetime membership is active",
    loading: "Loading current prices…",
    loadFailed: "Could not load pricing. Please try again.",
    unavailable: "Online checkout is not configured for this deployment.",
    creditsTitle: "AI credits",
    creditsDescription:
      "AI optimization with the built-in model uses credits. Using your own LLM channel uses no credits.",
    creditsMembersOnly:
      "Credits are available to lifetime members. Upgrade above before purchasing a pack.",
    creditsNote:
      "Purchased credits are added to your account automatically; balances and activity are available in AI settings.",
    buyCredits: "Buy",
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
        question: "How is AI optimization billed?",
        answer:
          "Lifetime membership includes 1,000 credits. Built-in model usage consumes credits based on actual usage; your own OpenAI-compatible or Anthropic channel consumes no credits.",
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
  aiGuide: {
    eyebrow: "AI optimization guide",
    title: "Let an AI editor review your draft, suggestion by suggestion",
    subtitle:
      "AI automatically reviews your title, prose, structure, and layout, then presents verifiable changes like a code review.",
    checks: [
      {
        title: "Title appeal",
        desc: "Scores clarity, specificity, credibility, and curiosity. Below 60, the model is asked for two or three alternatives.",
      },
      {
        title: "Body copy",
        desc: "Flags wordy sentences, unclear references, tone shifts, typography details, and mobile reading rhythm, with a reason for each change.",
      },
      {
        title: "Structure and layout",
        desc: "Evaluates hierarchy, readability, emphasis, rhythm, modularity, and mobile fit, then suggests headings, dividers, lists, or callouts.",
      },
      {
        title: "Safe application",
        desc: "Every suggestion shows the original and proposed text. Apply one, apply all, or ignore it—nothing changes silently in the background.",
      },
    ],
    caseEyebrow: "A real review record",
    caseTitle:
      "Case study: “The $1,000 online Markdown editor is now open source”",
    caseIntro:
      "This product announcement contained 18 paragraphs. The review preserved its personal voice and core message, corrected a few presentation details, and added the hierarchy the draft lacked. The following figures and examples come from an actual review completed on August 19, 2026.",
    caseSourceCta: "Read the pre-review original",
    caseCarouselLabel: "Real review case",
    casePrevious: "Show the previous review area",
    caseNext: "Show the next review area",
    caseFacts: [
      { label: "Title appeal", value: "76 / 100" },
      { label: "Body suggestions", value: "3" },
      { label: "Layout suggestions", value: "6" },
      { label: "Actual cost", value: "3 credits" },
    ],
    caseTitleReviewTitle:
      "76 points: specific, intriguing, and supported by the article",
    caseTitleReviewBody:
      "The concrete $1,000 figure creates a strong curiosity gap, and the article genuinely explains that token spend rather than exaggerating it. “Open source” adds a second value point. Not naming AI directly leaves a reasonable amount of suspense, so the title remains clear, specific, and credible without needing a forced rewrite.",
    caseContentTitle: "Copy suggestion: split an overloaded sentence",
    caseContentBody:
      "The original joins three ideas—the reason the service is free, waived bandwidth fees, and the resulting storage allowance—with commas. Breaking after the bandwidth point makes the causal chain easier to follow on mobile without changing the author's wording.",
    beforeLabel: "Before",
    afterLabel: "Suggestion",
    caseBefore:
      "所以目前是完全免费的，感谢赛博菩萨 cloudflare 低廉的存储价格，并且还免流量费，让我能为每个用户设置 500MB 的存储空间，对于大多数轻量级用户来说，这个容量应该完全够用了。",
    caseAfter:
      "所以目前是完全免费的，感谢赛博菩萨 cloudflare 低廉的存储价格，并且还免流量费。这让我能为每个用户设置 500MB 的存储空间，对于大多数轻量级用户来说，这个容量应该完全够用了。",
    caseStructureTitle: "Layout suggestion: diagnose before changing hierarchy",
    caseStructureBody:
      "All 18 paragraphs were originally at the same level. The six-part assessment found hierarchy and emphasis weakest, so it proposed distinct sections for the launch, open-source release, and next steps.",
    caseDimensions: [
      { label: "Hierarchy", score: 30 },
      { label: "Readability", score: 68 },
      { label: "Emphasis", score: 40 },
      { label: "Rhythm", score: 58 },
      { label: "Modularity", score: 55 },
      { label: "Mobile", score: 72 },
    ],
    caseChangesTitle: "Concrete layout suggestions with Markdown diffs",
    caseChanges: [
      {
        before:
          "今天非常欣喜地宣布，koinote（锦鲤笔记）的 1.0 已经完成并且上线了，欢迎大家试用，多提意见。",
        after:
          "## 今天非常欣喜地宣布，koinote（锦鲤笔记）的 1.0 已经完成并且上线了，欢迎大家试用，多提意见。",
        reason:
          "This sentence is the article's central launch announcement. Turning it into an H2 lets readers locate the beginning of the release section immediately.",
      },
      {
        before: "并且完整的代码库也都开源了：",
        after: "### 并且完整的代码库也都开源了：",
        reason:
          "The repository is a subtopic of the launch announcement. An H3 places it under the 1.0 section and makes the parent-child hierarchy explicit.",
      },
      {
        before: "欢迎各位大佬多提 issue 和 PR。",
        after: "欢迎各位大佬多提 issue 和 PR。\n\n---",
        reason:
          "The open-source invitation ends here and the next paragraph begins a cost retrospective. A divider marks that topic change instead of letting the modules run together.",
      },
      {
        before: "下一步打算完善一下会员体系，之后就是大家都期待的 AI 能力了。",
        after:
          "## 下一步打算完善一下会员体系，之后就是大家都期待的 AI 能力了。",
        reason:
          "The article shifts from the current product to membership and AI plans here. An H2 separates the roadmap from the preceding product overview.",
      },
      {
        before: "关于 AI 这块，不知道大家都有哪些点子呢？",
        after: "> **关于 AI 这块，不知道大家都有哪些点子呢？**",
        reason:
          "This is the article's strongest direct question. A blockquote callout prevents it from disappearing during a quick scan and encourages replies.",
      },
      {
        before:
          "所以欢迎给我留言，说说你们想要的功能，如果评估合理的话，一定都会加上的。",
        after:
          "> **所以欢迎给我留言，说说你们想要的功能，如果评估合理的话，一定都会加上的。**",
        reason:
          "This closing sentence is the real call to action. Isolating it as a callout turns a regular explanation into a clear final request.",
      },
    ],
    caseSafetyTitle:
      "All nine suggestions were applied only after confirmation",
    caseSafetyBody:
      "The review produced three copy suggestions and six layout suggestions. Koinote stored the review without changing the draft until the author confirmed each item; all suggestions were eventually applied for a total of 3 credits.",
    caseSafetyItems: [
      "Every suggestion shows the original, proposed text, and reason instead of editing silently.",
      "If the document changes during review, the suggestions remain available with a warning that they may not reflect the latest article; source matching still protects newer work when applying them.",
      "Applying AI changes creates a complete recovery point for comparison or restoration in version history.",
      "Review history retains the summary, scores, suggestion states, and actual credit usage.",
    ],
    caseOriginalEyebrow: "AI optimization source article",
    caseOriginalTitle: "烧了一千刀的在线 markdown，开源了",
    caseOriginalDescription:
      "The source article is in Chinese. This is the document version saved immediately before the AI review on August 19, 2026. Its original hierarchy, spacing, dividers, and callouts are preserved so you can compare them with every suggestion in the guide.",
    caseOriginalBack: "Back to the AI optimization guide",
    faqTitle: "Frequently asked questions",
    faqs: [
      {
        question: "Does AI optimization rewrite the entire article?",
        answer:
          "No. It reviews the title, body, and layout in background stages, then returns a summary, scores, reasons, and before-and-after comparisons. Only suggestions you approve are written back to the document.",
      },
      {
        question: "Does AI verify facts and fully preserve my voice?",
        answer:
          "AI identifies writing issues but does not verify factual claims, figures, or cited sources. Suggestions aim to preserve your voice, but you should still confirm that each one matches your intent.",
      },
      {
        question:
          "Can an old review overwrite changes made while it was running?",
        answer:
          "No. Koinote keeps the review and warns that the article changed, so its suggestions may not reflect the latest version. Revision, save-conflict, and source-text checks still protect every application; a suggestion that no longer matches cannot overwrite newer content.",
      },
      {
        question:
          "Can I undo applied changes, and what does review history retain?",
        answer:
          "Yes. Applying AI suggestions creates a complete recovery point for comparison or restoration in version history. Review history also retains summaries, scores, suggestion states, and actual credit usage.",
      },
      {
        question:
          "Who can use AI optimization, and how is the built-in model charged?",
        answer:
          "AI optimization is a Lifetime benefit, with 1,000 credits included when you upgrade. The built-in model uses credits based on the review's actual usage.",
      },
      {
        question: "Can I use my own model endpoint?",
        answer:
          "Yes. Connect an OpenAI-compatible or Anthropic Messages endpoint in AI settings to use your own model service without consuming Koinote credits. Reviewed content is sent to that service, so check the provider's data policy.",
      },
      {
        question: "Does it work in local mode or the desktop app?",
        answer:
          "Local mode blocks all network access, so AI optimization is unavailable there. A signed-in desktop client can use it normally while online.",
      },
    ],
    pricingCta: "View membership and credits",
  },
  docsCenter: {
    eyebrow: "Product documentation",
    title: "From your first document to a complete writing workflow",
    subtitle:
      "Learn Koinote editing, migration, sharing, desktop workflows, AI optimization, and data safety in one place. MCP and version control have dedicated deep-dive guides.",
    quickStartTitle: "Start writing in five minutes",
    quickStartSteps: [
      {
        title: "Create or import content",
        desc: "Start a blank document in the editor, or import .md files, folders, and Koinote ZIP migration archives from My documents.",
      },
      {
        title: "Organize documents and folders",
        desc: "Use the file tree, tabs, and folders to organize work. Press ⌘K / Ctrl+K to search every title and body.",
      },
      {
        title: "Write and add images",
        desc: "The editor renders as you type and saves automatically. Paste, drop, or select images to insert stable hosted links.",
      },
      {
        title: "Share, export, or publish",
        desc: "Create a read-only link, export Markdown, HTML, Word, or PDF, or prepare content for WeChat, Zhihu, and Juejin.",
      },
    ],
    workflowsTitle: "Browse by workflow",
    workflows: [
      {
        title: "Editing and organization",
        desc: "A single-pane Markdown experience designed for long-form writing.",
        items: [
          "Live rendering, autosave, and a manual save shortcut",
          "Folders, tabs, outlines, and smart organization for root documents",
          "Global title and body search with highlighted results",
          "A 30-day trash with restore and permanent deletion",
        ],
      },
      {
        title: "Images and migration",
        desc: "Move documents and their images in or out without lock-in.",
        items: [
          "Paste, drag, or choose image files to upload",
          "Import .md files, folders, and ZIP archives with images",
          "Compress large images in the browser before upload",
          "Export every document and image as a migration ZIP",
        ],
      },
      {
        title: "Sharing and publishing",
        desc: "Go from a private draft to public reading and media publishing.",
        items: [
          "Random share links or access passwords of six or more characters",
          "Dynamic page titles, OpenGraph cards, and view counts",
          "Let readers copy an independent document into their Koinote",
          "Export for WeChat Official Accounts, Zhihu, and Juejin",
        ],
      },
      {
        title: "Desktop app",
        desc: "Local editing, sync, and updates on macOS and Windows.",
        items: [
          "Apple Silicon, Intel Mac, and Windows x64 builds",
          "Edit and paste images offline, then sync automatically online",
          "Detect remote updates and ask which version to keep on conflict",
          "Scheduled GitHub Releases checks with update prompts",
        ],
      },
      {
        title: "AI optimization",
        desc: "Review an article like a code change, then choose what to apply.",
        items: [
          "Headline appeal score with model-generated alternatives",
          "Copy, structure, hierarchy, layout, and mobile readability checks",
          "Apply individual suggestions, apply all, or dismiss them",
          "Use built-in credits or your own OpenAI / Anthropic channel",
        ],
      },
      {
        title: "Account and data safety",
        desc: "Control sessions, recover access, and move or delete your data.",
        items: [
          "Reset or change a password and sign out other devices",
          "Configurable version history and conflict protection",
          "Export a migration archive before deleting an account",
          "Scope, expire, reveal, and revoke MCP tokens",
        ],
      },
    ],
    modesTitle: "Local mode is not offline mode",
    modesSubtitle:
      "Both let you write without a connection, but identity, network behavior, and data ownership are different.",
    modes: [
      {
        title: "Offline mode",
        desc: "You are signed in but temporarily disconnected. Documents and images stay on the device, then upload and sync when the connection returns.",
      },
      {
        title: "Local mode",
        desc: "No sign-in and no network requests. A local password encrypts documents, folder names, and images before they are stored in SQLite on this device.",
      },
      {
        title: "Import local data",
        desc: "After signing in, verify the local password to copy local-mode data into the account. The copies remain independent afterward.",
      },
    ],
    deepDiveTitle: "Deep-dive guides",
    aiTitle: "Review an article with AI optimization",
    aiDescription:
      "See how title scoring, body suggestions, six-part layout analysis, background tasks, credits, and your own model channel work through a real review.",
    mcpTitle: "Let agents work with Koinote documents",
    mcpDescription:
      "Configure Streamable HTTP MCP for Codex, Claude Code, OpenCode, OpenClaw, and other clients, with clear permissions and usage examples.",
    versionTitle: "History, diffs, and recovery",
    versionDescription:
      "Understand retention limits, safety snapshots, revision conflicts, and how to compare or restore versions created by the web editor or agents.",
    readGuide: "Read the guide",
    safetyTitle: "Migration recommendation",
    safetyBody:
      "Cloud sync and version history are not a replacement for your own long-term backup. Export a ZIP with images from My documents regularly; local mode has no cloud copy, so backups matter even more.",
    openEditor: "Open editor",
    manageDocuments: "Manage and migrate documents",
    downloadDesktop: "Download desktop app",
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
    desktopDescription:
      "Password changes and session revocation are sensitive actions and open in your system browser.",
    manageOnWeb: "Manage on the web",
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
  accountDeletion: {
    title: "Delete account",
    description:
      "This cannot be undone. Export any documents and images you want to keep first.",
    immediate:
      "Your account, documents, versions, shares, MCP tokens, and synced images enter deletion immediately.",
    membership:
      "Lifetime membership ends with the account. Deletion is not an automatic refund; statutory refund rights still apply.",
    paymentRecords:
      "Minimal payment records required for tax, disputes, and fraud prevention are detached from your account and retained as required by law.",
    feedbackRecords:
      "Feedback text, source pages, and client details are detached from your account and retained for troubleshooting and product improvement; they may still contain personal information you entered.",
    confirmLabel: "Type your current email {email} to confirm",
    finalConfirmation:
      "Delete this account immediately? This action cannot be undone.",
    deleteButton: "Permanently delete account",
    deleting: "Deleting…",
    mismatch: "The email does not match this account.",
    paymentPending:
      "A payment is still being processed. Wait for it to finish or contact support before deleting the account.",
    unavailable:
      "We cannot safely close the payment flow right now. Please try again later.",
    failed: "Account deletion failed. Please try again later.",
    localCleanupFailed:
      "The cloud account was deleted, but some offline data could not be cleared from this device. Server tokens are invalid; quit the app and remove its local application data manually.",
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
      "A one-time upgrade for 10 GB of storage, MCP, version history, AI optimization, and 1,000 credits.",
    oneTimePayment: "One-time payment, yours for life",
    currencyLabel: "Payment currency",
    currencyHint: "Stripe Checkout will charge you in the selected currency.",
    storageBenefit: "10 GB cloud storage",
    aiBenefit: "AI optimization",
    aiComingSoon: "Includes 1,000 credits, or use your own LLM provider",
    purchase: "Get lifetime access",
    redirecting: "Opening secure checkout…",
    activeTitle: "Lifetime membership unlocked",
    activeDescription:
      "Your account includes a fixed 10 GB of cloud storage, AI optimization, and every lifetime benefit.",
    unavailable: "Membership checkout is not configured on this deployment.",
    loadFailed: "Couldn't load membership status.",
    checkoutSuccess: "Payment confirmed. Your lifetime membership is active.",
    checkoutPending:
      "Payment is still being confirmed. Your access will update automatically.",
    checkoutDelayed:
      "Stripe is still processing this payment. Do not pay again; check back later, or contact support if you were charged and membership remains inactive.",
    checkoutCancelled: "Checkout was cancelled. You were not charged.",
    checkoutFailed: "Checkout couldn't be completed. Please try again.",
  },
  agentCredits: {
    title: "AI credits",
    description:
      "Built-in AI optimization uses credits. Using your own LLM channel uses no credits.",
    membersOnly:
      "AI optimization is a lifetime-member benefit and includes 1,000 credits when you upgrade.",
    available: "{count} available",
    estimatedCharge: "Estimated charge: {count} credits",
    loading: "Loading credits…",
    loadFailed: "Could not load credits. Please try again.",
    balance: "Balance",
    reserved: "Estimated charge",
    availableLabel: "Available",
    purchaseUnavailable:
      "Credit purchases are not configured on this deployment.",
    redirecting: "Opening secure checkout…",
    history: "Recent activity",
    checkoutSuccess: "Credits have been added to your balance.",
    checkoutPending: "Payment is being confirmed. Do not pay again.",
    checkoutDelayed:
      "Stripe is still processing this payment. Do not pay again; check back later.",
    checkoutCancelled: "Purchase cancelled. You were not charged.",
    checkoutFailed: "The purchase could not be completed. Please try again.",
    transactionKinds: {
      membership_grant: "Membership grant",
      purchase: "Purchase",
      agent_usage: "AI optimization",
      adjustment: "Balance adjustment",
      refund: "Refund",
    },
  },
  agentModelSettings: {
    title: "AI model",
    description:
      "Choose whether AI optimization uses the built-in model or your own LLM. The editor uses this setting without asking again.",
    membersOnly: "AI optimization is available to lifetime members.",
    builtIn: "Built-in model",
    builtInHint: "Uses credits based on actual usage.",
    byok: "Your own LLM",
    byokUnavailable: "Add a model channel below first.",
    loading: "Loading model settings…",
    loadFailed: "Could not load model settings. Please try again.",
    saveFailed: "Could not save model settings. Please try again.",
  },
  llmChannels: {
    title: "Your LLM channels",
    description:
      "Configure an OpenAI-compatible endpoint or Anthropic Messages API. AI optimization uses the default channel; keys are encrypted and BYOK uses no credits.",
    membersOnly: "Custom LLM channels are available to lifetime members.",
    add: "Add channel",
    loading: "Loading channels…",
    loadFailed: "Could not load channels. Please try again.",
    empty: "No custom channel configured yet.",
    defaultBadge: "Default",
    edit: "Edit channel",
    delete: "Delete channel",
    deleteConfirm:
      "AI optimization using this channel will no longer work. Delete it?",
    addTitle: "Add LLM channel",
    editTitle: "Edit LLM channel",
    cancel: "Cancel",
    name: "Channel name",
    protocol: "API protocol",
    baseUrl: "Base URL",
    model: "Model",
    apiKey: "API key",
    apiKeyOptional: "API key (leave blank to keep it unchanged)",
    makeDefault: "Make this the default channel",
    save: "Save channel",
    saving: "Saving…",
    saveFailed:
      "Could not save the channel. Check the configuration and try again.",
    deleteFailed: "Could not delete the channel. Please try again.",
  },
  agentReview: {
    button: "AI optimization",
    title: "AI optimization",
    description:
      "Review the title, body, and Markdown layout like a code change; nothing changes until you approve it.",
    membersOnly: "This feature is available to lifetime members only.",
    upgrade: "Upgrade to lifetime",
    localModeUnavailable:
      "Local mode never connects to the network, so AI optimization is unavailable.",
    provider: "Review method",
    builtIn: "Built-in model",
    builtInHint: "Uses credits based on actual token usage.",
    byok: "Your channel",
    byokHint: "Uses your API key and no credits.",
    channel: "Default channel",
    configureChannels: "Manage model channels",
    availableCredits: "{count} credits available",
    start: "Start review",
    running: "AI is reviewing your article…",
    progress: "{completed}/{total} subtasks complete",
    partialResults:
      "Partial results are ready. Changes can be applied after every task finishes.",
    stageTitle: "Title & opening",
    stageDocument: "Whole-article edit",
    stageBody: "Body review",
    stageLayout: "Structure & layout",
    backgroundRunning: "AI optimization is running in the background",
    backgroundRunningDescription:
      "Keep writing or switch pages. Koinote will notify you when the review is ready.",
    backgroundReady: "AI optimization is ready",
    backgroundReadyDescription:
      "The title, body, and structure suggestions are ready to review.",
    backgroundFailed: "AI optimization could not finish",
    backgroundFailedDescription:
      "The model channel or network may be temporarily unavailable. Open the document and try again.",
    backgroundTimeoutDescription:
      "This review timed out or the service restarted. Open the document and start it again.",
    viewBackgroundResult: "Review suggestions",
    dismissNotification: "Dismiss notification",
    saveFailed:
      "The current document could not be saved. Resolve the save issue and try again.",
    loading: "Loading review…",
    loadFailed: "Could not load review history. Please try again.",
    noPreviousReviews: "No reviews yet.",
    previousReviews: "Previous reviews",
    newReview: "New review",
    summary: "Review summary",
    titleReview: "Title suggestions",
    contentReview: "Body copy",
    layoutReview: "Structure & layout",
    layoutAssessment: "Six-dimension radar",
    layoutShowCards: "Show all details",
    layoutShowRadar: "Show radar",
    layoutRadarHint:
      "Hover to inspect a dimension. Click it to filter suggestions below; click again to clear.",
    deepAnalysis: "Deep analysis",
    deepAnalysisTarget: "Deep analysis target",
    deepAnalysisStarting: "Starting…",
    deepReviewBadge: "Deep analysis · {dimension}",
    titleScore: "Title appeal {score}/100",
    suggestions: "Suggested changes",
    before: "Before",
    after: "After",
    apply: "Apply",
    applying: "Applying…",
    dismiss: "Ignore",
    applyAll: "Apply all",
    applyingAll: "Applying all…",
    dismissAll: "Ignore all",
    dismissAllConfirm:
      "This closes the current review. Ignore every remaining suggestion?",
    applied: "Applied",
    dismissed: "Ignored",
    staleTitle: "The article changed during AI optimization",
    staleDescription:
      "You can still review and apply these suggestions, but they may not reflect the latest article. Check each one before applying it.",
    failedTitle: "AI could not complete this review",
    retry: "Review again",
    noSuggestions:
      "The article is in good shape; this review has no changes to apply.",
    noTitleSuggestions:
      "No reliable title alternative worth replacing the current title was found.",
    noTitleSuggestionsLowScore:
      "The title scored low, but no supported alternative was found — the article does not yet carry a stronger promise. Add a concrete result or audience first, then review again.",
    noContentSuggestions:
      "The writing is in good shape. No editorial changes are needed.",
    noLayoutSuggestions:
      "The current structure already works. No safe layout changes are needed.",
    noFilteredLayoutSuggestions:
      "There are no {dimension} changes in this review. Run deep analysis for a focused second pass.",
    usage: "Used {credits} credits",
    close: "Close",
    categories: {
      title: "Title",
      clarity: "Clarity",
      structure: "Structure",
      engagement: "Engagement",
      accuracy: "Accuracy",
      style: "Style",
      conversion: "Call to action",
      hierarchy: "Hierarchy",
      readability: "Readability",
      emphasis: "Emphasis",
      rhythm: "Rhythm",
      modules: "Modules",
      mobile: "Mobile",
    },
    statuses: {
      running: "Reviewing",
      ready: "Ready",
      partially_applied: "Partially applied",
      applied: "Applied",
      dismissed: "Ignored",
      failed: "Failed",
      stale: "Article changed",
    },
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
    activity: "Activity log",
  },
  mcpActivity: {
    title: "MCP activity log",
    description:
      "See which tools an Agent called, which document it touched, and whether each call succeeded. Logs are kept for 180 days and never include document or token contents.",
    back: "Back to MCP settings",
    membersOnly: "MCP activity logs are a lifetime membership benefit.",
    loading: "Loading activity…",
    loadFailed: "Could not load MCP activity. Please try again.",
    retry: "Retry",
    empty:
      "No MCP activity yet. Calls appear here after an Agent first uses a tool.",
    loadMore: "Load more",
    success: "Success",
    error: "Failed",
    deletedToken: "Revoked or deleted token",
    deletedDocument: "Deleted document",
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
  aiSettings: {
    title: "AI settings",
    subtitle:
      "Manage AI credits, your own LLM channels, and MCP document access in one place.",
  },
  documentsPage: {
    title: "My documents",
    subtitle:
      "Browse cloud documents or import Markdown, folders, and ZIP migration archives.",
    emptyHint:
      "No cloud documents yet. Import existing work or create your first document.",
    emptyLinkText: "Create your first document",
  },
  search: {
    button: "Search",
    title: "Search all documents",
    placeholder: "Search titles and content…",
    hint: "Press ⌘K / Ctrl+K anywhere",
    quickOpenTitle: "Quick open document",
    quickOpenPlaceholder: "Type a title to jump to a document…",
    quickOpenHint: "Press ⌘P / Ctrl+P anywhere",
    quickOpenEmpty: "No documents to open.",
    quickOpenMore: "More documents match; keep typing to narrow the list",
    startTyping: "Enter a keyword to search your titles and Markdown content.",
    noResults: "No matching documents.",
    loadFailed: "Search failed. Please try again.",
    titleMatch: "Title match",
    contentMatch: "Content match",
  },
  keyboardShortcuts: {
    title: "Keyboard shortcuts",
    description:
      "Search, navigate, and edit documents without leaving the keyboard.",
    close: "Close keyboard shortcuts",
    or: "or",
    searchAndNavigation: "Search & navigation",
    documents: "Documents",
    panels: "Panels",
    editing: "Editing",
    panelHint:
      "Panel shortcuts only apply outside text fields. In the editor, ⌘/Ctrl+B still makes text bold.",
    actions: {
      showKeyboardShortcuts: "Show keyboard shortcuts",
      searchDocuments: "Search documents",
      quickOpen: "Quick open document",
      searchAllDocuments: "Search all documents",
      findInDocument: "Find in current document",
      previousDocument: "Previous document tab",
      nextDocument: "Next document tab",
      selectTab: "Jump to tab 1–9",
      newDocument: "New document",
      saveDocument: "Save now",
      closeDocument: "Close current document",
      toggleDocumentsPanel: "Show or hide document sidebar",
      toggleOutlinePanel: "Show or hide outline",
      undo: "Undo",
      redo: "Redo",
      bold: "Bold",
      italic: "Italic",
    },
  },
  transfer: {
    importButton: "Import files",
    importFolderButton: "Import folder",
    exportButton: "Export all",
    importing: "Importing documents and images…",
    exporting: "Packaging documents and images…",
    importSuccess: "Imported {count} documents.",
    importGifFlattened:
      "{count} GIFs over 10 MB were compressed to static WebP images; animation was not preserved.",
    exportSuccess: "Your migration archive is ready.",
    importFailed:
      "Import failed. Check the file format, image sizes, and storage quota.",
    unsupportedImportFormat:
      "{filename} is not supported. Choose a Markdown (.md) file or a Koinote ZIP migration archive.",
    importTooManyFiles:
      "You can import up to 1,000 files at once. Split the import and try again.",
    importTooLarge:
      "The import exceeds the 250 MB limit. Split it and try again.",
    importDocumentTooLarge:
      "{filename} exceeds the 1 MB limit for one Markdown document.",
    importImageTooLarge:
      "{filename} has dimensions too large for the browser to compress safely.",
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
    actionFailed: "The action failed. Please try again.",
  },
  invitationsPage: {
    title: "Invite friends",
    subtitle: "Share your personal invitation link and track rewards.",
  },
  feedback: {
    menuLabel: "Feedback",
    title: "Tell us what you think",
    description:
      "Report a bug or share an experience suggestion. Our team reviews every submission in the admin dashboard.",
    categoryLabel: "Feedback type",
    categoryBug: "Bug",
    categoryExperience: "Experience",
    messageLabel: "Your feedback",
    messagePlaceholder:
      "Describe what happened and what you expected to happen…",
    privacyHint:
      "Feedback is linked to your account and includes the current page and client details. After account deletion, it is detached from your account and retained for troubleshooting and product improvement.",
    discardConfirm:
      "This feedback has not been submitted. Discard what you entered?",
    cancel: "Cancel",
    close: "Close feedback dialog",
    submit: "Submit feedback",
    submitting: "Submitting…",
    submitFailed: "Feedback could not be submitted. Please try again.",
    successTitle: "Feedback received",
    successDescription: "Thank you. We’ll review what you shared.",
    done: "Done",
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
    tabOverview: "Overview",
    tabGrowth: "Growth & retention",
    tabRevenue: "Revenue & orders",
    tabUsers: "Users",
    tabServer: "Server",
    tabAnnouncements: "Announcements",
    tabFeedback: "Feedback",
    feedbackTitle: "User feedback",
    feedbackSubtitle:
      "Bug reports and experience suggestions in submission order.",
    feedbackLoading: "Loading user feedback…",
    feedbackLoadFailed: "User feedback could not be loaded. Please try again.",
    feedbackEmpty: "No feedback has been submitted yet.",
    feedbackLoadMore: "Load more",
    feedbackLoadingMore: "Loading…",
    feedbackBug: "Bug",
    feedbackExperience: "Experience",
    feedbackFrom: "Submitted by",
    feedbackPage: "Source page",
    feedbackSubmittedAt: "Submitted",
    feedbackUserAgent: "Client details",
    serverStatusLoading: "Loading server status…",
    serverStatusLoadFailed:
      "Server status could not be loaded. Please try again later.",
    serverStatusUnavailable:
      "This environment cannot expose Linux host metrics. If this appears in production, check the container's read-only monitoring mounts.",
    serverStatusTitle: "Server status",
    serverStatusSubtitle: "Resource usage for the entire Linux server.",
    serverStatusAutoRefresh: "Refreshes every 30 seconds",
    serverResources: "Resource overview",
    serverCPU: "Server CPU",
    serverMemoryUsage: "Memory usage",
    serverDiskUsage: "Disk usage",
    serverUptime: "Server uptime",
    notAvailable: "Unavailable",
    notConfigured: "Not configured",
    uptimeValue: "{days}d {hours}h {minutes}m",
    serverCPUHint:
      "CPU is the whole-server utilization; 100% means all logical cores are busy.",
    serverLoad: "System load",
    logicalCPUs: "Logical CPUs",
    load1: "1-minute load",
    load5: "5-minute load",
    load15: "15-minute load",
    loadHint:
      "Compare load average with logical CPU count; sustained values above the core count usually mean work is queued.",
    serverMemoryStorage: "Memory & storage",
    memoryTotal: "Physical memory",
    memoryAvailable: "Available memory",
    swapUsage: "Swap usage",
    diskAvailable: "Disk available",
    serverNetwork: "Primary network traffic",
    networkUnavailable:
      "The server's primary network interface could not be identified.",
    downloadRate: "Receiving now",
    uploadRate: "Sending now",
    receivedTotal: "Received total",
    sentTotal: "Sent total",
    networkInterface: "Interface: {interface}",
    serverGeneratedAt: "Server metrics updated {time}",
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
    deletedAccount: "Deleted account",
    user: "User",
    status: "Status",
    client: "Last client",
    webClient: "Web",
    desktopClient: "Desktop",
    clientUnknown: "No activity yet",
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
    announcementsTitle: "In-app announcements",
    announcementsSubtitle:
      "Notify every signed-in user; Koinote generates English, Chinese, Japanese, and French versions automatically.",
    announcementSourceLanguage: "Source language",
    announcementTitleLabel: "Title",
    announcementSummaryLabel: "Summary",
    announcementHighlightsLabel: "Highlights",
    announcementHighlightsPlaceholder: "One highlight per line, up to 8",
    announcementTranslationNote:
      "Publishing asks the server-side LLM to translate the other languages while preserving your source text.",
    announcementTranslationUnavailable:
      "The announcement translation service is not configured, so manual publishing is unavailable.",
    announcementTranslationFailed:
      "Translation failed and nothing was published. Please try again.",
    announcementPublish: "Translate and publish",
    announcementPublishing: "Translating…",
    announcementPublishSuccess:
      "Published. Users will see this the next time they open Koinote.",
    announcementPublishFailed:
      "The announcement could not be published. Check the content and try again.",
    announcementContentInvalid:
      "The title, summary, or highlights exceed the allowed length. Check the content and try again.",
    announcementHighlightTooLong:
      "Each highlight can contain at most 500 characters.",
    announcementHistory: "Recent announcements",
    announcementHistoryEmpty: "No announcements have been published yet.",
    announcementLoadFailed: "Announcements could not be loaded.",
    announcementKindRelease: "Release",
    announcementKindManual: "Manual notice",
    announcementWithdraw: "Withdraw",
    announcementWithdrawConfirm:
      "Withdraw this announcement? Users will stop seeing it, while the record remains in the admin history.",
    announcementWithdrawFailed:
      "The announcement could not be withdrawn. Please try again.",
    announcementWithdrawn: "Withdrawn",
  },
  announcements: {
    releaseBadge: "What's new in Koinote {version}",
    manualBadge: "Announcement",
    viewChangelog: "View full changelog",
    acknowledge: "Got it",
    close: "Close announcement",
    markReadFailed:
      "Koinote could not save the read status. You can close this notice and try again later.",
  },
  documentTemplates: {
    eyebrow: "Start with structure",
    title: "Create from a template",
    subtitle:
      "Choose a focused outline, then make it yours. The template is copied into a normal Markdown document and remains fully editable.",
    close: "Close templates",
    blankTitle: "Blank document",
    blankDescription: "Start with an empty page and build your own structure.",
    freeBadge: "Free",
    memberBadge: "Lifetime",
    upgradeHint: "Upgrade to Lifetime to use this template",
    localModeLocked: "Sign in with a Lifetime account to use this template",
    sourceNote:
      "Curated from highly rated, permissively licensed Markdown patterns on GitHub and rewritten for Koinote.",
    createFailed: "The document could not be created. Please try again.",
    categories: {
      everyday: "Everyday work",
      management: "Goals and management",
      writing: "Writing and research",
      product: "Product and projects",
      technical: "Technical decisions",
    },
    templates: {
      "meeting-notes": {
        name: "Meeting notes",
        description:
          "Turn discussion into decisions, owners, and trackable actions.",
      },
      "daily-note": {
        name: "Daily note",
        description:
          "Keep priorities, observations, ideas, and reflection in one place.",
      },
      "weekly-review": {
        name: "Weekly plan & review",
        description:
          "Plan three outcomes and close the loop with a practical review.",
      },
      "todo-list": {
        name: "Todo list",
        description:
          "Manage three priorities, captured tasks, contexts, delegation, and the daily close.",
      },
      table: {
        name: "Flexible table",
        description:
          "Define fields and rules, then organize records, views, summaries, and changes.",
      },
      "daily-report": {
        name: "Daily work report",
        description:
          "Report outcomes, metrics, blockers, collaboration, and tomorrow's plan.",
      },
      "weekly-report": {
        name: "Weekly work report",
        description:
          "Summarize outcomes, metric gaps, risks, lessons, and next week's results.",
      },
      okr: {
        name: "OKR plan & review",
        description:
          "Connect strategy to strong objectives, measurable KRs, confidence checks, and scoring.",
      },
      kpi: {
        name: "KPI tracker",
        description:
          "Define formulas, sources, targets, guardrails, alert thresholds, and corrective actions.",
      },
      "article-outline": {
        name: "Article brief",
        description:
          "Shape audience, hooks, evidence, structure, CTA, and a publishing checklist.",
      },
      "project-readme": {
        name: "Project README",
        description:
          "Document value, quick start, usage, architecture, roadmap, and contribution.",
      },
      "product-requirements": {
        name: "Product requirements",
        description:
          "Define the problem, scope, user stories, acceptance criteria, metrics, and rollout.",
      },
      "research-paper": {
        name: "Research paper notes",
        description:
          "Capture methods, evidence, limitations, connections, and follow-up work.",
      },
      "decision-record": {
        name: "Decision record",
        description:
          "Preserve context, options, trade-offs, consequences, and validation.",
      },
      "technical-design": {
        name: "Technical design",
        description:
          "Cover interfaces, data, consistency, security, capacity, migration, and testing.",
      },
    },
  },
  editor: {
    placeholder:
      'Start writing… type "# " for a heading, "- " for a list, "```" for a code block',
    saving: "Saving…",
    saved: "Saved",
    charCount: "{n} chars",
    saveFailed: "Save failed",
    saveFailedBackedUp: "Draft backed up",
    saveBackupFailed: "Backup failed; copy the document now",
    retrySave: "Retry",
    remoteUpdated: "Updated with the latest changes from another device",
    remoteUpdateAvailable:
      "A newer cloud version is available. Your local draft will not be overwritten.",
    reviewRemoteUpdate: "Review changes",
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
    historyCompareWith: "Compare with",
    historyCurrent: "Current version",
    historyLoadingDiff: "Building diff…",
    historyNoChanges: "These versions are identical.",
    historyLinesOmitted: "{n} unchanged or oversized diff lines omitted",
    historyTitleChanged: "Title: {before} → {after}",
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
    shareSaving: "Working…",
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
    exportPrintHint:
      "Saved directly on desktop with selectable, searchable text",
    find: {
      button: "Find",
      placeholder: "Find in this document…",
      previous: "Previous match",
      next: "Next match",
      close: "Close find",
      noResults: "No results",
      resultCount: "{current} / {total}",
    },
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
    wechatGeoExperiment: "AI-generated hidden GEO summary",
    wechatGeoExperimentHint:
      "Members only. The summary is saved with this document, and export adds a divider below the title as a marker. WeChat may remove hidden text or treat it as a policy-violating layout; ranking impact is not guaranteed. The built-in model uses credits.",
    wechatGeoGenerate: "Generate with AI",
    wechatGeoRegenerate: "Regenerate",
    wechatGeoLoading: "Loading the saved summary…",
    wechatGeoGenerating: "Generating…",
    wechatGeoSaving: "Saving…",
    wechatGeoLoadFailed: "Could not load the saved summary. Try again later",
    wechatGeoGenerateFailed: "Could not generate the summary. Try again later",
    wechatGeoSaveFailed: "Could not save the summary. Try again later",
    wechatGeoStale:
      "The article has changed. You can keep using the saved summary or regenerate it.",
    wechatGeoPlaceholder:
      "Review and edit the hidden summary after AI generation.",
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
    organizer: {
      button: "Organize documents",
      rootOnly:
        "Includes root documents and previously auto-organized documents. Folders you create or import, and everything inside them, always remain untouched.",
      smartTitle: "Smart organization",
      smartDescription:
        "Group by creation month, split months over 20 documents into weeks, then split crowded weeks into dates.",
      activityTitle: "Activity organization",
      activityDescription:
        "Group by last edit recency, then split crowded groups by month, week, or date.",
      unknownDate: "Unknown date",
      weekOfMonth: "Week {n}",
      activityRecent7: "Last 7 days",
      activityRecent30: "8–30 days",
      activityRecent90: "31–90 days",
      activityInactive: "91–365 days",
      activityArchive: "Over one year",
      confirmSummary:
        "Move {documents} documents using about {folders} auto-organized folders.",
      upToDate:
        "Documents already match this strategy. No organization is needed.",
      cancel: "Cancel",
      apply: "Organize now",
      organizing: "Organizing…",
      success: "Organized {count} documents",
      partial:
        "Organized {moved} documents; {failed} could not be moved and can be retried later.",
      failed:
        "Organization failed. Check the network or local storage and try again.",
    },
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
    newLabel: "New",
    sourceLink: "View the source on GitHub",
    sourceNote:
      "This page stays in sync with the English changelog in the open-source repository.",
    categories: {
      Added: "Added",
      Changed: "Changed",
      Fixed: "Fixed",
      Security: "Security",
      Deprecated: "Deprecated",
      Removed: "Removed",
    },
  },
  desktopAuth: {
    eyebrow: "Desktop app",
    title: "Authorize the Koinote app",
    description:
      "The app keeps offline copies of documents and images on this device and syncs your changes when connectivity returns.",
    permissionsTitle: "After approval, the app can:",
    permissionDocuments:
      "Read, create, organize, share, and move your documents and folders to trash",
    permissionOffline:
      "Keep documents, pending images, and up to 512 MB of hosted-image cache on this device",
    permissionIdentity:
      "Read basic account details to show the signed-in account",
    approve: "Allow and return to the app",
    cancel: "Cancel",
    signIn: "Sign in to continue",
    invalid:
      "This authorization link is invalid. Return to the app and try again.",
    failed: "Authorization could not be completed. Please try again.",
  },
  desktopLocalMode: {
    badge: "Local mode",
    title: "Write only on this device",
    description:
      "No account required. Documents and images are encrypted on this device, never uploaded, and remote features are unavailable.",
    setupTitle: "Set a local-mode password",
    setupDescription:
      "This password encrypts and unlocks local data. It is never uploaded and cannot be recovered.",
    unlockTitle: "Unlock local mode",
    unlockDescription:
      "Enter the local-mode password to access documents stored on this device.",
    password: "Local-mode password",
    confirmPassword: "Confirm password",
    passwordHint:
      "At least 8 characters. You must enter it again after closing the app.",
    create: "Create and enter local mode",
    unlock: "Unlock",
    creating: "Creating…",
    unlocking: "Unlocking…",
    useAccount: "Use a Koinote account",
    enterLocalMode: "Switch to local mode",
    lock: "Lock local mode",
    encrypted:
      "Documents, folder names, and images are encrypted with AES-GCM before being stored in local SQLite.",
    networkDisabled:
      "Local mode blocks sync, update checks, sharing, billing, MCP, and every other remote request.",
    passwordMismatch: "The passwords do not match.",
    invalidPassword: "The password is incorrect.",
    genericError: "Local mode is unavailable. Restart the app and try again.",
    localSubtitle:
      "You are in local mode. Changes stay on this device and are not synced to a Koinote account.",
    localStorageTitle: "Fully local storage",
    localStorageDescription:
      "There is no cloud copy or automatic recovery. Export a ZIP backup from My documents regularly.",
    trashRetention:
      "Documents in the local trash are never deleted automatically.",
    importTitle: "Import local-mode data",
    importDescription:
      "After verifying the local password, copy local documents, folders, and referenced images into this account. The import is an independent snapshot; later edits remain separate.",
    importButton: "Verify and import",
    importing: "Importing…",
    importSuccess:
      "Imported {documents} documents, {folders} folders, and {images} images. They now follow the normal sync flow.",
    importEmpty: "Local mode has no documents to import yet.",
    importPassword: "Enter the local-mode password",
    importWarning:
      "Importing again creates another independent copy and does not overwrite the previous import.",
  },
  desktopBilling: {
    successTitle: "Payment complete",
    cancelledTitle: "Payment cancelled",
    description:
      "Returning to the Koinote app. The app will securely confirm this purchase and refresh the corresponding benefit.",
    openApp: "Open the Koinote app",
    invalid:
      "This checkout return link is invalid. Return to the app and try again.",
    dismiss: "Dismiss payment status",
  },
  desktopHome: {
    eyebrow: "Desktop workspace",
    welcome: "Welcome back, {name}",
    subtitle:
      "Continue where you left off. Changes are saved on this device first and sync automatically when you are online.",
    newDocument: "New document",
    importDocuments: "Import Markdown",
    createFailed: "The document could not be created. Please try again.",
    loadFailed:
      "Local documents could not be loaded. Restart the app and try again.",
    continueTitle: "Continue writing",
    recentTitle: "Recent documents",
    allDocuments: "View all",
    updated: "Updated {date}",
    emptyTitle: "Start your first document",
    emptyDescription:
      "Create a blank document, or open My documents to import existing Markdown files and ZIP archives.",
    syncTitle: "Sync status",
    syncDescription:
      "Local changes sync automatically when online. If both copies change, you choose which version to keep.",
    offlineTitle: "Ready for offline work",
    offlineDescription:
      "Documents and images live on this device. You can paste images and keep editing offline; they upload and switch to hosted URLs when connectivity returns.",
    documentCount: "{count} documents available locally",
    imageCacheUsage:
      "Local images {total}; hosted cache {cached} / {limit}, pending {pending}",
    clearImageCache: "Clear hosted-image cache",
    clearingImageCache: "Clearing…",
    imageCacheCleared:
      "The image cache was cleared. Images are cached again as you open documents.",
    imageMaintenanceDelayed:
      "Background image maintenance is delayed. Your documents are synced, and the app will retry automatically.",
  },
  desktopUpdate: {
    check: "Check for updates",
    checking: "Checking for updates",
    checkingDescription:
      "Connecting to GitHub Releases for the latest version.",
    availableTitle: "Update available",
    availableDescription:
      "Koinote {next} is available. You are using {current}.",
    downloadAndRestart: "Download and restart",
    downloading: "Downloading and installing the update",
    currentTitle: "You're up to date",
    currentDescription: "This client is already running the latest version.",
    failedTitle: "Update failed",
    failedDescription:
      "The update service is unavailable. Check your connection and try again.",
    saveFailedDescription:
      "Current edits could not be saved safely, so the update was cancelled. Copy the content before trying again.",
    retry: "Retry",
    later: "Later",
    close: "Close",
  },
  desktopSync: {
    synced: "Synced",
    syncing: "Syncing",
    offline: "Editing offline",
    pending: "changes waiting to sync",
    error: "Sync failed; click to retry",
    conflicts: "conflicts need attention",
    conflictsTitle: "Resolve sync conflicts",
    conflictsDescription:
      "These documents changed both locally and in the cloud. Choose which copy to keep; neither is silently overwritten.",
    keepLocal: "Keep local copy",
    useCloud: "Use cloud copy",
    close: "Resolve later",
    logoutWarning:
      "This device has {pending} unsynced changes, including {conflicts} conflicts. Continuing will permanently delete this local content. Log out anyway?",
    logoutSaveFailed:
      "The current edits could not be saved locally, so logout was cancelled. Try again or copy the content before signing out.",
  },
  footer: {
    tagline:
      "Koinote is a WYSIWYG online Markdown editor: render as you type, upload images straight to your image store, export and share in one click.",
    brandCn: "锦鲤笔记",
    product: "Product",
    editor: "Editor",
    download: "Download app",
    pricing: "Pricing",
    dashboard: "Dashboard",
    docsCenter: "Documentation",
    aiGuide: "AI optimization guide",
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
          title: "Lifetime Membership",
          body: [
            "“Lifetime” means a one-time, non-renewing, non-transferable membership for as long as both your account and the Koinote service continue to exist. It is not a promise that the service will operate forever.",
            "Lifetime currently includes a fixed 10 GB cloud-storage allowance shared by documents and images; invitation bonuses are separate. The base allowance is not promised to increase automatically.",
            "Future AI benefits mean member eligibility if and when relevant features launch. We do not promise a release date, feature set, model, or provider, and this does not mean unlimited free inference. Reasonable usage, cost-control, regional, model, or provider limits may apply and will be described when a feature launches.",
            "Deleting your account immediately ends the membership. Account deletion does not itself trigger an automatic refund, without limiting statutory refund or consumer rights.",
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
            "User feedback: feedback text, source page, and client details",
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
            "You can delete the entire account immediately from Dashboard by typing the current email and confirming again. The account, documents, versions, shares, MCP tokens, and image ledger are deleted, while related object-storage images are removed asynchronously. This cannot be undone.",
            "Minimal Stripe payment records needed for tax, disputes, and fraud prevention are detached from the account and retained as required by law. Deleted data in backups expires with the backup retention cycle and is not used to restore a deleted account.",
            "Feedback text, source pages, and client details you submitted are detached from your account and retained for troubleshooting and product improvement; they may still contain personal information you entered.",
            "If you cannot sign in or need to exercise another statutory right, you can still contact us at the address below.",
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
            "You can view and change your account details, export all documents, and delete documents or your account directly from Dashboard. Where local law grants additional rights to access, correct, export, or erase personal data, you can exercise them via the email below.",
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
    feedback_category_invalid: "Choose Bug or Experience feedback.",
    feedback_message_required: "Enter your feedback.",
    feedback_message_invalid:
      "Feedback contains unsupported characters. Remove them and try again.",
    feedback_message_too_long: "Feedback cannot exceed 4,000 characters.",
    feedback_page_invalid:
      "The current page is invalid. Refresh and try again.",
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
    pdf_path_must_be_absolute: "Choose a valid location for the PDF",
    pdf_path_must_end_with_pdf: "The PDF filename must end in .pdf",
    pdf_parent_directory_missing:
      "The selected folder no longer exists. Choose another location",
    pdf_path_invalid_unicode:
      "The save path contains unsupported characters. Choose another name or location",
    pdf_output_too_large:
      "The exported PDF exceeds 512 MB. Remove large images and try again",
    pdf_output_invalid: "The generated PDF is incomplete. Please try again",
    pdf_export_timed_out:
      "PDF export timed out. Reduce the document size or images and try again",
    pdf_export_window_missing:
      "The document window is unavailable. Reopen the document and try again",
    pdf_export_channel_closed:
      "PDF export stopped unexpectedly. Please try again",
    pdf_export_unsupported_platform:
      "One-click PDF export is not supported on this system",
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
    image_upload_failed:
      "The local image could not be synced. Check your connection and try again.",
    document_save_pending:
      "The current draft is not in the document store yet. Retry saving it first.",
    image_cache_full:
      "The local image cache is full. Clear it from the desktop home page.",
    local_image_missing:
      "A local image is missing. Remove it from the document and insert it again.",
    storage_quota_exceeded:
      "Cloud storage is full — permanently delete unneeded documents from Trash",
    image_empty: "The image is empty",
    share_not_found: "This link is invalid or has been revoked",
    share_access_invalid: "Invalid share access level",
    share_password_too_short: "Password must be at least 6 characters",
    desktop_share_sync_required:
      "This document must finish syncing before it can be shared. Check sync status and try again",
    desktop_share_cache_failed:
      "Sharing succeeded online, but the app could not save its local state. Open sharing and apply it again later",
    share_password_invalid: "Incorrect password",
    too_many_requests: "Too many attempts — please try again later",
    insufficient_credits:
      "Not enough credits. Purchase credits or use your own LLM channel",
    agent_llm_not_configured: "The built-in AI model is not configured",
    agent_invalid_response:
      "The model returned an invalid review. Start a new review",
    agent_provider_error:
      "The model provider rejected the request. Check the model and API key",
    agent_provider_unavailable:
      "The model provider is temporarily unavailable. Try again later",
    // Compatibility with older backend instances during a rolling deployment.
    agent_review_stale:
      "Some suggestions no longer match the current article. Review them individually and continue",
    agent_suggestion_conflict:
      "Some suggestions no longer match the current article. Review them individually and continue",
    agent_review_closed: "This review is already closed",
    agent_review_in_progress: "Another review is still running. Please wait",
    invalid_agent_review_source:
      "This source review is not currently available for deep analysis",
    invalid_agent_provider: "Invalid AI model provider",
    invalid_llm_channel_name: "Invalid channel name",
    invalid_llm_channel_url: "The channel Base URL is invalid or unsafe",
    invalid_llm_channel_model: "Invalid model name",
    invalid_llm_channel_api_key: "Invalid API key",
    llm_channel_not_found: "LLM channel not found",
    llm_channel_limit_reached:
      "The LLM channel limit has been reached. Delete one first",
    llm_channel_name_exists: "A channel with this name already exists",
    credit_billing_not_configured:
      "Credit purchases are not configured on this deployment",
  },
};
