import type { Messages } from "./types";

export const en: Messages = {
  nav: {
    editor: "Editor",
    dashboard: "Dashboard",
    login: "Log in",
    logout: "Log out",
    userMenu: "Account menu",
  },
  home: {
    badge: "Markdown × AI, built for writing",
    title: "Writing, back to its purest form",
    subtitle:
      "Koinote is a Typora-style online Markdown editor. Render as you type, upload images inline, and write side by side with AI — so you can focus on the content itself.",
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
        title: "AI for creators",
        desc: "Continue, polish, translate, illustrate — the sidebar assistant is always on call.",
      },
      {
        title: "Easy export & share",
        desc: "Markdown / HTML export out of the box. Share via read-only links in one click.",
      },
      {
        title: "Auto save",
        desc: "Saved as you type, never lose a draft. Cloud sync across devices (subscription).",
      },
    ],
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
  },
  storage: {
    title: "Cloud storage",
    documents: "Documents",
    images: "Images",
    usedOf: "{used} of {quota} used",
    remaining: "{remaining} left",
    nearLimitHint:
      "You're running low on cloud storage. Deleting documents you no longer need will free some up.",
    fullHint:
      "Cloud storage is full, so new documents and images can't be saved. Delete documents you no longer need to free up space.",
    loading: "Loading…",
    loadFailed: "Couldn't load storage usage",
    quotaDialogTitle: "Cloud storage is full",
    quotaDialogBody:
      "You've used {used} of your {quota} cloud storage, so that didn't go through.",
    quotaDialogHint:
      "Deleting documents you no longer need will free up space — their images are cleaned up by a background job, usually within a few minutes.",
    quotaDialogDismiss: "Got it",
    quotaDialogManage: "View usage",
  },
  dashboard: {
    greeting: "Hi, {name}",
    subtitle: "This is your writing dashboard.",
    newDoc: "New document",
    account: "Account",
    username: "Username",
    notSet: "Not set",
    joinedAt: "Joined",
    myDocs: "My documents",
    emptyHint: "No cloud documents yet. Document management is coming soon — ",
    emptyLinkText: "head to the editor",
    loading: "Loading…",
    loginRequired: "Please log in",
    loginRequiredHint: "You need to log in to access the dashboard.",
    goLogin: "Go to login",
  },
  editor: {
    placeholder:
      'Start writing… type "# " for a heading, "- " for a list, "```" for a code block',
    saving: "Saving…",
    saved: "Saved",
    charCount: "{n} chars",
    saveFailed: "Save failed",
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
    deleteDocument: "Delete document",
    deleteConfirm: "Delete “{title}”? This cannot be undone.",
    emptyDocuments: "No documents yet — create one above",
    emptyOutline: "Type “# ” to add a heading; the outline appears here",
    collapsePanel: "Collapse panel",
    expandPanel: "Expand panel",
    resizeDocuments: "Resize documents panel",
    resizeOutline: "Resize outline panel",
    uploadFailed: "Image upload failed",
    uploadingImages: "Uploading {n}…",
    rehostFailed: "Some images could not be copied to your image store and still point at the original site",
    imageClickToEdit: "Click to edit image Markdown (caption and URL)",
    imageMarkdownLabel: "Image Markdown source",
    imageBroken: "Image failed to load — click to edit the URL",
    imageRetrying: "Loading image, retrying…",
    share: "Share",
    shareTitle: "Share this document",
    shareAccessLink: "Anyone with the link",
    shareAccessLinkHint: "The link is random and unguessable, but works for anyone who has it",
    shareTokenRotated:
      "A new link was generated: removing the password invalidated the old link immediately. If you already sent the old one, share again.",
    shareAccessPassword: "Password required",
    shareAccessPasswordHint: "Visitors must enter a password, at least 6 characters",
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
    exportLabel: "Export",
    exportMarkdown: "Markdown (.md)",
    exportHTML: "Web page (.html)",
    exportPDF: "PDF",
    exportDOCX: "Word (.docx)",
    exportPDFHint: "Downloads directly; text becomes an image",
    exportPrint: "Print / Save as PDF",
    exportPrintHint: "Selectable, searchable text — choose “Save as PDF” in the dialog",
    wechatExport: "WeChat Official Account",
    wechatExportHint: "Pick a theme, then paste straight into the WeChat editor",
    wechatTitle: "Export for WeChat",
    wechatSubtitle:
      "Styles are inlined per element so formatting survives the paste. Formulas become uploaded images.",
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
    wechatCopy: "Copy to clipboard",
    wechatCopied: "Copied — go paste it",
    wechatWorking: "Working…",
    wechatCodeNote:
      "Code blocks get Mac window dots, and highlighting is inlined as element styles; indentation and line breaks use non-breaking spaces and <br>, so they hold up even after WeChat strips CSS. Tabs expand to 4 spaces.",
    wechatMathConverted: "{n} formula(s) converted to images",
    wechatMathFailed: "{n} formula(s) failed; fell back to LaTeX source",
    wechatImagesUnreachable:
      "{n} image(s) point at {hosts}, which WeChat's servers cannot reach — they will show as broken after pasting. Your image host needs a publicly reachable domain (IMAGE_PUBLIC_BASE).",
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
  footer: {
    tagline:
      "Koinote is a WYSIWYG online Markdown editor: render as you type, upload images straight to your image store, export and share in one click.",
    brandCn: "锦鲤笔记",
    product: "Product",
    editor: "Editor",
    dashboard: "Dashboard",
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
            "Export to Markdown, HTML, PDF, DOCX, and WeChat article format",
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
            "When an account or document is deleted, the associated images are removed from the image store by an asynchronous background job, usually within minutes.",
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
          ],
        },
        {
          title: "What We Do Not Collect",
          body: [
            "There are no third-party advertising or behavioural analytics SDKs. We do not profile you for ad targeting, and we do not use your document content to train models.",
          ],
        },
        {
          title: "How We Use Information",
          body: ["Collected information is used only for the following."],
          items: [
            "Providing core features: saving and syncing documents, hosting images, generating share links",
            "Authenticating you and maintaining your session",
            "Diagnosing faults and preventing abuse or attacks",
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
          ],
        },
        {
          title: "Retention and Deletion",
          body: [
            "Documents are removed from the database as soon as you delete them. Images they referenced — and that none of your other documents reference — are queued for deletion by a background job.",
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
    password_too_short: "Password must be at least 6 characters",
    conflict: "Email or username is already taken",
    invalid_credentials: "Incorrect account or password",
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
    image_quota_exceeded: "Image storage is full — delete documents you no longer need to free up space",
    storage_quota_exceeded: "Cloud storage is full — delete documents you no longer need to free up space",
    image_empty: "The image is empty",
    share_not_found: "This link is invalid or has been revoked",
    share_access_invalid: "Invalid share access level",
    share_password_too_short: "Password must be at least 6 characters",
    share_password_invalid: "Incorrect password",
    too_many_requests: "Too many attempts — please try again later",
  },
};
