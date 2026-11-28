import type { Locale } from "./types";
import type { MCPClientId } from "../mcpKnowledge";

export interface MCPKnowledgeMessages {
  title: string;
  positioning: string;
  membership: string;
  connectionsTitle: string;
  connections: Record<"documents" | "repositories" | "configSync", { title: string; description: string }>;
  toolsTitle: string;
  toolsIntro: string;
  kinds: Record<"read" | "write" | "external", string>;
  scopeLabel: string;
  effectsTitle: string;
  effects: string[];
  boundariesTitle: string;
  boundaries: string[];
  limitsSummary: string;
  clientTitle: string;
  back: string;
  official: string;
  environmentTitle: string;
  environmentHelp: string;
  clientDescriptions: Record<MCPClientId, string>;
  clientNotes: Record<MCPClientId, string>;
  verifyTitle: string;
  verify: string;
  repositorySetup: string;
  genericTitle: string;
  genericHelp: string;
  copy: string;
  copied: string;
  copyFailed: string;
}

export const mcpKnowledge: Record<Locale, MCPKnowledgeMessages> = {
  "zh": {
    "title": "MCP 知识库中心",
    "positioning": "个人 AI 知识文档库：Markdown 写作与整理，并通过 MCP 让你的 Agent 安全检索、读取和修改文档。",
    "membership": "免费版支持编辑、同步、图床、导出和分享。文档 MCP、仓库 MCP 与站内 AI 助手需要终身会员。配置同步使用独立临时授权。",
    "connectionsTitle": "选择连接与凭证",
    "connections": {
      "documents": {
        "title": "文档 MCP",
        "description": "连接名 koinote，使用文档 PAT。read 可读取，write 可编辑，publish 可读取和管理 GEO 摘要并推送公众号草稿。write 不包含公众号推送。令牌可设置有效期并单独撤销。"
      },
      "repositories": {
        "title": "Skills / Agent 仓库 MCP",
        "description": "连接名 koinote-agent，使用独立的 agent_read 或 agent_write PAT，环境变量为 KOINOTE_AGENT_TOKEN。相同 /mcp 端点按凭证提供仓库工具。manage_agent_workspace 可永久删除仓库，更新和恢复也可能删除文件。"
      },
      "configSync": {
        "title": "配置同步 MCP",
        "description": "连接名 koinote-config-sync，从配置快照的「复制给 AI」取得独立临时授权，普通文档或仓库 PAT 无法使用。凭证只读、30 分钟有效，绑定单个快照及 revision，免费账号也可为自己的一个配置快照授权。Agent 获取密文，在本地用用户提供的密钥解密。只将凭证和密钥交给信任的 Agent。撤销停止后续读取，已下载内容无法收回。超过 8 MiB 的密文使用工具返回的下载地址获取整包，上限 64 MiB。"
      }
    },
    "toolsTitle": "工具目录",
    "toolsIntro": "以下列出全部注册工具。连接后可见的工具取决于凭证类型与 scope。",
    "kinds": {
      "read": "只读",
      "write": "写入",
      "external": "外部副作用"
    },
    "scopeLabel": "所需 scope / 凭证",
    "effectsTitle": "外部操作与费用",
    "effects": [
      "generate_wechat_geo_summary 使用平台模型生成并保存摘要，消耗 credits。update_wechat_geo_summary 编辑已有摘要或开关，不调用模型、不消耗 credits。两者均允许 write 和 publish。",
      "sync_document_to_feishu 需要 write 和飞书绑定，以 Koinote 内容单向覆盖已关联的飞书文档。",
      "push_wechat_draft 需要 publish 和公众号绑定，会创建外部草稿并可能上传图片。推送及可选 AI 封面按现有规则消耗 credits，运营授权减免以实际授权为准。常规文档操作由客户端提供模型能力。"
    ],
    "boundariesTitle": "能力与安全边界",
    "boundaries": [
      "MCP 使用 Bearer 凭证，未提供 OAuth MCP。要求 OAuth 且无法配置 Bearer 请求头的网页版客户端当前无法直接接入。",
      "搜索对标题和正文做不区分大小写的子串匹配。尚未提供 RAG 或语义检索。",
      "文档 PAT 没有文件夹级授权范围，folderId 仅筛选结果。文档默认私有，工具仅访问当前账号授权的数据。",
      "尚未提供双向链接、知识图谱或标签。",
      "文档追加、替换、文本补丁、元数据更新、版本恢复、移入或移出回收站要求 expectedRevision。冲突时先读取最新版本，避免旧内容静默覆盖。创建、文件夹操作、移动与 GEO 摘要等有各自的校验规则。",
      "文档 MCP 可移入保留 30 天的回收站，不能永久删除文档。仓库 manage_agent_workspace 的永久删除能力请另行确认。",
      "文档和仓库 MCP 活动日志保留 180 天，记录工具、结果、耗时及关联标识，不记录正文或令牌原文。配置同步不提供同样的活动日志。"
    ],
    "limitsSummary": "MCP 未提供 OAuth。需 OAuth 且不能传 Bearer 的网页连接方式无法直连。标题和正文按子串搜索，尚无 RAG、语义检索、文件夹级文档令牌、双向链接、图谱或标签。文档默认私有，文档内容更新等操作校验 revision。文档与仓库 MCP 活动日志保留 180 天且不记正文。配置同步不提供同样日志。",
    "clientTitle": "客户端接入指南",
    "back": "返回 MCP 总览",
    "official": "客户端官方文档",
    "environmentTitle": "准备环境变量",
    "environmentHelp": "在启动客户端的终端中设置实际令牌。示例中的 knt_mcp_... 是占位值，请使用环境变量或安全存储保护凭证，避免写入仓库。先用只读令牌验证连接。",
    "clientDescriptions": {
      "codex": "在 ~/.codex/config.toml 添加此配置，从同一终端启动 Codex，使其读取 KOINOTE_MCP_TOKEN。",
      "claude-code": "将 HTTP MCP 配置写入项目的 .mcp.json，在设置环境变量的终端启动 Claude Code。配置文件只保存变量引用。",
      "opencode": "先确认 OpenCode 主版本，选择对应的配置块。V2 的服务位于 mcp.servers，V1 位于 mcp。两者均关闭 OAuth 并使用环境变量请求头。",
      "openclaw": "通过 CLI 保存 Streamable HTTP 连接。请求头使用单引号保留环境变量引用，--no-probe 先保存配置，再进行只读探测。"
    },
    "clientNotes": {
      "codex": "此配置使用支持远程 HTTP MCP 和 bearer_token_env_var 的 Codex CLI。修改后重新启动客户端。",
      "claude-code": "Claude Code CLI 支持 .mcp.json 中 headers 的环境变量展开。首次使用项目配置时按客户端提示确认信任。",
      "opencode": "V1 与 V2 配置块二选一。已有其它服务时，把 koinote 条目合入对应对象，保留已有配置。",
      "openclaw": "仓库曾验证 OpenClaw 2026.6.10。当前官方文档要求 Gateway 停止后再运行 doctor --probe。Gateway 运行中可先保存 --no-probe 配置。先查看所用版本的命令帮助。"
    },
    "verifyTitle": "只读验证与排错",
    "verify": "连接后查看工具列表，使用 read 令牌调用 list_documents 验证。401 时检查当前客户端进程的环境变量、凭证类型、有效期和撤销状态。文档或仓库连接还需有效终身会员。写工具缺失时检查 scope。",
    "repositorySetup": "连接仓库时，将配置中的连接名改为 koinote-agent，并使用 KOINOTE_AGENT_TOKEN 环境变量及仓库 PAT。配置同步从快照复制独立连接指引。",
    "genericTitle": "WorkBuddy / 通用客户端",
    "genericHelp": "客户端需支持远程 Streamable HTTP 和 Authorization 请求头。将 Bearer 凭证存入客户端的环境变量或安全存储，连接 https://koinote.app/mcp。",
    "copy": "复制配置",
    "copied": "已复制",
    "copyFailed": "复制不可用，请选中代码并手动复制。"
  },
  "en": {
    "title": "MCP knowledge base",
    "positioning": "Koinote is a personal AI knowledge and document library for Markdown writing and organization, with MCP-compatible agents that securely search, read, and edit your documents.",
    "membership": "The free plan includes editing, sync, image hosting, export, and sharing. Document MCP, repository MCP, and the built-in AI assistant require lifetime membership. Configuration sync uses separate temporary authorization.",
    "connectionsTitle": "Choose a connection and credential",
    "connections": {
      "documents": {
        "title": "Document MCP",
        "description": "Use the connection name koinote and a document PAT. The read scope allows reading, write allows editing, and publish allows reading, GEO summary management, and WeChat draft delivery. WeChat delivery requires publish. Tokens support expiry and individual revocation."
      },
      "repositories": {
        "title": "Skills / Agent repository MCP",
        "description": "Use koinote-agent with a separate agent_read or agent_write PAT in KOINOTE_AGENT_TOKEN. The same /mcp endpoint selects repository tools from the credential. manage_agent_workspace can permanently delete a repository. Updates and restores can remove files."
      },
      "configSync": {
        "title": "Configuration sync MCP",
        "description": "Use koinote-config-sync with a temporary credential from the configuration snapshot’s Copy for AI action. Document and repository PATs cannot access it. The credential is read-only, expires after 30 minutes, and is bound to one snapshot revision. Free accounts can authorize their one configuration snapshot too. Agents download ciphertext and decrypt locally with the user-provided key. Share credentials and keys only with a trusted agent. Revocation stops future reads. Downloaded content cannot be recalled. Envelopes over 8 MiB use the tool-provided whole-envelope download, up to 64 MiB."
      }
    },
    "toolsTitle": "Tool catalog",
    "toolsIntro": "This catalog lists all registered tools. Your credential and scope determine which tools the connection exposes.",
    "kinds": {
      "read": "Read-only",
      "write": "Write",
      "external": "External effects"
    },
    "scopeLabel": "Required scope / credential",
    "effectsTitle": "External operations and credits",
    "effects": [
      "generate_wechat_geo_summary calls a platform model and saves a summary, consuming credits. update_wechat_geo_summary edits saved text or its switch without calling a model or consuming credits. Both accept write and publish.",
      "sync_document_to_feishu requires write and a linked Feishu account. It replaces the linked Feishu document with Koinote content in a one-way sync.",
      "push_wechat_draft requires publish and a linked WeChat account. It creates an external draft and may upload images. Delivery and an optional AI cover consume credits under the existing rules, subject to any operator-managed grant. Ordinary document operations use the client’s model."
    ],
    "boundariesTitle": "Capabilities and safety boundaries",
    "boundaries": [
      "MCP uses Bearer credentials and has no OAuth MCP authorization flow. Web clients that require OAuth and cannot set a Bearer header cannot connect directly.",
      "Search matches case-insensitive substrings in document titles and bodies. RAG and semantic search are unavailable.",
      "Document PATs have no folder-level authorization scope. folderId filters results. Documents are private by default, and tools access data authorized for the current account.",
      "Backlinks, knowledge graphs, and tags are unavailable.",
      "Appending, replacing, patching, updating metadata, restoring versions, trashing, and untrashing documents require expectedRevision. Read the latest version after a conflict to prevent silent overwrites. Creation, folder operations, moves, and GEO summaries follow their own validation rules.",
      "Document MCP can move documents to the 30-day trash and cannot permanently delete them. Separately confirm the permanent repository deletion supported by manage_agent_workspace.",
      "Document and repository MCP activity logs are retained for 180 days. They record tools, results, duration, and related identifiers, excluding bodies and raw tokens. Configuration sync does not provide the same activity log."
    ],
    "limitsSummary": "MCP has no OAuth flow. Web connections requiring OAuth without Bearer headers cannot connect directly. Search uses title/body substrings. RAG, semantic search, folder-scoped document tokens, backlinks, graphs, and tags are unavailable. Documents are private by default. Document content updates and related operations check revisions. Document and repository MCP activity logs retain metadata for 180 days without bodies. Configuration sync has no equivalent log.",
    "clientTitle": "Client setup guide",
    "back": "Back to MCP overview",
    "official": "Official client documentation",
    "environmentTitle": "Set the environment variable",
    "environmentHelp": "Set your actual token in the terminal that starts the client. knt_mcp_... is a placeholder. Protect credentials with environment variables or secure storage and keep them out of repositories. Start with a read-only token.",
    "clientDescriptions": {
      "codex": "Add this configuration to ~/.codex/config.toml and start Codex from the same terminal so it inherits KOINOTE_MCP_TOKEN.",
      "claude-code": "Add the HTTP MCP entry to your project’s .mcp.json, then start Claude Code from the terminal with the environment variable. The file stores only the variable reference.",
      "opencode": "Check your OpenCode major version and choose its configuration block. V2 stores servers under mcp.servers and V1 under mcp. Both disable OAuth and use an environment-based header.",
      "openclaw": "Save the Streamable HTTP connection with the CLI. Single quotes preserve the environment reference in the header. --no-probe saves the configuration before a read-only connection probe."
    },
    "clientNotes": {
      "codex": "Use a Codex CLI version that supports remote HTTP MCP and bearer_token_env_var. Restart the client after changing the configuration.",
      "claude-code": "Claude Code CLI expands environment variables in .mcp.json headers. Follow its trust prompt when first using a project configuration.",
      "opencode": "Choose one of the V1 or V2 blocks. If other servers are configured, merge the koinote entry into the appropriate object and preserve your existing configuration.",
      "openclaw": "The repository previously verified OpenClaw 2026.6.10. Current official instructions require the Gateway to be stopped for doctor --probe. While it runs, save with --no-probe first. Check the command help for your installed version."
    },
    "verifyTitle": "Read-only verification and troubleshooting",
    "verify": "Inspect the tool list, then call list_documents with a read token. For a 401, check the client process’s environment variable, credential type, expiry, and revocation status. Document and repository access also require active lifetime membership. Check the scope if write tools are missing.",
    "repositorySetup": "For repositories, use the connection name koinote-agent, the KOINOTE_AGENT_TOKEN environment variable, and a repository PAT. Copy separate configuration-sync instructions from the snapshot.",
    "genericTitle": "WorkBuddy / Other clients",
    "genericHelp": "The client needs remote Streamable HTTP and an Authorization header. Store the Bearer credential in the client’s environment variables or secure storage and connect to https://koinote.app/mcp.",
    "copy": "Copy configuration",
    "copied": "Copied",
    "copyFailed": "Copy is unavailable. Select the code and copy it manually."
  },
  "fr": {
    "title": "Centre de connaissances MCP",
    "positioning": "Koinote est une bibliothèque personnelle de connaissances et de documents pour l’IA. Rédigez et organisez en Markdown, puis utilisez des agents compatibles MCP pour rechercher, lire et modifier vos documents en toute sécurité.",
    "membership": "L’offre gratuite comprend l’édition, la synchronisation, l’hébergement d’images, l’export et le partage. Le MCP des documents, celui des dépôts et l’assistant IA intégré nécessitent un abonnement à vie. La synchronisation des configurations utilise une autorisation temporaire distincte.",
    "connectionsTitle": "Choisir la connexion et les identifiants",
    "connections": {
      "documents": {
        "title": "MCP des documents",
        "description": "Utilisez le nom koinote et un PAT de documents. Le scope read permet la lecture, write l’édition, et publish la lecture, la gestion des résumés GEO et l’envoi de brouillons WeChat. L’envoi WeChat exige publish. Les jetons peuvent expirer et être révoqués individuellement."
      },
      "repositories": {
        "title": "MCP des dépôts Skills / Agent",
        "description": "Utilisez koinote-agent avec un PAT distinct agent_read ou agent_write dans KOINOTE_AGENT_TOKEN. Le même endpoint /mcp sélectionne les outils du dépôt selon le jeton. manage_agent_workspace peut supprimer définitivement un dépôt. Les mises à jour et restaurations peuvent retirer des fichiers."
      },
      "configSync": {
        "title": "MCP de synchronisation des configurations",
        "description": "Utilisez koinote-config-sync avec un jeton temporaire obtenu via Copier pour l’IA sur l’instantané de configuration. Les PAT de documents et de dépôts n’y donnent pas accès. Le jeton est en lecture seule, valable 30 minutes et lié à une révision d’un seul instantané. Les comptes gratuits peuvent aussi autoriser leur unique instantané. L’agent télécharge le contenu chiffré et le déchiffre localement avec la clé fournie par l’utilisateur. Confiez jeton et clé uniquement à un agent de confiance. La révocation arrête les lectures futures, sans rappeler le contenu déjà téléchargé. Au-delà de 8 MiB, utilisez le téléchargement complet fourni par l’outil, jusqu’à 64 MiB."
      }
    },
    "toolsTitle": "Catalogue des outils",
    "toolsIntro": "Ce catalogue présente tous les outils enregistrés. Le type de jeton et son scope déterminent les outils disponibles dans la connexion.",
    "kinds": {
      "read": "Lecture seule",
      "write": "Écriture",
      "external": "Effets externes"
    },
    "scopeLabel": "Scope / identifiant requis",
    "effectsTitle": "Opérations externes et crédits",
    "effects": [
      "generate_wechat_geo_summary appelle un modèle de la plateforme et enregistre un résumé en consommant des crédits. update_wechat_geo_summary modifie le texte enregistré ou son activation sans appeler de modèle ni consommer de crédits. Les deux acceptent write et publish.",
      "sync_document_to_feishu exige write et un compte Feishu lié. La synchronisation unidirectionnelle remplace le document Feishu associé par le contenu Koinote.",
      "push_wechat_draft exige publish et un compte WeChat lié. Il crée un brouillon externe et peut téléverser des images. L’envoi et une éventuelle couverture IA consomment des crédits selon les règles existantes, sous réserve des autorisations d’exonération. Les opérations documentaires courantes utilisent le modèle du client."
    ],
    "boundariesTitle": "Capacités et limites de sécurité",
    "boundaries": [
      "MCP utilise des jetons Bearer et ne propose aucun flux OAuth MCP. Les clients web exigeant OAuth sans possibilité de définir un en-tête Bearer ne peuvent pas se connecter directement.",
      "La recherche repère des sous-chaînes sans distinction de casse dans les titres et le contenu. RAG et recherche sémantique sont indisponibles.",
      "Les PAT de documents ne limitent pas les autorisations à un dossier. folderId filtre les résultats. Les documents sont privés par défaut et les outils accèdent aux données autorisées pour le compte courant.",
      "Les liens retour, graphes de connaissances et tags sont indisponibles.",
      "L’ajout de texte, le remplacement, les correctifs, la modification des métadonnées, la restauration de versions, la mise à la corbeille et la récupération exigent expectedRevision. En cas de conflit, relisez la dernière version pour éviter un écrasement silencieux. Création, dossiers, déplacements et résumés GEO ont leurs propres validations.",
      "Le MCP des documents peut placer un document dans la corbeille pendant 30 jours, sans suppression définitive. Confirmez séparément la suppression définitive d’un dépôt par manage_agent_workspace.",
      "Les journaux MCP des documents et dépôts sont conservés 180 jours. Ils enregistrent outils, résultats, durées et identifiants associés, sans contenu intégral ni jetons bruts. La synchronisation des configurations ne fournit pas le même journal."
    ],
    "limitsSummary": "MCP ne propose aucun flux OAuth. Les connexions web exigeant OAuth sans en-tête Bearer ne fonctionnent pas directement. La recherche utilise des sous-chaînes du titre et du contenu. RAG, recherche sémantique, jetons documentaires limités à un dossier, liens retour, graphes et tags sont indisponibles. Les documents sont privés par défaut. Les modifications du contenu et opérations associées vérifient les révisions. Les journaux MCP des documents et dépôts conservent les métadonnées 180 jours sans le contenu. Les configurations n’ont pas de journal équivalent.",
    "clientTitle": "Guide de connexion du client",
    "back": "Retour au centre MCP",
    "official": "Documentation officielle du client",
    "environmentTitle": "Définir la variable d’environnement",
    "environmentHelp": "Définissez le jeton réel dans le terminal qui lance le client. knt_mcp_... est une valeur d’exemple. Protégez vos identifiants avec des variables d’environnement ou un stockage sécurisé et gardez-les hors des dépôts. Commencez avec un jeton en lecture seule.",
    "clientDescriptions": {
      "codex": "Ajoutez cette configuration à ~/.codex/config.toml, puis démarrez Codex depuis le même terminal pour transmettre KOINOTE_MCP_TOKEN.",
      "claude-code": "Ajoutez la connexion HTTP MCP au fichier .mcp.json du projet et lancez Claude Code depuis le terminal où la variable est définie. Le fichier conserve uniquement la référence à la variable.",
      "opencode": "Vérifiez la version majeure d’OpenCode et choisissez le bloc correspondant. V2 place les serveurs dans mcp.servers, V1 dans mcp. Les deux désactivent OAuth et utilisent un en-tête issu de l’environnement.",
      "openclaw": "Enregistrez la connexion Streamable HTTP avec la CLI. Les apostrophes préservent la référence à la variable dans l’en-tête. --no-probe enregistre la configuration avant la vérification de connexion en lecture seule."
    },
    "clientNotes": {
      "codex": "Utilisez une version de Codex CLI prenant en charge le MCP HTTP distant et bearer_token_env_var. Redémarrez le client après modification.",
      "claude-code": "Claude Code CLI développe les variables d’environnement des en-têtes de .mcp.json. Suivez la demande de confiance lors de la première utilisation de la configuration du projet.",
      "opencode": "Choisissez un seul bloc V1 ou V2. Si d’autres serveurs existent, ajoutez koinote dans l’objet approprié en conservant la configuration existante.",
      "openclaw": "Le dépôt a précédemment vérifié OpenClaw 2026.6.10. La documentation actuelle exige l’arrêt de la Gateway pour doctor --probe. Pendant son exécution, enregistrez d’abord avec --no-probe. Consultez l’aide de la version installée."
    },
    "verifyTitle": "Vérification en lecture seule et dépannage",
    "verify": "Consultez la liste des outils, puis appelez list_documents avec un jeton read. En cas de 401, vérifiez la variable d’environnement du processus client, le type de jeton, son expiration et sa révocation. Les documents et dépôts exigent aussi un abonnement à vie actif. Vérifiez le scope si les outils d’écriture manquent.",
    "repositorySetup": "Pour les dépôts, utilisez le nom koinote-agent, la variable KOINOTE_AGENT_TOKEN et un PAT de dépôt. Copiez les instructions distinctes de synchronisation des configurations depuis l’instantané.",
    "genericTitle": "WorkBuddy / Autres clients",
    "genericHelp": "Le client doit prendre en charge Streamable HTTP distant et un en-tête Authorization. Stockez le jeton Bearer dans les variables d’environnement ou le stockage sécurisé du client, puis connectez-vous à https://koinote.app/mcp.",
    "copy": "Copier la configuration",
    "copied": "Copié",
    "copyFailed": "La copie est indisponible. Sélectionnez le code et copiez-le manuellement."
  },
  "ja": {
    "title": "MCP ナレッジベース",
    "positioning": "Koinote は個人向けの AI ナレッジ・ドキュメントライブラリです。Markdown で執筆・整理し、MCP 対応エージェントで文書を安全に検索、閲覧、編集できます。",
    "membership": "無料プランには編集、同期、画像ホスティング、エクスポート、共有が含まれます。文書 MCP、リポジトリ MCP、内蔵 AI アシスタントには永久会員が必要です。設定同期には、独立した一時認可を使用します。",
    "connectionsTitle": "接続と認証情報を選ぶ",
    "connections": {
      "documents": {
        "title": "文書 MCP",
        "description": "接続名 koinote と文書用 PAT を使用します。read は閲覧、write は編集、publish は閲覧、GEO 要約の管理、WeChat 下書きへの送信に対応します。WeChat への送信には publish が必要です。トークンには有効期限を設定でき、個別に失効できます。"
      },
      "repositories": {
        "title": "Skills / Agent リポジトリ MCP",
        "description": "接続名 koinote-agent を使い、専用の agent_read または agent_write PAT を KOINOTE_AGENT_TOKEN に設定します。同じ /mcp エンドポイントが認証情報に応じてリポジトリ用ツールを提供します。manage_agent_workspace はリポジトリを完全削除できます。更新や復元でファイルが削除される場合もあります。"
      },
      "configSync": {
        "title": "設定同期 MCP",
        "description": "設定スナップショットの「AI 用にコピー」で取得した一時認証情報を koinote-config-sync に使用します。文書・リポジトリ用 PAT は使用できません。認証情報は読み取り専用で30分間有効、単一スナップショットのリビジョンに限定されます。無料アカウントも自身の1件のスナップショットを認可できます。エージェントは暗号文を取得し、ユーザーが渡した鍵でローカル復号します。認証情報と鍵は信頼できるエージェントだけに渡してください。失効後は新たな読み取りが停止しますが、取得済み内容は回収できません。8 MiB を超える場合はツールが返すダウンロード先から全体を取得します。上限は64 MiBです。"
      }
    },
    "toolsTitle": "ツール一覧",
    "toolsIntro": "登録済みの全ツールを掲載しています。実際に表示されるツールは認証情報の種類と scope によって決まります。",
    "kinds": {
      "read": "読み取り専用",
      "write": "書き込み",
      "external": "外部への操作"
    },
    "scopeLabel": "必要な scope / 認証情報",
    "effectsTitle": "外部操作と credits",
    "effects": [
      "generate_wechat_geo_summary はプラットフォームのモデルで要約を生成・保存し、credits を消費します。update_wechat_geo_summary は保存済みの要約や有効設定を編集し、モデル呼び出しや credits 消費はありません。どちらも write と publish で利用できます。",
      "sync_document_to_feishu には write と Feishu アカウントの連携が必要です。Koinote の内容で連携済み Feishu 文書を一方向に上書きします。",
      "push_wechat_draft には publish と WeChat アカウントの連携が必要です。外部に下書きを作成し、画像をアップロードする場合があります。送信と任意の AI カバーは既存ルールに従って credits を消費し、運営側の免除認可があれば適用されます。通常の文書操作にはクライアントのモデルを使用します。"
    ],
    "boundariesTitle": "機能と安全上の制約",
    "boundaries": [
      "MCP は Bearer 認証情報を使用し、OAuth MCP の認可フローは提供していません。OAuth が必須で Bearer ヘッダーを設定できない Web クライアントは直接接続できません。",
      "検索はタイトルと本文に対する大文字・小文字を区別しない部分文字列一致です。RAG と意味検索は未対応です。",
      "文書 PAT にはフォルダー単位の認可範囲がありません。folderId は結果の絞り込み用です。文書は初期状態で非公開であり、ツールは現在のアカウントで認可されたデータにアクセスします。",
      "双方向リンク、ナレッジグラフ、タグは未対応です。",
      "文書の追記、置換、パッチ、メタデータ更新、バージョン復元、ごみ箱への移動と復元には expectedRevision が必要です。競合時は最新バージョンを読み直し、古い内容での無言の上書きを防ぎます。新規作成、フォルダー操作、移動、GEO 要約にはそれぞれの検証ルールがあります。",
      "文書 MCP は30日間保持するごみ箱へ移動でき、文書の完全削除はできません。manage_agent_workspace によるリポジトリの完全削除は別途確認してください。",
      "文書・リポジトリ MCP の操作ログは180日間保持され、ツール、結果、所要時間、関連 ID を記録します。本文や生のトークンは記録しません。設定同期には同じ操作ログ機能はありません。"
    ],
    "limitsSummary": "MCP に OAuth フローはありません。OAuth が必須で Bearer ヘッダーを設定できない Web 接続は直接利用できません。検索はタイトル・本文の部分文字列一致です。RAG、意味検索、フォルダー単位の文書トークン、双方向リンク、グラフ、タグは未対応です。文書は初期状態で非公開です。文書本文の更新などではリビジョンを検証します。文書・リポジトリ MCP の操作ログは本文を含めず180日間保持します。設定同期には同等のログはありません。",
    "clientTitle": "クライアント接続ガイド",
    "back": "MCP 概要に戻る",
    "official": "クライアントの公式ドキュメント",
    "environmentTitle": "環境変数を設定する",
    "environmentHelp": "クライアントを起動するターミナルで実際のトークンを設定します。knt_mcp_... は仮の値です。認証情報は環境変数または安全なストレージで管理し、リポジトリに保存しないでください。最初は読み取り専用トークンで確認します。",
    "clientDescriptions": {
      "codex": "~/.codex/config.toml にこの設定を追加し、同じターミナルから Codex を起動して KOINOTE_MCP_TOKEN を渡します。",
      "claude-code": "プロジェクトの .mcp.json に HTTP MCP 設定を追加し、環境変数を設定したターミナルから Claude Code を起動します。ファイルには変数参照だけを保存します。",
      "opencode": "OpenCode のメジャーバージョンを確認して対応する設定を選びます。V2 は mcp.servers、V1 は mcp の直下にサーバーを定義します。どちらも OAuth を無効にし、環境変数をヘッダーに使用します。",
      "openclaw": "CLI で Streamable HTTP 接続を保存します。ヘッダーの単引用符で環境変数参照をそのまま保持し、--no-probe で設定を保存してから読み取り専用の接続確認を行います。"
    },
    "clientNotes": {
      "codex": "リモート HTTP MCP と bearer_token_env_var に対応した Codex CLI を使用します。設定変更後はクライアントを再起動してください。",
      "claude-code": "Claude Code CLI は .mcp.json の headers 内の環境変数を展開します。プロジェクト設定を初めて使う際は信頼確認の案内に従ってください。",
      "opencode": "V1 または V2 のどちらかを選択します。他のサーバーがある場合は既存設定を保ち、該当するオブジェクトに koinote を追加してください。",
      "openclaw": "このリポジトリには OpenClaw 2026.6.10 での過去の検証記録があります。現在の公式手順では doctor --probe の実行時に Gateway を停止する必要があります。稼働中は先に --no-probe で保存できます。使用バージョンのヘルプを確認してください。"
    },
    "verifyTitle": "読み取り専用の確認とトラブル対応",
    "verify": "ツール一覧を確認し、read トークンで list_documents を呼び出します。401 の場合はクライアントプロセスの環境変数、認証情報の種類、有効期限、失効状態を確認してください。文書とリポジトリには有効な永久会員資格も必要です。書き込みツールが見つからない場合は scope を確認します。",
    "repositorySetup": "リポジトリでは接続名 koinote-agent、環境変数 KOINOTE_AGENT_TOKEN、リポジトリ用 PAT を使います。設定同期はスナップショットから専用の接続手順をコピーしてください。",
    "genericTitle": "WorkBuddy / その他のクライアント",
    "genericHelp": "リモート Streamable HTTP と Authorization ヘッダーに対応したクライアントが必要です。Bearer 認証情報を環境変数または安全なストレージに保存し、https://koinote.app/mcp に接続します。",
    "copy": "設定をコピー",
    "copied": "コピーしました",
    "copyFailed": "コピーできません。コードを選択して手動でコピーしてください。"
  }
};
