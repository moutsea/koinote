import type { Messages } from "./types";

export const ja: Messages = {
  nav: {
    editor: "エディタ",
    dashboard: "ダッシュボード",
    login: "ログイン",
    logout: "ログアウト",
  },
  home: {
    badge: "Markdown × AI、書くために生まれた",
    title: "書くこと、最もピュアなかたちへ",
    subtitle:
      "Koinote は Typora ライクなオンライン Markdown エディタです。書きながらレンダリング、画像を直接アップロード、AI が伴走 — だから内容そのものに集中できます。",
    ctaStart: "今すぐ書き始める",
    ctaRegister: "アカウント登録",
    features: [
      {
        title: "見たままが結果になる",
        desc: "Typora ライクな単一ペイン編集。書きながらレンダリング、ソースとプレビューの分割なし。",
      },
      {
        title: "Markdown の忠実さ",
        desc: "CommonMark を中核に。インポート／エクスポートは往復で崩れず、いつでも移行可能。",
      },
      {
        title: "画像ホスティング統合",
        desc: "ドラッグ＆ペーストでアップロード。自分の画像ホストを利用でき、本文にはクリーンなリンクのみ。",
      },
      {
        title: "クリエイターのための AI",
        desc: "続きを書く・推敲・翻訳・作図 — サイドバーのアシスタントがいつでも待機。",
      },
      {
        title: "簡単なエクスポートと共有",
        desc: "Markdown / HTML の基本エクスポート。読み取り専用リンクでワンクリック共有。",
      },
      {
        title: "自動保存",
        desc: "入力するたびに保存、下書きを失いません。複数端末のクラウド同期（サブスク解放）。",
      },
    ],
  },
  auth: {
    loginTitle: "おかえりなさい",
    loginSubtitle: "ログインして執筆を続けましょう",
    registerTitle: "アカウントを作成",
    registerSubtitle: "登録してすぐ書き始めましょう",
    username: "ユーザー名",
    usernamePlaceholder: "名前を決めてください",
    email: "メールアドレス",
    emailPlaceholder: "you@example.com",
    identifier: "ユーザー名またはメール",
    identifierPlaceholder: "ユーザー名またはメール",
    password: "パスワード",
    passwordPlaceholderLogin: "パスワードを入力",
    passwordPlaceholderRegister: "6 文字以上",
    confirmPassword: "パスワードの確認",
    confirmPasswordPlaceholder: "もう一度パスワードを入力",
    submitLogin: "ログイン",
    submitRegister: "登録",
    processing: "処理中…",
    noAccount: "アカウントをお持ちでないですか？",
    hasAccount: "すでにアカウントをお持ちですか？",
    toRegister: "登録",
    toLogin: "ログイン",
    passwordMismatch: "2 つのパスワードが一致しません",
    requestFailed: "リクエストに失敗しました。もう一度お試しください",
    orDivider: "または",
    continueWithGoogle: "Google で続ける",
    continueWithGitHub: "GitHub で続ける",
  },
  dashboard: {
    greeting: "こんにちは、{name} さん",
    subtitle: "あなたの執筆ダッシュボードです。",
    newDoc: "新規ドキュメント",
    account: "アカウント",
    username: "ユーザー名",
    notSet: "未設定",
    joinedAt: "登録日",
    myDocs: "マイドキュメント",
    emptyHint:
      "クラウドドキュメントはまだありません。ドキュメント管理は近日公開 — ",
    emptyLinkText: "エディタへ",
    loading: "読み込み中…",
    loginRequired: "ログインしてください",
    loginRequiredHint: "ダッシュボードにアクセスするにはログインが必要です。",
    goLogin: "ログインへ",
  },
  editor: {
    placeholder:
      "何か書いてみましょう…「# 」で見出し、「- 」でリスト、「```」でコードブロック",
    saving: "保存中…",
    saved: "保存しました",
    charCount: "{n} 文字",
    saveFailed: "保存に失敗しました",
    untitled: "無題のドキュメント",
    titlePlaceholder: "ドキュメントのタイトル",
    loginRequired: "ログインしてください",
    loginRequiredHint: "ログインするとドキュメントを作成・管理できます",
    goLogin: "ログイン",
    loading: "読み込み中…",
    notFound: "このドキュメントは存在しないか削除されています",
    backToList: "ドキュメント一覧へ戻る",
    documentsPanel: "ドキュメント",
    outlinePanel: "アウトライン",
    newDocument: "新規ドキュメント",
    deleteDocument: "ドキュメントを削除",
    deleteConfirm: "「{title}」を削除しますか？この操作は取り消せません。",
    emptyDocuments: "ドキュメントがありません。上から作成してください",
    emptyOutline: "「# 」と入力して見出しを追加すると、ここに表示されます",
    collapsePanel: "パネルを折りたたむ",
    expandPanel: "パネルを展開",
    resizeDocuments: "ドキュメントパネルの幅を調整",
    resizeOutline: "アウトラインパネルの幅を調整",
    uploadFailed: "画像のアップロードに失敗しました",
    uploadingImages: "{n} 件アップロード中…",
    imageClickToEdit: "クリックして画像の Markdown（キャプションと URL）を編集",
    imageMarkdownLabel: "画像の Markdown ソース",
    imageBroken: "画像を読み込めません — クリックして URL を編集",
    share: "共有",
    shareTitle: "このドキュメントを共有",
    shareAccessLink: "リンクを知っている人",
    shareAccessLinkHint: "リンクはランダムで推測できませんが、入手した人は誰でも開けます",
    shareTokenRotated:
      "新しいリンクを生成しました：パスワード保護の解除により、以前のリンクは即座に無効になりました。既に配布済みの場合は再共有してください。",
    shareAccessPassword: "パスワードが必要",
    shareAccessPasswordHint: "閲覧者はパスワードの入力が必要です（6 文字以上）",
    sharePasswordPlaceholder: "アクセスパスワードを設定",
    shareEnable: "共有を開始",
    shareUpdate: "設定を更新",
    shareRevoke: "共有を停止",
    shareRevokeConfirm:
      "既存のリンクは即座に無効になり、再開すると新しいリンクが生成されます。続けますか？",
    shareCopyLink: "リンクをコピー",
    shareCopied: "コピーしました",
    shareCopyFailed: "コピーに失敗しました — リンクを手動で選択してください",
    shareNotShared: "未共有",
    shareActive: "共有中",
    shareClose: "閉じる",
    sharedBy: "{name} が共有",
    sharedNotFound: "このリンクは無効か、取り消されています",
    sharedPasswordPrompt: "このドキュメントはパスワードが必要です",
    sharedPasswordSubmit: "表示",
    sharedOpenApp: "Koinote について",
    exportLabel: "エクスポート",
    exportMarkdown: "Markdown (.md)",
    exportHTML: "ウェブページ (.html)",
    exportPDF: "PDF",
    exportDOCX: "Word (.docx)",
    exportPDFHint: "そのままダウンロード。文字は画像になります",
    exportPrint: "印刷 / PDF として保存",
    exportPrintHint: "文字は選択・検索可能 — ダイアログで「PDF として保存」を選択",
    wechatExport: "WeChat 公式アカウント",
    wechatExportHint: "テーマを選んでコピー、WeChat エディタに貼り付け",
    wechatTitle: "WeChat 向けにエクスポート",
    wechatSubtitle:
      "スタイルは要素ごとにインライン化され、貼り付け後も崩れません。数式は画像としてアップロードされます。",
    wechatThemeLabel: "テーマ",
    themeNone: "デフォルト書式",
    tabsLabel: "開いているドキュメント",
    closeTab: "タブを閉じる",
    wechatCopy: "クリップボードにコピー",
    wechatCopied: "コピーしました",
    wechatWorking: "処理中…",
    wechatCodeNote:
      "注意：WeChat は class 属性を削除するため、シンタックスハイライトは保持できません。",
    wechatMathConverted: "{n} 個の数式を画像に変換しました",
    wechatMathFailed: "{n} 個の数式が失敗し、LaTeX ソースにフォールバックしました",
    exportFailed: "エクスポートに失敗しました",
    exporting: "エクスポート中…",
    importedLocalDraft: "ローカルの下書きを取り込みました",
    toolbar: {
      bold: "太字",
      italic: "斜体",
      strike: "取り消し線",
      code: "インラインコード",
      heading1: "見出し 1",
      heading2: "見出し 2",
      heading3: "見出し 3",
      bulletList: "箇条書き",
      orderedList: "番号付きリスト",
      taskList: "タスクリスト",
      blockquote: "引用",
      codeBlock: "コードブロック",
      link: "リンク",
      linkPrompt: "URL を入力",
      hint: "書式ツールバー",
    },
    sample: `# Koinote へようこそ

これは **Typora ライク** な WYSIWYG Markdown エディタです — 書きながらレンダリング、ソースとプレビューの分割はありません。

## 試してみましょう

- \`# \` と入力すると見出しになります
- \`- \` と入力するとリストになります
- \`> \` と入力すると引用になります
- バッククォート 3 つでコードブロックになります

> すべて忠実な Markdown として保存され、いつでもエクスポートできます。

\`\`\`js
function hello(name) {
  return \`Hello, \${name}!\`;
}
\`\`\`

| 機能 | 対応 |
|------|------|
| 見出し | ✅ |
| 表 | ✅ |
| コードハイライト | ✅ |

- [x] タスクリスト対応
- [ ] まだやること
`,
  },
  common: {
    theme: "テーマ切り替え",
    language: "言語",
  },
  errors: {
    bad_request: "リクエストの形式が正しくありません",
    missing_fields: "ユーザー名、メール、パスワードはすべて必須です",
    invalid_email: "メールアドレスの形式が正しくありません",
    password_too_short: "パスワードは 6 文字以上必要です",
    conflict: "メールまたはユーザー名はすでに使われています",
    invalid_credentials: "アカウントまたはパスワードが正しくありません",
    unauthorized: "ログインしていません",
    session_expired: "セッションの有効期限が切れました",
    server_error: "サーバーエラーです。しばらくして再試行してください",
    oauth_unsupported: "サポートされていないログイン方法です",
    oauth_not_configured: "このログイン方法はまだ設定されていません",
    oauth_denied: "認可がキャンセルされました",
    oauth_missing_params: "OAuth コールバックのパラメータが不足しています",
    oauth_invalid_state: "ログインセッションの有効期限が切れました。もう一度お試しください",
    oauth_exchange_failed: "サインインを完了できませんでした。もう一度お試しください",
    oauth_profile_failed: "プロバイダからプロフィールを取得できませんでした",
    oauth_sync_failed: "アカウントの同期に失敗しました。もう一度お試しください",
    title_too_long: "タイトルが長すぎます",
    content_too_large: "ドキュメントが大きすぎて保存できません",
    not_found: "この項目は存在しないか削除されています",
    image_type_unsupported: "PNG / JPEG / GIF / WebP のみ対応しています",
    image_type_mismatch: "ファイルの内容が形式と一致しません",
    image_svg_rejected: "セキュリティ上の理由から SVG 画像は使用できません",
    image_too_large: "画像が 10 MB の上限を超えています",
    image_empty: "画像が空です",
    share_not_found: "このリンクは無効か、取り消されています",
    share_access_invalid: "共有権限の設定が無効です",
    share_password_invalid: "パスワードが正しくありません",
    share_password_too_short: "パスワードは 6 文字以上必要です",
    too_many_requests: "試行回数が多すぎます — しばらくしてからお試しください",
  },
};
