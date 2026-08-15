import type { Messages } from "./types";

export const ja: Messages = {
  nav: {
    editor: "エディタ",
    download: "ダウンロード",
    pricing: "料金",
    docs: "ドキュメント",
    mcpGuide: "MCP 接続",
    versionHistoryGuide: "バージョン管理",
    dashboard: "ダッシュボード",
    documents: "マイドキュメント",
    trash: "ゴミ箱",
    invitations: "友達を招待",
    admin: "管理",
    login: "ログイン",
    logout: "ログアウト",
    userMenu: "アカウントメニュー",
  },
  home: {
    badge: "Markdown × Agent、書くために生まれた",
    title: "書くこと、最もピュアなかたちへ",
    subtitle:
      "Koinote は Typora ライクなオンライン Markdown エディタです。書きながらレンダリングし、画像を直接アップロードし、許可した Agent が文書を安全に操作できます。",
    ctaStart: "今すぐ書き始める",
    ctaDownload: "デスクトップ版をダウンロード",
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
        title: "Agent との共同作業",
        desc: "MCP を通じて Codex、Claude Code、OpenCode などに範囲を限定した文書アクセスを許可します。",
      },
      {
        title: "簡単なエクスポートと共有",
        desc: "Markdown / HTML の基本エクスポート。読み取り専用リンクでワンクリック共有。",
      },
      {
        title: "自動保存",
        desc: "入力するたびに保存し、revision の競合検出でブラウザと Agent の上書きを防ぎます。",
      },
    ],
    mcp: {
      eyebrow: "オープンな MCP アクセス",
      title: "Agent を執筆ワークフローへ",
      description:
        "ブラウザ拡張は不要です。期限付きまたは無期限で取り消し可能な個人トークンを作成すると、Codex、Claude Code、OpenCode などの標準 MCP クライアントが許可範囲内で Koinote 文書を検索・閲覧・編集できます。",
      agents: "Streamable HTTP MCP クライアントに対応",
      steps: [
        {
          title: "権限を限定",
          desc: "読み取り専用または読み書きトークンを作成し、いつでも表示・コピー・取り消しできます。",
        },
        {
          title: "安全に書き込む",
          desc: "すべての変更で revision を確認し、競合時の無言上書きを防ぎます。",
        },
        {
          title: "復元点を保持",
          desc: "会員は完全履歴を設定でき、無効時も最新の安全スナップショットを保持します。",
        },
      ],
      cta: "会員特典を見る",
    },
  },
  pricing: {
    eyebrow: "シンプルで透明な料金",
    title: "一度のアップグレードで、安心して書き続ける",
    subtitle:
      "無料版は日常の執筆に。終身会員は一度の支払いで容量、MCP、バージョン履歴を追加します。",
    freeName: "無料",
    freeDescription:
      "執筆を始め、エディタの全体的な流れを試すための基本プランです。",
    freePrice: "無料",
    freePeriod: "期間制限なし",
    lifetimeName: "終身会員",
    lifetimeDescription: "長期の執筆と Agent との共同作業に。",
    lifetimePeriod: "一度の支払いで終身利用",
    recommended: "おすすめ",
    included: "含まれるもの",
    freeFeatures: [
      "文書と画像に {storage} のクラウド容量",
      "完全な Markdown 編集、自動保存、端末間同期",
      "画像ホスティング、エクスポート、読み取り専用共有",
      "友達招待による追加クラウド容量",
    ],
    lifetimeFeatures: [
      "文書と画像に {storage} のクラウド容量",
      "Codex、Claude Code、OpenCode などの MCP アクセス",
      "設定可能なバージョン履歴と安全スナップショット復元",
      "今後の AI 機能を利用する権利",
      "無料版のすべての機能",
    ],
    loginToUpgrade: "ログインしてアップグレード",
    manageMembership: "会員と MCP を管理",
    active: "終身会員が有効です",
    loading: "最新料金を読み込み中…",
    loadFailed: "料金を読み込めませんでした。もう一度お試しください。",
    unavailable: "この環境ではオンライン決済が設定されていません。",
    faqTitle: "よくある質問",
    faqs: [
      {
        question: "サブスクリプションですか？",
        answer: "いいえ。終身会員は一度だけの支払いで、自動更新はありません。",
      },
      {
        question: "MCP では何ができますか？",
        answer:
          "許可した Agent は文書の検索、閲覧、作成、追記、更新、復元、ゴミ箱への移動ができます。完全削除は Web のみです。",
      },
      {
        question: "MCP の完全履歴を無効にしても復元できますか？",
        answer:
          "はい。会員の Agent 書き込みは常に最低 1 件の最新安全スナップショットを保持します。",
      },
      {
        question: "AI 機能は現在利用できますか？",
        answer:
          "まだです。終身会員には今後リリースされる AI 機能の利用資格が含まれます。",
      },
    ],
  },
  mcpGuide: {
    eyebrow: "MCP 接続ガイド",
    title: "Agent からドキュメントを安全に操作",
    subtitle:
      "Codex、Claude Code、OpenCode、OpenClaw、または Streamable HTTP MCP 対応クライアントを Koinote に接続できます。",
    overviewTitle: "仕組み",
    overviewBody:
      "モデル機能は Agent 側が提供します。Koinote は LLM を呼び出さず、認証、ドキュメントツール、競合検出、監査だけを担当します。",
    setupTitle: "準備",
    setupSteps: [
      { title: "永久会員を有効化", desc: "MCP は永久会員向け機能です。" },
      {
        title: "個人トークンを作成",
        desc: "読み取り専用または読み書きと、期限付きまたは無期限を選びます。",
      },
      {
        title: "クライアントを設定",
        desc: "下記の方法で https://koinote.app/mcp に接続します。",
      },
    ],
    clientsTitle: "各 Agent の接続方法",
    clientsSubtitle:
      "トークンはアカウントの認証情報です。環境変数か安全な保存領域に置き、リポジトリへコミットしないでください。",
    clientDescriptions: [
      "~/.codex/config.toml にリモート MCP を登録し、環境変数からトークンを読み込んで Codex を再起動します。",
      "Claude Code CLI で HTTP MCP と Bearer 認証ヘッダーを追加します。",
      "opencode.json に remote MCP を定義し、環境変数からヘッダーを渡します。",
      "OpenClaw CLI で Streamable HTTP サーバーを登録し、doctor で確認します。",
      "WorkBuddy などは Streamable HTTP と Authorization ヘッダーを設定できれば接続できます。",
    ],
    tokenPlaceholder: "ダッシュボードで作成したトークンに置き換えてください",
    verifyLabel: "設定後に試せるプロンプト",
    usageTitle: "Agent からの使い方",
    usageBody:
      "特別な構文は不要です。Koinote を操作すると伝えれば Agent が MCP ツールを選びます。置換やゴミ箱操作では対象文書と結果を明確にしてください。",
    prompts: [
      "Koinote で最近更新した 5 件のドキュメントを一覧にして。",
      "リモートワークの記事を書いて Koinote に保存して。",
      "「リリースチェックリスト」を探して振り返りの節を追記して。",
      "「古い下書き」を完全削除せずゴミ箱へ移して。",
    ],
    permissionsTitle: "権限と削除の境界",
    permissions: [
      "読み取り専用トークンは一覧、検索、本文と履歴の閲覧ができます。",
      "読み書きトークンは作成、追記、更新、履歴復元、ゴミ箱への移動と復元ができます。",
      "Agent は完全削除できません。完全削除は Web のゴミ箱で確認が必要です。",
      "トークンは個別に失効でき、期限切れや会員失効時には直ちに使えなくなります。",
    ],
    tokensCta: "MCP トークンを作成",
    historyCta: "バージョン管理を見る",
    pricingCta: "会員特典を見る",
  },
  versionGuide: {
    eyebrow: "バージョン管理ガイド",
    title: "大切な変更をいつでも復元可能に",
    subtitle:
      "Koinote が履歴を保持し、ブラウザと Agent の同時編集を調整し、誤操作から内容を復元する仕組みを説明します。",
    overviewTitle: "履歴の仕組み",
    overviewBody:
      "ブラウザ編集と MCP 書き込みは同じ revision と履歴ポリシーを使います。履歴は確認と復元に使われ、revision 検証は古い内容による静かな上書きを防ぎます。",
    availabilityTitle: "会員資格と保持上限",
    availabilityBody:
      "バージョン履歴は永久会員向けです。文書ごとに 1〜100 件、アカウント全体で合計 100 件まで保持し、上限を超えると古い履歴から削除します。",
    featuresTitle: "主な機能",
    features: [
      {
        title: "間隔をまとめて保存",
        desc: "通常の Web 編集は自動保存のたびではなく、一定間隔でスナップショットを作ります。",
      },
      {
        title: "柔軟な上限",
        desc: "履歴の有効・無効と、文書ごとの 1〜100 件の保持数を設定できます。",
      },
      {
        title: "安全スナップショット",
        desc: "MCP 完全履歴を無効にしても、Agent の置換前に直近の復元可能な状態を残します。",
      },
      {
        title: "競合検出",
        desc: "更新には最新 revision が必要で、古い書き込みは新しい内容を上書きせず失敗します。",
      },
      {
        title: "取り消せる復元",
        desc: "古い版を復元する前に現在の状態を保存するため、復元自体も元に戻せます。",
      },
    ],
    webTitle: "Web で確認・復元する",
    webSteps: [
      "エディターのツールバーからバージョン履歴を開き、現在の文書に残る履歴を確認します。",
      "各履歴には時刻と、Web エディター・MCP Agent・復元のいずれかの出所が表示されます。",
      "復元すると選んだ版が現在の内容になり、復元前の状態も回復ポイントとして保持されます。",
    ],
    mcpTitle: "MCP 書き込みの履歴設定",
    mcpRules: [
      "Agent の書き込みで完全な履歴を残すかを個別に選択できます。",
      "完全履歴を無効にしても、文書全体を置換する前の安全スナップショットは残ります。",
      "書き込み権限のある MCP クライアントは設定を確認・変更でき、読み取り専用トークンは確認だけできます。",
    ],
    safetyTitle: "おすすめ設定",
    safetyBody:
      "重要な文書では履歴と MCP 完全履歴を有効にしてください。アカウント全体の 100 件上限を考慮して文書ごとの保持数を決め、Agent が全文を置換する前に最新 revision を読むよう指示します。",
    settingsCta: "履歴設定を変更",
    mcpCta: "MCP 接続を見る",
    pricingCta: "会員特典を見る",
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
    verificationCode: "メール確認コード",
    verificationCodePlaceholder: "6 桁のコード",
    sendVerificationCode: "コードを送信",
    resendVerificationCode: "再送信",
    sendingVerificationCode: "送信中…",
    verificationSent: "確認コードを送信しました。メールをご確認ください。",
    verificationMockFilled: "ローカルテスト用コードを自動入力しました。",
    emailVerificationRequired:
      "パスワードを確認しました。続行するにはメール認証を完了してください。",
    verifyEmailTitle: "メールアドレスが未確認です",
    verifyEmailDescription:
      "下記のアドレスにコードを送信します。確認後、そのままログインします。",
    verifyAndLogin: "確認してログイン",
    backToLogin: "通常のログインに戻る",
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
    emailRegistration: "メールアドレスで登録",
    collapseEmailRegistration: "メール登録を閉じる",
    invitationCode: "招待コード（任意）",
    invitationCodePlaceholder: "16 文字のコードを入力",
    invitationRewardTitle: "友達から 500 MB のストレージが届きました",
    invitationBonusHint:
      "Google、GitHub、メールのどの方法でも有効です。登録後、友達にも 500 MB が追加されます。",
    haveInvitationCode: "招待コードをお持ちですか？",
    forgotPassword: "パスワードをお忘れですか？",
    resetPasswordTitle: "パスワードを再設定",
    resetPasswordDescription:
      "登録メールアドレスを入力してください。アドレスが存在するかどうかにかかわらず、同じ結果を表示します。",
    newPassword: "新しいパスワード",
    resetPasswordSubmit: "パスワードを再設定",
    resetPasswordSuccess:
      "パスワードを再設定しました。新しいパスワードでログインしてください。他の端末の古いセッションは無効です。",
    resetCodeSent:
      "このメールアドレスがパスワードアカウントに登録されている場合、確認コードを送信しました。受信トレイをご確認ください。",
  },
  security: {
    title: "アカウントのセキュリティ",
    description:
      "パスワードを変更すると、この端末はログイン状態を保ち、他の端末の古いセッションを直ちに無効化します。",
    oauthOnly:
      "このアカウントは現在 Google または GitHub でログインしており、変更できる Koinote パスワードはありません。",
    currentPassword: "現在のパスワード",
    newPassword: "新しいパスワード",
    confirmPassword: "新しいパスワードを確認",
    changePassword: "パスワードを変更",
    changingPassword: "変更中…",
    passwordChanged:
      "パスワードを変更しました。他の端末の古いセッションはログアウトしました。",
    sessionsTitle: "ログインセッション",
    sessionsDescription:
      "このブラウザはログイン状態を保ち、他のブラウザと端末を直ちにログアウトします。",
    invalidateSessions: "他の端末をログアウト",
    invalidatingSessions: "処理中…",
    sessionsInvalidated: "他の端末の古いセッションをログアウトしました。",
  },
  storage: {
    title: "クラウドストレージ",
    documents: "ドキュメント",
    images: "画像",
    usedOf: "{quota} 中 {used} 使用",
    remaining: "残り {remaining}",
    nearLimitHint:
      "クラウドの残り容量が少なくなっています。ゴミ箱から不要なドキュメントを完全に削除すると空き容量が増えます。",
    fullHint:
      "クラウドの容量がいっぱいのため、新しいドキュメントや画像を保存できません。ゴミ箱から不要なドキュメントを完全に削除してください。",
    loading: "読み込み中…",
    loadFailed: "使用量を読み込めませんでした",
    quotaDialogTitle: "クラウドストレージがいっぱいです",
    quotaDialogBody:
      "クラウドストレージを {quota} 中 {used} 使用しているため、処理を完了できませんでした。",
    quotaDialogHint:
      "ゴミ箱内のドキュメントも容量を使用します。完全削除後、参照されていない画像はバックグラウンドで削除されます。",
    quotaDialogDismiss: "了解",
    quotaDialogManage: "使用量を見る",
  },
  membership: {
    title: "Koinote ライフタイム",
    lifetimeBadge: "永久有効",
    activeBadge: "有効",
    description:
      "一度のアップグレードで、より大きな執筆スペースと今後の AI 機能へのアクセスを獲得できます。",
    oneTimePayment: "一度のお支払いで永久に利用可能",
    currencyLabel: "支払い通貨",
    currencyHint: "選択した通貨で Stripe Checkout にて決済されます。",
    storageBenefit: "10 GB クラウドストレージ",
    aiBenefit: "今後の AI 機能へのアクセス",
    aiComingSoon: "AI 機能は今後追加予定です",
    purchase: "永久アクセスを購入",
    redirecting: "安全な決済ページを開いています…",
    activeTitle: "ライフタイム会員を有効化しました",
    activeDescription:
      "10 GB のクラウドストレージと今後の AI 機能へのアクセスが含まれます。",
    unavailable: "この環境では会員決済が設定されていません。",
    loadFailed: "会員ステータスを読み込めませんでした。",
    checkoutSuccess: "支払いを確認しました。ライフタイム会員が有効です。",
    checkoutPending: "支払いを確認中です。完了後、権利は自動的に更新されます。",
    checkoutCancelled: "決済をキャンセルしました。請求は発生していません。",
    checkoutFailed: "決済を完了できませんでした。もう一度お試しください。",
  },
  mcp: {
    title: "Agent の文書アクセス（MCP）",
    description:
      "Codex、Claude Code、OpenCode などの標準 MCP Agent に、許可した範囲で Koinote 文書の読み書きを許可します。",
    membersOnly:
      "MCP は有料会員向け機能です。アップグレードすると、期限付きまたは無期限で取り消し可能なトークンを作成できます。",
    upgrade: "永久会員にアップグレード",
    tokenName: "トークン名",
    scope: "権限",
    readOnly: "読み取り専用",
    readWrite: "読み書き",
    expiry: "有効期限",
    days: "{n} 日",
    neverExpires: "無期限",
    editExpiry: "有効期限を編集",
    saveExpiry: "有効期限を保存",
    cancelExpiry: "編集をキャンセル",
    expiryUpdateFailed:
      "有効期限を更新できませんでした。もう一度お試しください。",
    create: "トークンを作成",
    createFailed: "トークンを作成できませんでした。再試行してください。",
    secretStored:
      "トークンは暗号化して保存され、後から再表示・コピーできます。",
    activeTokens: "有効なトークン",
    loading: "読み込み中…",
    loadFailed: "トークンを読み込めませんでした",
    empty: "有効なトークンはまだありません。",
    expires: "期限",
    lastUsed: "最終使用",
    reveal: "表示",
    hide: "隠す",
    revealFailed: "トークンを表示できませんでした。もう一度お試しください。",
    legacyNotRevealable:
      "旧形式のトークンは復元できません。引き続き使用するか、取り消して再作成してください。",
    revoke: "取り消す",
    revokeConfirm:
      "接続中の Agent は直ちにアクセスできなくなります。このトークンを取り消しますか？",
  },
  documentHistorySettings: {
    title: "バージョン履歴",
    description:
      "履歴を保存するか、Web と Agent の書き込みをどう保持するかを設定します。",
    membersOnly:
      "バージョン履歴は終身会員向けです。アップグレードすると保持方法を設定できます。",
    enabled: "バージョン履歴を有効にする",
    enabledHint:
      "無効にすると Web の新しい履歴作成を止めます。既存の履歴は削除されず、Agent は直近 1 件の安全スナップショットを保持します。",
    perDocumentMax: "文書ごとの最大履歴数",
    limitHint:
      "これは文書ごとの上限です。すべての文書でアカウント全体の上限 {accountMax} 件を共有します。数を減らすと古い履歴を直ちに削除します。",
    mcpEnabled: "MCP 書き込みの完全な履歴を保存",
    mcpEnabledHint:
      "無効にしても、Agent の書き込みは直近 1 件の安全スナップショットを保持します。安全スナップショットも履歴数の上限に含まれます。",
    loading: "履歴設定を読み込み中…",
    loadFailed: "履歴設定を読み込めませんでした",
    save: "設定を保存",
    saved: "設定を保存しました",
    saveFailed: "設定を保存できませんでした。もう一度お試しください。",
  },
  invitations: {
    title: "招待特典",
    headline: "友達を招待すると、双方に {reward}",
    description:
      "友達が専用リンクから登録すると、双方のクラウド容量に {reward} が無期限で追加されます。",
    copyLink: "招待リンクをコピー",
    copied: "コピーしました",
    successful: "招待成功",
    earned: "招待で獲得",
    totalBonus: "特典容量の合計",
    note: "特典は新規アカウント作成時に自動付与され、1 アカウントにつき最大 {limit} です。既存アカウントへの後付けや重複受取はできません。",
    loading: "招待情報を読み込み中…",
    loadFailed: "招待情報を読み込めませんでした",
  },
  dashboard: {
    greeting: "こんにちは、{name} さん",
    subtitle: "あなたの執筆ダッシュボードです。",
    newDoc: "新規ドキュメント",
    account: "アカウント",
    username: "ユーザー名",
    notSet: "未設定",
    joinedAt: "登録日",
    loading: "読み込み中…",
    loginRequired: "ログインしてください",
    loginRequiredHint: "アカウントページにアクセスするにはログインが必要です。",
    goLogin: "ログインへ",
  },
  documentsPage: {
    title: "マイドキュメント",
    subtitle: "クラウドに保存したドキュメントを確認し、編集を続けられます。",
    emptyHint: "クラウドドキュメントはまだありません。",
    emptyLinkText: "最初のドキュメントを作成",
  },
  search: {
    button: "検索",
    title: "すべてのドキュメントを検索",
    placeholder: "タイトルと本文を検索…",
    hint: "⌘K / Ctrl+K でいつでも開けます",
    startTyping: "キーワードを入力して、タイトルと Markdown 本文を検索します。",
    noResults: "一致するドキュメントはありません。",
    loadFailed: "検索に失敗しました。もう一度お試しください。",
    titleMatch: "タイトル一致",
    contentMatch: "本文一致",
  },
  transfer: {
    importButton: "ファイルをインポート",
    importFolderButton: "フォルダーをインポート",
    exportButton: "すべてエクスポート",
    importing: "ドキュメントと画像をインポート中…",
    exporting: "ドキュメントと画像をまとめています…",
    importSuccess: "{count} 件のドキュメントをインポートしました。",
    exportSuccess: "移行用アーカイブを作成しました。",
    importFailed:
      "インポートに失敗しました。形式、画像サイズ、容量をご確認ください。",
    exportFailed: "エクスポートに失敗しました。もう一度お試しください。",
    importHint: ".md、フォルダー、ZIP に対応し、参照画像も一緒に移行します。",
  },
  trashPage: {
    title: "ゴミ箱",
    subtitle: "文書は30日間保存され、その間もクラウド容量を使用します。",
    backToDocuments: "文書一覧に戻る",
    empty: "ゴミ箱は空です。",
    deletesOn: "{date} に完全に削除されます",
    restore: "復元",
    deletePermanently: "完全に削除",
    permanentWarning:
      "完全に削除すると履歴も失われ、元に戻せません。続行しますか？",
    typeToConfirm: "完全削除を確認するには「{title}」と入力してください：",
    loadFailed: "ゴミ箱を読み込めませんでした。もう一度お試しください。",
    actionFailed:
      "操作に失敗しました。確認文字を確認するか、もう一度お試しください。",
  },
  invitationsPage: {
    title: "友達を招待",
    subtitle: "専用の招待リンクを共有し、招待実績と特典容量を確認できます。",
  },
  admin: {
    title: "管理画面",
    subtitle: "サイトの成長、会員、売上、運用状況を確認します。",
    refresh: "更新",
    loading: "サイト指標を読み込み中…",
    loginRequired: "管理者アカウントでログインしてください。",
    goLogin: "ログインへ",
    forbidden: "このページは管理者のみアクセスできます。",
    loadFailed:
      "統計を読み込めませんでした。しばらくしてから再試行してください。",
    today: "今日の概要",
    trafficUnavailable: "Cloudflare のトラフィック指標を利用できません",
    trafficNotConfigured:
      "読み取り専用 Analytics Token が未設定です。ビジネス指標には影響しません。",
    trafficUpstreamError:
      "Cloudflare Analytics への接続に失敗しました。ビジネス指標は利用できます。",
    trafficNote:
      "UV / PV は Cloudflare エッジ HTTP Analytics の集計で、正当なクローラーや許可された自動通信を含む場合があります。",
    pageViews: "PV",
    uniqueVisitors: "UV",
    requests: "HTTP リクエスト",
    bandwidth: "エッジ通信量",
    newUsers: "新規ユーザー",
    newMembers: "新規会員",
    orders: "注文",
    overview: "累計ビジネス指標",
    totalUsers: "ユーザー総数",
    verifiedUsers: "認証済みユーザー",
    lifetimeMembers: "永久会員",
    conversionRate: "会員転換率",
    documents: "ドキュメント数",
    images: "画像オブジェクト",
    storageUsed: "サイトの使用容量",
    totalOrders: "注文総数",
    revenue: "通貨別売上",
    noRevenue: "完了した支払いはまだありません。",
    todayRevenue: "今日の売上",
    orderCount: "{count} 件の注文",
    trend: "直近 30 日",
    trendHint: "サイトのタイムゾーンによる日別の新規ユーザー、会員、注文です。",
    recentUsers: "最近のユーザー",
    recentPayments: "最近の支払い",
    noUsers: "ユーザーはまだいません。",
    noPayments: "支払いはまだありません。",
    user: "ユーザー",
    status: "状態",
    joinedAt: "登録日時",
    verified: "メール認証済み",
    unverified: "メール未認証",
    free: "無料",
    lifetime: "永久会員",
    amount: "金額",
    paidAt: "支払日時",
    generatedAt: "更新 {time} · {timeZone}",
    funnel: "プロダクトファネル",
    funnelHint:
      "初回達成のみを集計し、本文、タイトル、検索語、ファイル名は保存しません。",
    registered: "登録完了",
    firstDocument: "最初の文書",
    firstUpload: "最初の画像",
    firstExport: "最初の出力",
    mcpConnected: "MCP 接続",
    checkoutStarted: "Checkout 開始",
    checkoutCompleted: "支払い完了",
    retention: "ユーザー継続率",
    retentionHint:
      "計測開始後の新規ユーザーを対象に、UTC 登録日基準の D1 / D7 / D30 を表示します。",
    day1Retention: "D1 継続率",
    day7Retention: "D7 継続率",
    day30Retention: "D30 継続率",
    retentionSample: "{returned} / {eligible} 人",
  },
  editor: {
    placeholder:
      "何か書いてみましょう…「# 」で見出し、「- 」でリスト、「```」でコードブロック",
    saving: "保存中…",
    saved: "保存しました",
    charCount: "{n} 文字",
    saveFailed: "保存に失敗しました",
    resolveConflict: "競合を解決",
    conflictTitle: "この文書は別の場所で変更されました",
    conflictDescription:
      "左側がブラウザに残っているローカル下書き、右側がクラウドの最新版です。左側で統合して保存するか、クラウド版を採用してください。",
    localDraft: "ローカル下書き（編集可能）",
    remoteVersion: "クラウド最新版",
    useRemote: "クラウド版を使う",
    saveMerged: "統合した下書きを保存",
    conflictLoadFailed:
      "クラウド版を読み込めませんでした。ローカル下書きはこのブラウザに保存されています。",
    conflictSaveFailed:
      "保存中に文書が再び変更されました。再読み込みして統合してください。",
    history: "履歴",
    historyTitle: "バージョン履歴",
    historyDescription:
      "この文書に現在保持されているバージョンを確認・復元できます。",
    historyEmpty: "復元できる履歴はまだありません。",
    historyLoadFailed: "バージョン履歴を読み込めませんでした",
    historyRestoreFailed: "このバージョンを復元できませんでした",
    historyConflict:
      "文書が再び変更されました。履歴を閉じて開き直してください。",
    restoreVersion: "このバージョンを復元",
    historySource: { web: "Web エディター", mcp: "MCP Agent", restore: "復元" },
    historySafetySnapshot: "安全スナップショット",
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
    deleteDocument: "ゴミ箱に移動",
    deleteConfirm:
      "「{title}」をゴミ箱に移動しますか？30日以内なら復元できます。",
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
    rehostFailed:
      "一部の画像を画像ストアに取り込めず、元サイトの URL のままです",
    imageClickToEdit: "クリックして画像の Markdown（キャプションと URL）を編集",
    imageMarkdownLabel: "画像の Markdown ソース",
    imageBroken: "画像を読み込めません — クリックして URL を編集",
    imageRetrying: "画像を読み込み中、再試行しています…",
    share: "共有",
    shareTitle: "このドキュメントを共有",
    shareAccessLink: "リンクを知っている人",
    shareAccessLinkHint:
      "リンクはランダムで推測できませんが、入手した人は誰でも開けます",
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
    sharedViews: "{count} 回閲覧",
    copyToMine: "自分の Koinote にコピー",
    copyingToMine: "コピー中…",
    copiedToMine: "コピーしました。文書を開きます…",
    copyToMineFailed: "コピーに失敗しました。容量または画像をご確認ください。",
    loginToCopy: "ログインして自分の Koinote にコピー",
    exportLabel: "エクスポート",
    exportMarkdown: "Markdown (.md)",
    exportHTML: "ウェブページ (.html)",
    exportPDF: "PDF",
    exportDOCX: "Word (.docx)",
    exportPDFHint: "そのままダウンロード。文字は画像になります",
    exportPrint: "印刷 / PDF として保存",
    exportPrintHint:
      "文字は選択・検索可能 — ダイアログで「PDF として保存」を選択",
    mediaExport: "メディア向けに書き出す",
    mediaExportHint: "WeChat、Zhihu、Juejin に最適化",
    mediaTitle: "メディア向けエクスポート",
    mediaSubtitle: "投稿先を選ぶと、そのエディタに適した形式でコピーします。",
    mediaPlatformLabel: "投稿先",
    mediaWechat: "WeChat",
    mediaWechatHint: "装飾付きリッチテキスト",
    mediaZhihu: "Zhihu",
    mediaZhihuHint: "調整済みリッチテキスト",
    mediaJuejin: "Juejin",
    mediaJuejinHint: "Markdown",
    mediaCopy: "クリップボードにコピー",
    mediaCopied: "コピーしました",
    mediaWorking: "処理中…",
    mediaRichTextNote:
      "コード、画像キャプション、数式を貼り付け可能な形式に変換します。投稿先で一部スタイルが削除される場合があります。",
    mediaMarkdownNote:
      "記事タイトルを含む完全な Markdown をコピーし、そのまま Juejin に貼り付けられます。",
    mediaImagesUnreachable:
      "{n} 件の画像を投稿先が取得できない可能性があります（{hosts}）。貼り付け後に確認してください。",
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
    wechatMathConverted: "{n} 個の数式を画像に変換しました",
    wechatMathFailed:
      "{n} 個の数式が失敗し、LaTeX ソースにフォールバックしました",
    wechatMathTemporaryQuotaExceeded:
      "数式画像の一時ストレージが上限に達しました。{n} 個の数式を LaTeX ソースにフォールバックしました。古いエクスポート画像の期限切れ後に再試行してください。",
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
  changelog: {
    eyebrow: "継続的な改善",
    title: "更新履歴",
    subtitle:
      "Koinote の各リリースで追加・改善・修正された内容を確認できます。",
    unreleased: "次回リリース",
    newLabel: "新着",
    sourceLink: "GitHub で原文を見る",
    sourceNote:
      "このページはオープンソースリポジトリの日本語更新履歴と同期しています。",
    categories: {
      Added: "追加",
      Changed: "変更",
      Fixed: "修正",
      Security: "セキュリティ",
      Deprecated: "非推奨",
      Removed: "削除",
    },
  },
  desktopAuth: {
    eyebrow: "デスクトップアプリ",
    title: "Koinote アプリを承認",
    description: "この端末にオフラインコピーを保存し、接続が戻ったときに変更を同期します。",
    permissionsTitle: "承認すると、アプリは次の操作を行えます：",
    permissionDocuments: "文書とフォルダーの閲覧・作成・整理・共有・ゴミ箱への移動",
    permissionOffline: "この端末への文書のオフラインコピー保存",
    permissionIdentity: "ログイン中のアカウントを表示するための基本情報の取得",
    approve: "許可してアプリに戻る",
    cancel: "キャンセル",
    signIn: "ログインして続行",
    invalid: "承認リンクが無効です。アプリに戻ってもう一度お試しください。",
    failed: "承認を完了できませんでした。もう一度お試しください。",
  },
  desktopHome: {
    eyebrow: "デスクトップワークスペース",
    welcome: "おかえりなさい、{name} さん",
    subtitle: "前回の続きから始められます。変更はまずこの端末に保存され、オンライン時に自動同期されます。",
    newDocument: "新規ドキュメント",
    importDocuments: "Markdown をインポート",
    createFailed: "ドキュメントを作成できませんでした。もう一度お試しください。",
    loadFailed: "ローカル文書を読み込めませんでした。アプリを再起動して再試行してください。",
    continueTitle: "編集を続ける",
    recentTitle: "最近のドキュメント",
    allDocuments: "すべて表示",
    updated: "{date} に更新",
    emptyTitle: "最初のドキュメントを作成",
    emptyDescription: "空のドキュメントを作成するか、マイドキュメントから Markdown ファイルや ZIP アーカイブを読み込めます。",
    syncTitle: "同期状態",
    syncDescription: "オンライン時にローカルの変更を自動同期します。競合した場合は残すバージョンを選べます。",
    offlineTitle: "オフライン作業の準備完了",
    offlineDescription: "文書のコピーはこの端末に保存されるため、オフラインでも閲覧と編集を続けられます。",
    documentCount: "ローカルで利用可能な文書：{count} 件",
  },
  desktopUpdate: {
    check: "アップデートを確認",
    checking: "アップデートを確認中",
    checkingDescription: "GitHub Releases から最新バージョンを確認しています。",
    availableTitle: "新しいバージョンがあります",
    availableDescription: "Koinote {next} を利用できます。現在のバージョンは {current} です。",
    downloadAndRestart: "ダウンロードして再起動",
    downloading: "アップデートをダウンロードしてインストール中",
    currentTitle: "最新バージョンです",
    currentDescription: "このクライアントはすでに最新です。",
    failedTitle: "更新に失敗しました",
    failedDescription: "更新サービスに接続できません。ネットワークを確認して再試行してください。",
    saveFailedDescription: "現在の編集内容を安全に保存できなかったため、更新を中止しました。内容をコピーしてから再試行してください。",
    retry: "再試行",
    later: "後で",
    close: "閉じる",
  },
  desktopSync: {
    synced: "同期済み",
    syncing: "同期中",
    offline: "オフラインで編集中",
    pending: "件の変更が同期待ち",
    error: "同期に失敗しました。クリックして再試行",
    conflicts: "件の競合を確認してください",
    conflictsTitle: "同期競合を解決",
    conflictsDescription: "ローカルとクラウドの両方で変更されています。残す版を選んでください。自動で上書きはしません。",
    keepLocal: "ローカル版を残す",
    useCloud: "クラウド版を使う",
    close: "後で解決",
    logoutWarning: "この端末には未同期の変更が {pending} 件あり、そのうち {conflicts} 件は競合しています。続行するとローカル内容は完全に削除されます。それでもログアウトしますか？",
    logoutSaveFailed: "現在の編集内容をローカルに保存できなかったため、ログアウトを中止しました。再試行するか、本文をコピーしてからログアウトしてください。",
  },
  footer: {
    tagline:
      "Koinote は WYSIWYG のオンライン Markdown エディタです。入力しながら描画、画像はそのまま画像ストレージへ、ワンクリックで書き出しと共有ができます。",
    brandCn: "锦鲤笔记",
    product: "プロダクト",
    editor: "エディタ",
    download: "デスクトップ版",
    pricing: "料金",
    dashboard: "ダッシュボード",
    mcpGuide: "MCP 接続ガイド",
    versionHistoryGuide: "バージョン管理ガイド",
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
    changelog: "更新履歴",
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
            "Markdown、HTML、PDF、DOCX、WeChat・Zhihu・Juejin 向け形式への書き出し",
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
          body: [
            "以下の行為はアカウントの停止または終了につながる場合があります。",
          ],
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
            "ドキュメントはまず 30 日間ゴミ箱に保存されます。完全削除または期限切れ後、他のドキュメントから参照されていない関連画像のみが非同期で削除されます。",
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
            "自社プロダクト指標：登録、最初の文書、初回画像アップロード、初回エクスポート、初回 MCP 呼び出し、決済の完了時刻、アカウントごとに1日最大1件のアクティブ日、共有ページの累計閲覧数",
          ],
        },
        {
          title: "取得しないもの",
          body: [
            "第三者の広告や行動分析 SDK は組み込んでいません。広告配信のためのプロファイリングは行わず、ドキュメントの内容をモデルの学習に使うこともありません。プロダクト指標には文書タイトル、本文、検索語、インポートしたファイル名、共有ページ読者の識別情報を保存しません。",
          ],
        },
        {
          title: "情報の利用目的",
          body: ["取得した情報は以下の目的にのみ利用します。"],
          items: [
            "中核機能の提供：ドキュメントの保存と同期、画像のホスティング、共有リンクの生成",
            "本人確認とセッションの維持",
            "障害の調査、不正利用や攻撃の防止",
            "登録、初回作成、画像アップロード、エクスポート、MCP 接続、決済転換、D1/D7/D30 継続率の集計把握",
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
            "Stripe：会員決済の処理。決済に必要なメールアドレス、金額、通貨、支払い識別子を受け取ります",
            "Feishu：任意の社内決済通知。Koinote のユーザー ID、金額、通貨、注文識別子のみを送り、メールアドレスや文書内容は送りません",
          ],
        },
        {
          title: "保存期間と削除",
          body: [
            "ドキュメントはまず 30 日間ゴミ箱に入り、その間は本文、履歴、画像、使用容量が保持されます。完全削除または期限切れ後、他で参照されていない画像がバックグラウンド削除の対象になります。",
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
    invalid_invitation_code:
      "招待コードが無効です。確認してもう一度お試しください",
    email_already_registered: "このメールアドレスは登録済みです",
    verification_code_required: "メール確認コードを入力してください",
    invalid_verification_code: "確認コードが正しくありません",
    verification_code_expired:
      "確認コードの有効期限が切れました。再送信してください",
    verification_attempts_exceeded:
      "入力回数が上限を超えました。新しいコードを送信してください",
    verification_rate_limited:
      "確認コードのリクエストが多すぎます。後でもう一度お試しください",
    email_send_failed:
      "確認メールを送信できませんでした。もう一度お試しください",
    email_not_verified: "メールアドレスが確認されていません",
    email_already_verified:
      "メールアドレスは確認済みです。通常のログインに戻ってください",
    password_too_short: "パスワードは 6 文字以上必要です",
    conflict: "メールまたはユーザー名はすでに使われています",
    invalid_credentials: "アカウントまたはパスワードが正しくありません",
    current_password_incorrect: "現在のパスワードが正しくありません",
    password_not_available: "このアカウントには Koinote パスワードがありません",
    unauthorized: "ログインしていません",
    session_expired: "セッションの有効期限が切れました",
    server_error: "サーバーエラーです。しばらくして再試行してください",
    oauth_unsupported: "サポートされていないログイン方法です",
    oauth_not_configured: "このログイン方法はまだ設定されていません",
    oauth_denied: "認可がキャンセルされました",
    oauth_missing_params: "OAuth コールバックのパラメータが不足しています",
    oauth_invalid_state:
      "ログインセッションの有効期限が切れました。もう一度お試しください",
    oauth_exchange_failed:
      "サインインを完了できませんでした。もう一度お試しください",
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
    image_quota_exceeded:
      "画像ストレージがいっぱいです。ゴミ箱から不要なドキュメントを完全に削除してください",
    storage_quota_exceeded:
      "クラウドの容量がいっぱいです。ゴミ箱から不要なドキュメントを完全に削除してください",
    image_empty: "画像が空です",
    share_not_found: "このリンクは無効か、取り消されています",
    share_access_invalid: "共有権限の設定が無効です",
    share_password_invalid: "パスワードが正しくありません",
    share_password_too_short: "パスワードは 6 文字以上必要です",
    too_many_requests: "試行回数が多すぎます — しばらくしてからお試しください",
  },
};
