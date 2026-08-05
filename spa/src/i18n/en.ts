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
  },
};
