import type { Messages } from "./types";

export const en: Messages = {
  nav: {
    editor: "Editor",
    dashboard: "Dashboard",
    login: "Log in",
    logout: "Log out",
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
    imageClickToEdit: "Click to edit image Markdown (caption and URL)",
    imageMarkdownLabel: "Image Markdown source",
    imageBroken: "Image failed to load — click to edit the URL",
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
      "Note: WeChat strips class attributes, so syntax highlighting cannot survive. Code keeps only its monospace font and background.",
    wechatMathConverted: "{n} formula(s) converted to images",
    wechatMathFailed: "{n} formula(s) failed; fell back to LaTeX source",
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
    too_deep: "Folders are nested too deep to create another one inside",
    name_too_long: "Folder name is too long",
    invalid_move: "Cannot move that folder here",
    not_found: "This item doesn't exist or has been deleted",
    image_type_unsupported: "Only PNG, JPEG, GIF and WebP are supported",
    image_type_mismatch: "File contents don't match the declared format",
    image_svg_rejected: "SVG images aren't supported, for security reasons",
    image_too_large: "Image exceeds the 10 MB limit",
    image_empty: "The image is empty",
    share_not_found: "This link is invalid or has been revoked",
    share_access_invalid: "Invalid share access level",
    share_password_too_short: "Password must be at least 6 characters",
    share_password_invalid: "Incorrect password",
    too_many_requests: "Too many attempts — please try again later",
  },
};
