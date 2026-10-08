CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $migration$
DECLARE
    selected RECORD;
    next_content BYTEA;
BEGIN
    FOR selected IN
        SELECT workspace.id AS workspace_id, files.id AS file_id,
               replace(templates.content, '%s',
                   COALESCE(regexp_replace(substring(convert_from(files.content, 'UTF8') FROM '(https?://[^<>()[:space:]（）]+)/mcp'), '/mcp$', ''), '')
               ) AS content
        FROM agent_workspace_files AS files
        JOIN agent_workspaces AS workspace ON workspace.id = files.workspace_id
        CROSS JOIN (VALUES
            (ARRAY['d444a71033086a9418eb2ef63131c3e8c80b34cf40192c3f92d0abd919472cfb', '8a1139e8d3b96bf45312f2ef42c4be8a9a425c964129178a19b26898a051d9b5']::text[], $readme_en$# Koinote Skills / Agent repository

## Recommended: one-click upload from the desktop app

If you are using the Koinote desktop app, this is the preferred way to upload local Agent content:

1. Open this repository in the Koinote desktop app.
2. Click **One-click upload local Agent content** below this guide.
3. Review the file tree, preview files, and confirm the selection.

Koinote separates shareable Skills, prompts, and Agent files from private development configuration. Sensitive-looking files are unchecked by default so you can review them before deciding. Upload starts only after you confirm.

Welcome! This repository is a cloud home for your reusable Skills, system prompts, and Agent settings. You can use it from any device without moving configuration files manually.

## Alternative: connect an Agent through MCP

If you want an AI Agent such as Claude Code, Codex, or OpenCode to synchronize this repository directly, click **Copy for AI Agent** below this guide and paste the prompt into your trusted Agent. Use this option when your Agent can connect to Koinote's MCP endpoint. The prompt contains repository-specific connection and authentication instructions.

MCP endpoint: %s/mcp

## Import a folder manually

Click **Import folder** below this guide when you want to choose a folder yourself. A folder import replaces the hosted files in one operation. A README.md in the selected folder replaces this guide; otherwise the current guide is kept.

Suggested folders:

- **skills/** for reusable Skills and their SKILL.md files.
- **prompts/** for system prompts and role instructions.
- **settings/** for portable Agent configuration.

## Before you upload

- Remove or replace API keys, access tokens, passwords, cookies, private keys, OAuth secrets, and other credentials with **<REDACTED>**.
- Do not save a Koinote token in this repository. Keep it in your Agent's secure secret or environment variables.
- Review the files before allowing an Agent to use them. Do not approve scripts or dependency installation unless you understand and intend to run them.
- Each file can be up to 5 MiB; there is no fixed file-count limit. Uploads remain subject to request-size and storage-quota limits.

## Updating this guide

README.md is a normal repository file. You can replace it with your own instructions when importing a folder or synchronizing through an Agent. Keep the important connection and security notes available for the next person or device using this repository.
$readme_en$),
            (ARRAY['293118f7fec05d328ce4152028f0ae8e39a324e94268824446f7496122e48a37', '98ff175ed06f96531a67e84e1b974466ec5d85f57bc146234858370496f7ebe4', '630fc89e69cb6eca93cbb52e02c9f8023070c4b30f76ba9e7036a7395ddab7c9']::text[], $readme_zh$# Koinote Skills / Agent 仓库

## 首选方式：通过客户端一键上传

如果你正在使用 Koinote 客户端，这是上传本机 Agent 内容的首选方式：

1. 在 Koinote 客户端打开这个仓库。
2. 点击本文档下方的「一键上传本机 Agent 内容」。
3. 在文件树中查看文件、预览内容并确认选择。

Koinote 会把可分享的 Skills、提示词和 Agent 文件与私人的开发配置区分开。疑似包含敏感信息的文件默认不勾选，你可以查看后自行决定。只有确认后才会开始上传。

欢迎使用！这个仓库是你的 Skills、系统提示词和 Agent 设置的云端空间。更换设备后，无需手动搬运配置文件即可继续使用。

## 备选方式：通过 MCP 连接 Agent

如果你希望 Agent 直接同步这个仓库，点击本文档下方的「复制给 AI Agent」，将提示词粘贴给你信任的 Agent。当 Agent 支持连接 Koinote 的 MCP 服务时，可以使用这种方式。提示词包含当前仓库专用的连接和鉴权说明。

MCP 地址：%s/mcp

## 手动导入文件夹

如果你想自行选择目录，可以点击本文档下方的「导入文件夹」。导入文件夹会一次性替换仓库文件；如果所选文件夹包含 README.md，它会替换当前指南，否则会保留当前指南。

推荐的文件夹结构：

- **skills/**：可复用的 Skill 及其 SKILL.md 文件。
- **prompts/**：系统提示词和角色指令。
- **settings/**：可迁移的 Agent 配置。

## 上传前请注意

- 删除或替换 API Key、访问 Token、密码、Cookie、私钥、OAuth Secret 和其他凭证，使用 **<REDACTED>** 占位符。
- 不要把 Koinote Token 保存到仓库中，应放在 Agent 的安全 Secret 或环境变量里。
- 允许 Agent 使用文件前请先检查内容。除非明确理解并确实需要，否则不要批准执行脚本或安装依赖。
- 单个文件最多 5 MiB，仓库文件数量不设固定上限，但上传仍受请求大小和存储配额限制。

## 自定义这份指南

README.md 是普通仓库文件。你可以在导入文件夹或让 Agent 同步时替换它。建议为下一台设备或下一位使用这个仓库的人保留必要的连接和安全说明。
$readme_zh$),
            (ARRAY['bfab905c107bd09fdba8350c11d584d8e3d2e368ab2936ea488ca31693934d62', 'efd1b9dc6b13157bcbbbe266c1b7a731df32bc8421941d2814e89d0b0ec5ee33']::text[], $readme_fr$# Dépôt Koinote Skills / Agent

## Méthode recommandée : import en un clic depuis l’application de bureau

Si vous utilisez l’application de bureau Koinote, c’est la méthode recommandée pour envoyer le contenu Agent local :

1. Ouvrez ce dépôt dans l’application de bureau Koinote.
2. Cliquez sur « Importer le contenu Agent local en un clic » sous ce guide.
3. Vérifiez l’arborescence, prévisualisez les fichiers et confirmez la sélection.

Koinote sépare les Skills, prompts et fichiers Agent partageables de la configuration de développement privée. Les fichiers qui semblent contenir des données sensibles sont décochés par défaut afin que vous puissiez les vérifier. L’envoi ne commence qu’après votre confirmation.

Bienvenue ! Ce dépôt est l’espace cloud de vos Skills, prompts système et réglages Agent. Vous pouvez les retrouver sur un autre appareil sans déplacer manuellement vos fichiers.

## Alternative : connecter un Agent via MCP

Pour laisser un Agent synchroniser directement ce dépôt, cliquez sur « Copier pour l’Agent IA » sous ce guide et collez le prompt dans votre Agent de confiance. Utilisez cette option si votre Agent peut se connecter au point de terminaison MCP de Koinote. Le prompt contient les instructions de connexion et d’authentification propres à ce dépôt.

Point de terminaison MCP : %s/mcp

## Importer un dossier manuellement

Cliquez sur « Importer un dossier » sous ce guide pour choisir vous-même un dossier. L’import remplace les fichiers hébergés en une seule opération. Un README.md présent dans le dossier remplace ce guide ; sinon le guide actuel est conservé.

Organisation conseillée : **skills/** pour les Skills, **prompts/** pour les prompts système et **settings/** pour les réglages Agent portables.

## Avant l’envoi

- Supprimez ou remplacez les clés API, tokens, mots de passe, cookies, clés privées, secrets OAuth et autres identifiants par **<REDACTED>**.
- Ne stockez pas de token Koinote dans ce dépôt ; gardez-le dans un secret sécurisé ou une variable d’environnement de l’Agent.
- Vérifiez les fichiers avant leur utilisation par un Agent. N’approuvez pas les scripts ou l’installation de dépendances sans les comprendre.
- Chaque fichier peut atteindre 5 MiB ; le nombre de fichiers n’est pas plafonné, mais les envois restent soumis aux limites de taille des requêtes et du quota de stockage.

README.md est un fichier normal du dépôt et peut être remplacé par vos propres instructions lors d’un import ou d’une synchronisation.
$readme_fr$),
            (ARRAY['07f540a05521c6377230ba2f5b8c591c8924a0b01f9605e1bfdefeeee103e61b', 'da4e094c2ed884c88b5d151fe3bbdffa3deb3cfdbaa2e41c01cedf7997a06f5f']::text[], $readme_ja$# Koinote Skills / Agent リポジトリ

## おすすめ：デスクトップアプリからワンクリックでアップロード

Koinote デスクトップアプリを使用している場合、ローカル Agent の内容をアップロードするおすすめの方法です。

1. Koinote デスクトップアプリでこのリポジトリを開きます。
2. このガイドの下にある「ローカル Agent の内容をワンクリックでアップロード」をクリックします。
3. ファイルツリーを確認し、ファイルをプレビューしてから選択を確定します。

Koinote は共有できる Skills、プロンプト、Agent ファイルと、個人的な開発設定を分けます。機密情報を含む可能性のあるファイルは、確認できるよう初期状態では選択されません。確認後にのみアップロードが始まります。

ようこそ。このリポジトリは、再利用可能な Skills、システムプロンプト、Agent 設定を保存するクラウド上の場所です。端末を変更しても、設定ファイルを手動で移動せずに利用できます。

## 代替方法：MCP で Agent を接続

Agent にこのリポジトリを直接同期させる場合は、このガイドの下にある「AI Agent 用にコピー」をクリックし、信頼できる Agent に貼り付けます。Agent が Koinote の MCP エンドポイントに接続できる場合に使用してください。プロンプトにはこのリポジトリ専用の接続方法と認証手順が含まれます。

MCP エンドポイント：%s/mcp

## フォルダーを手動で取り込む

自分でフォルダーを選ぶ場合は、このガイドの下にある「フォルダーを取り込む」をクリックします。フォルダーの取り込みはホスト上のファイルを一括置換します。選択したフォルダーに README.md があればこのガイドを置き換え、なければ現在のガイドを保持します。

推奨構成：**skills/** は Skills、**prompts/** はシステムプロンプト、**settings/** は移植可能な Agent 設定に使用します。

## アップロード前の注意

- API キー、アクセス Token、パスワード、Cookie、秘密鍵、OAuth Secret などを削除または **<REDACTED>** に置き換えてください。
- Koinote Token をリポジトリに保存せず、Agent の安全な Secret または環境変数に保管してください。
- Agent にファイルを使わせる前に内容を確認してください。理解していないスクリプトの実行や依存関係のインストールは承認しないでください。
- 1 ファイルは最大 5 MiB で、ファイル数に固定上限はありません。ただし、アップロードはリクエストサイズとストレージ容量の制限を受けます。

README.md は通常のリポジトリファイルです。取り込みや同期の際に、独自の案内へ置き換えることができます。
$readme_ja$)
        ) AS templates(hashes, content)
        WHERE files.path = 'README.md'
          AND workspace.deleted_at IS NULL
          AND encode(digest(files.content, 'sha256'), 'hex') = ANY(templates.hashes)
        ORDER BY workspace.id
        FOR UPDATE OF workspace, files
    LOOP
        PERFORM record_agent_workspace_commit(selected.workspace_id, 'baseline');
        next_content := convert_to(selected.content, 'UTF8');
        UPDATE agent_workspace_files
        SET content = next_content,
            mime_type = 'text/markdown',
            size_bytes = octet_length(next_content),
            sha256 = encode(digest(next_content, 'sha256'), 'hex')
        WHERE id = selected.file_id;
        UPDATE agent_workspaces
        SET revision = revision + 1, updated_at = now()
        WHERE id = selected.workspace_id;
        PERFORM record_agent_workspace_commit(selected.workspace_id, 'readme-update');
    END LOOP;
END;
$migration$;
