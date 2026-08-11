import type { Messages } from "./types";

export const ja: Messages = {
  nav: {
    editor: "エディタ",
    dashboard: "ダッシュボード",
    login: "ログイン",
    logout: "ログアウト",
    userMenu: "アカウントメニュー",
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
  storage: {
    title: "クラウドストレージ",
    documents: "ドキュメント",
    images: "画像",
    usedOf: "{quota} 中 {used} 使用",
    remaining: "残り {remaining}",
    nearLimitHint:
      "クラウドの残り容量が少なくなっています。不要なドキュメントを削除すると空き容量が増えます。",
    fullHint:
      "クラウドの容量がいっぱいのため、新しいドキュメントや画像を保存できません。不要なドキュメントを削除すると空き容量が増えます。",
    loading: "読み込み中…",
    loadFailed: "使用量を読み込めませんでした",
    quotaDialogTitle: "クラウドストレージがいっぱいです",
    quotaDialogBody:
      "クラウドストレージを {quota} 中 {used} 使用しているため、処理を完了できませんでした。",
    quotaDialogHint:
      "不要なドキュメントを削除すると空き容量が増えます。含まれる画像はバックグラウンド処理で削除され、通常は数分以内に完了します。",
    quotaDialogDismiss: "了解",
    quotaDialogManage: "使用量を見る",
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
    deleteSaveFailed:
      "最新の変更を保存できなかったため、ドキュメントは削除されませんでした。接続を確認して再試行してください。",
    emptyDocuments: "ドキュメントがありません。上から作成してください",
    emptyOutline: "「# 」と入力して見出しを追加すると、ここに表示されます",
    collapsePanel: "パネルを折りたたむ",
    expandPanel: "パネルを展開",
    resizeDocuments: "ドキュメントパネルの幅を調整",
    resizeOutline: "アウトラインパネルの幅を調整",
    uploadFailed: "画像のアップロードに失敗しました",
    uploadingImages: "{n} 件アップロード中…",
    rehostFailed: "一部の画像を画像ストアに取り込めず、元サイトの URL のままです",
    imageClickToEdit: "クリックして画像の Markdown（キャプションと URL）を編集",
    imageMarkdownLabel: "画像の Markdown ソース",
    imageBroken: "画像を読み込めません — クリックして URL を編集",
    imageRetrying: "画像を読み込み中、再試行しています…",
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
    newFolder: "新しいフォルダ",
    renameFolder: "名前を変更",
    deleteFolder: "フォルダを削除",
    deleteFolderConfirm:
      "フォルダ「{name}」を削除しますか？中のドキュメントとサブフォルダは一つ上の階層に移動し、削除されません。",
    untitledFolder: "無題のフォルダ",
    folderNamePlaceholder: "フォルダ名",
    dropToRoot: "ここにドロップしてフォルダから出す",
    cannotDropIntoSelf: "フォルダを自身のサブフォルダには移動できません",
    newSubfolder: "新しいサブフォルダ",
    newDocumentHere: "ここに新規ドキュメント",
    treeMenu: "ファイルツリーの操作",
    wechatCopy: "クリップボードにコピー",
    wechatCopied: "コピーしました",
    wechatWorking: "処理中…",
    wechatCodeNote:
      "コードブロックに Mac ウィンドウの 3 つのドットが付き、ハイライトはインラインスタイルとして埋め込まれます。インデントと改行はノーブレークスペースと <br> で保持するため、WeChat が CSS を削除しても崩れません。タブは 4 スペースに展開されます。",
    wechatMathConverted: "{n} 個の数式を画像に変換しました",
    wechatMathFailed: "{n} 個の数式が失敗し、LaTeX ソースにフォールバックしました",
    wechatImagesUnreachable:
      "{n} 枚の画像が {hosts} を指しており、WeChat のサーバーから取得できません。貼り付け後は画像切れになります。画像ホストに公開ドメイン（IMAGE_PUBLIC_BASE）の設定が必要です。",
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
  footer: {
    tagline:
      "Koinote は WYSIWYG のオンライン Markdown エディタです。入力しながら描画、画像はそのまま画像ストレージへ、ワンクリックで書き出しと共有ができます。",
    brandCn: "锦鲤笔记",
    product: "プロダクト",
    editor: "エディタ",
    dashboard: "ダッシュボード",
    home: "ホーム",
    built: "他に作ったもの",
    company: "運営",
    companyName: "Fomalhaut Labs",
    legal: "規約",
    privacy: "プライバシーポリシー",
    terms: "利用規約",
    cookies: "Cookie ポリシー",
    copyright: "Koinote",
    allRightsReserved: "All rights reserved",
    contact: "お問い合わせ",
  },
  legal: {
    updatedLabel: "更新日",
    effectiveLabel: "発効日",
    backHome: "ホームに戻る",
    relatedTitle: "関連する規約",
    terms: {
      title: "利用規約",
      summary:
        "本規約は Koinote の利用条件を定めるものです。利用を続けることで本規約に同意したものとみなされます。",
      sections: [
        {
          title: "規約への同意",
          body: [
            "Koinote にアクセスまたは利用することで、本規約に拘束されることに同意したものとみなされます。いずれかの条項に同意できない場合は、利用を中止してください。",
          ],
        },
        {
          title: "サービスの内容",
          body: [
            "Koinote はオンラインでの Markdown 執筆、保存、書き出し、共有を提供します。",
          ],
          items: [
            "自動保存付きの WYSIWYG Markdown 編集",
            "ドキュメントとフォルダの管理",
            "画像のアップロードとホスティング",
            "Markdown、HTML、PDF、DOCX、WeChat 記事形式への書き出し",
            "閲覧専用の共有リンク（任意でパスワード保護）",
          ],
        },
        {
          title: "アカウント",
          body: [
            "アカウント上のすべての活動について、パスワードとセッションの保護を含め、利用者が責任を負います。アカウントが侵害された疑いがある場合は速やかにご連絡ください。",
          ],
          items: [
            "他人の身元で登録しないこと",
            "認証情報を共有しないこと",
            "セキュリティ上の問題は公開して悪用せず、責任ある形で報告すること",
          ],
        },
        {
          title: "利用者のコンテンツ",
          body: [
            "作成したドキュメントとアップロードした画像は利用者のものです。当方はその所有権を主張せず、サービス運営に関係のない目的には使用しません。",
            "サービスを動かすため、必要な範囲でこれらを保存・転送・表示します。ドキュメントをデータベースに書き込み、画像をオブジェクトストレージに置き、共有を有効にした際に閲覧者へ表示することがこれに当たります。",
          ],
        },
        {
          title: "禁止事項",
          body: ["以下の行為はアカウントの停止または終了につながる場合があります。"],
          items: [
            "権利侵害を含む違法なコンテンツのアップロードや共有",
            "画像ストレージを一般的なファイル配布や画像の直リンク用途に使うこと",
            "自動化による制限の回避、またはサービスへの負荷試験",
            "他者のドキュメントや共有リンクへの不正アクセスの試み",
          ],
        },
        {
          title: "共有リンク",
          body: [
            "共有を有効にすると、リンクを持つ人はログインせずにそのドキュメントを閲覧できます。パスワードは保護を一段追加しますが、リンクの漏洩は内容の漏洩と同じです。共有して差し支えない内容かはご自身で判断してください。",
            "共有はいつでも取り消し、またはリンクを再生成できます。取り消すと古いリンクは即座に無効になります。",
          ],
        },
        {
          title: "提供可能性",
          body: [
            "安定した提供を目指しますが、無停止を保証するものではありません。保守、更新、外部サービスの障害により一時的に利用できないことがあります。重要な内容は書き出してバックアップを保管してください。",
          ],
        },
        {
          title: "終了",
          body: [
            "不正利用、詐欺、セキュリティ上の危険、本規約違反がある場合、アクセスを停止または終了することがあります。利用者はいつでも利用を中止できます。",
            "アカウントまたはドキュメントを削除すると、関連する画像は非同期のバックグラウンド処理により画像ストレージから削除されます。通常は数分以内に完了します。",
          ],
        },
        {
          title: "免責と責任の制限",
          body: [
            "本サービスは「現状のまま」提供されます。適用法が認める最大限の範囲において、本サービスの利用または利用不能から生じる間接損害、データの喪失、逸失利益について責任を負いません。",
          ],
        },
        {
          title: "規約の変更",
          body: [
            "本規約は改定される場合があります。重要な変更は本ページの更新日に反映されます。改定後も利用を続けた場合、改定後の規約に同意したものとみなされます。",
          ],
        },
        {
          title: "連絡先",
          body: [
            "本規約に関するお問い合わせは cfjwlchangji@gmail.com までお送りください。",
          ],
        },
      ],
    },
    privacy: {
      title: "プライバシーポリシー",
      summary:
        "本ポリシーは Koinote が取得する情報とその理由、利用と保護の方法、および利用者による管理方法を説明します。",
      sections: [
        {
          title: "取得する情報",
          body: ["サービス提供に必要な情報のみを取得します。"],
          items: [
            "アカウント情報：メールアドレス、ユーザー名、表示名、ハッシュ化されたパスワード",
            "ソーシャルログインを使う場合、Google または GitHub から返される基本プロフィール（メールアドレス、ユーザー名、アバター）",
            "作成したコンテンツ：ドキュメントのタイトルと本文、フォルダ構成、アップロードした画像",
            "共有設定：共有トークン、ハッシュ化されたアクセスパスワード",
            "運用ログ：障害調査と不正利用対策に必要な範囲でのリクエスト時刻、IP、User-Agent",
          ],
        },
        {
          title: "取得しないもの",
          body: [
            "第三者の広告や行動分析 SDK は組み込んでいません。広告配信のためのプロファイリングは行わず、ドキュメントの内容をモデルの学習に使うこともありません。",
          ],
        },
        {
          title: "情報の利用目的",
          body: ["取得した情報は以下の目的にのみ利用します。"],
          items: [
            "中核機能の提供：ドキュメントの保存と同期、画像のホスティング、共有リンクの生成",
            "本人確認とセッションの維持",
            "障害の調査、不正利用や攻撃の防止",
            "お問い合わせへの対応",
          ],
        },
        {
          title: "保存場所",
          body: [
            "ドキュメント本文とアカウント情報は自社運用の PostgreSQL に保存されます。画像は Cloudflare R2 に保存し、当方の Worker 経由で配信します。つまりストレージの認証情報がブラウザへ渡ることはありません。",
          ],
        },
        {
          title: "第三者サービス",
          body: [
            "Koinote の運営は少数のインフラ事業者に依存しており、各社はそれぞれの役割の範囲でのみデータを扱います。",
          ],
          items: [
            "Cloudflare：CDN、Workers、R2 オブジェクトストレージ",
            "Google、GitHub：それらでログインを選んだ場合の本人確認のみ",
          ],
        },
        {
          title: "保存期間と削除",
          body: [
            "ドキュメントは削除した時点でデータベースから取り除かれます。そこで参照されていた画像のうち、他のドキュメントから参照されていないものは、バックグラウンド処理の削除待ちキューに入ります。",
            "アカウントとその全データの削除をご希望の場合はメールでご連絡ください。",
          ],
        },
        {
          title: "セキュリティ",
          body: [
            "通信の HTTPS 化、パスワードのハッシュ保存、データベース権限の分離といった対策を用いています。ただし完全に安全なシステムは存在しないため、カード番号や身分証明書などの機密性の高い情報はノートに保管しないでください。",
          ],
        },
        {
          title: "利用者の権利",
          body: [
            "アカウント情報の確認と変更、全ドキュメントの書き出し、ドキュメントやアカウントの削除はいつでも可能です。居住地の法令が個人データへのアクセス、訂正、移転、消去の権利を認めている場合、下記のメールアドレスから行使できます。",
          ],
        },
        {
          title: "子どもの利用",
          body: [
            "本サービスは 14 歳未満の子どもを対象としていません。該当するアカウントを確認した場合は削除します。",
          ],
        },
        {
          title: "連絡先",
          body: [
            "プライバシーに関するご請求は cfjwlchangji@gmail.com までお送りください。",
          ],
        },
      ],
    },
    cookies: {
      title: "Cookie ポリシー",
      summary:
        "本ポリシーは Koinote が使用する Cookie とブラウザストレージ、およびそれぞれの用途を説明します。",
      sections: [
        {
          title: "必須 Cookie",
          body: [
            "ログイン状態を保持するためにセッション Cookie を 1 つ使用します。HttpOnly と SameSite が設定されており、ページのスクリプトからは読み取れません。これを拒否するとログインできません。",
          ],
        },
        {
          title: "ブラウザのローカルストレージ",
          body: [
            "以下の設定はブラウザの localStorage に保存され、サーバーへ送信されることはありません。ブラウザのデータを消去すると初期化されます。",
          ],
          items: [
            "koinote-theme：ライト / ダークテーマの選択",
            "koinote-locale：表示言語",
            "未ログイン時に書いたローカル下書き（ログイン後にアカウントへ取り込まれます）",
          ],
        },
        {
          title: "使用しないもの",
          body: [
            "広告 Cookie、サイト間トラッキングピクセル、第三者の行動分析スクリプトは使用していません。",
          ],
        },
        {
          title: "第三者の Cookie",
          body: [
            "Google または GitHub でのログインを選ぶと各サイトへ遷移し、そこで独自の Cookie が設定される場合があります。それらは各社のプライバシーポリシーに従います。",
          ],
        },
        {
          title: "Cookie の管理",
          body: [
            "ほとんどのブラウザで Cookie の確認、ブロック、削除ができます。ただしセッション Cookie をブロックするとログイン状態を維持できません。",
          ],
        },
        {
          title: "連絡先",
          body: [
            "Cookie に関するお問い合わせは cfjwlchangji@gmail.com までお送りください。",
          ],
        },
      ],
    },
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
    image_fetch_rejected: "この画像アドレスは取得できません",
    image_fetch_failed: "元サイトからこの画像を取得できませんでした",
    too_deep: "フォルダの階層が深すぎるため、これ以上作成できません",
    name_too_long: "フォルダ名が長すぎます",
    invalid_move: "このフォルダをここへは移動できません",
    not_found: "この項目は存在しないか削除されています",
    image_type_unsupported: "PNG / JPEG / GIF / WebP のみ対応しています",
    image_type_mismatch: "ファイルの内容が形式と一致しません",
    image_svg_rejected: "セキュリティ上の理由から SVG 画像は使用できません",
    image_too_large: "画像が 10 MB の上限を超えています",
    image_quota_exceeded: "画像ストレージがいっぱいです。不要なドキュメントを削除すると空き容量が増えます",
    storage_quota_exceeded: "クラウドの容量がいっぱいです。不要なドキュメントを削除すると空き容量が増えます",
    image_empty: "画像が空です",
    share_not_found: "このリンクは無効か、取り消されています",
    share_access_invalid: "共有権限の設定が無効です",
    share_password_invalid: "パスワードが正しくありません",
    share_password_too_short: "パスワードは 6 文字以上必要です",
    too_many_requests: "試行回数が多すぎます — しばらくしてからお試しください",
  },
};
