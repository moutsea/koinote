UPDATE agent_workspace_files
SET content = convert_to($koinote_readme_en$
# Koinote Skills / Agent repository

Welcome! This repository is a cloud home for your reusable Skills, system prompts, and Agent settings. You can use it from any device without moving configuration files manually.

## Get started with an AI Agent

Click **Copy for AI Agent** below this document, then paste the prompt into the AI Agent you use, such as Claude Code, Codex, or OpenCode. Review the Agent's plan and confirm before it reads or updates this repository.

The copied prompt is for the Agent and contains the repository address, API and MCP methods, and authentication instructions. This README is the human guide.

## Upload files manually

Click **Import folder** below this document and select the folder containing your Skills or Agent settings. Koinote uploads the folder as this repository's contents. A README.md in the selected folder replaces this guide; otherwise the current guide is kept.

A common layout is **skills/** for reusable Skills, **prompts/** for system prompts, and **settings/** for portable Agent configuration.

## Sync from another tool

You can ask your Agent or another tool to synchronize through Koinote's REST API or MCP. The copied prompt includes the repository ID, addresses, authentication, and available operations. Normal updates only need to send changed files.

## Safety and limits

- Remove or replace API keys, access tokens, passwords, cookies, private keys, OAuth secrets, and other credentials with **<REDACTED>** before uploading.
- Never save a Koinote token in this repository. Keep it in a secure secret or environment variable.
- Review files before allowing an Agent to use them. Do not approve scripts or dependency installation unless you understand and intend to run them.
- Each file can be up to 5 MiB; a repository can contain up to 200 files. There is no fixed total-size limit.

README.md is a normal repository file and can be replaced with your own instructions when importing or synchronizing.
$koinote_readme_en$, 'UTF8'),
    mime_type = 'text/markdown',
    size_bytes = 1972,
    sha256 = '8a1139e8d3b96bf45312f2ef42c4be8a9a425c964129178a19b26898a051d9b5'
WHERE path = 'README.md'
  AND convert_from(content, 'UTF8') LIKE '# Koinote Skills / Agent repository%'
  AND convert_from(content, 'UTF8') LIKE '%This repository stores portable Skills%';

UPDATE agent_workspace_files
SET content = convert_to($koinote_readme_zh$
# Koinote Skills / Agent 仓库

欢迎使用！这个仓库是你的 Skills、系统提示词和 Agent 设置的云端空间。更换设备后，无需手动搬运配置文件即可继续使用。

## 使用 AI Agent 开始

点击本文档下方的「复制给 AI Agent」，然后粘贴给你使用的 AI Agent，例如 Claude Code、Codex 或 OpenCode。让 Agent 读取或更新仓库前，请先检查它的计划并确认操作。

复制的提示词是给 Agent 使用的，其中包含仓库地址、API 和 MCP 的使用方式以及鉴权说明。这份 README 是给用户看的操作指南。

## 手动上传文件

点击本文档下方的「导入文件夹」，选择包含 Skills 或 Agent 设置的文件夹。Koinote 会将文件夹内容上传为本仓库的文件。如果所选文件夹包含 README.md，它会替换当前指南；否则会保留当前指南。

常见结构是：**skills/** 存放可复用的 Skill，**prompts/** 存放系统提示词，**settings/** 存放可迁移的 Agent 配置。

## 通过其他工具同步

你可以让 Agent 或其他工具通过 Koinote 的 REST API 或 MCP 同步。复制的提示词会包含仓库 ID、地址、鉴权方式和可用操作。日常更新只需要发送发生变化的文件。

## 安全和限制

- 上传前删除或替换 API Key、访问 Token、密码、Cookie、私钥、OAuth Secret 和其他凭证，使用 **<REDACTED>** 占位符。
- 不要把 Koinote Token 保存到仓库中，应放在安全的 Secret 或环境变量里。
- 允许 Agent 使用文件前请先检查内容。除非明确理解并确实需要，否则不要批准执行脚本或安装依赖。
- 单个文件最多 5 MiB，每个仓库最多 200 个文件，总大小没有固定上限。

README.md 是普通仓库文件，你可以在导入或同步时替换为自己的说明。
$koinote_readme_zh$, 'UTF8'),
    mime_type = 'text/markdown',
    size_bytes = 1853,
    sha256 = '98ff175ed06f96531a67e84e1b974466ec5d85f57bc146234858370496f7ebe4'
WHERE path = 'README.md'
  AND convert_from(content, 'UTF8') LIKE '# Koinote Skills / Agent 仓库%'
  AND convert_from(content, 'UTF8') LIKE '%这个仓库用于保存可迁移的 Skills%';

UPDATE agent_workspace_files
SET content = convert_to($koinote_readme_fr$
# Dépôt Koinote Skills / Agent

Bienvenue ! Ce dépôt est l’espace cloud de vos Skills, prompts système et réglages Agent. Vous pouvez les retrouver sur un autre appareil sans déplacer manuellement vos fichiers.

## Commencer avec un Agent IA

Cliquez sur « Copier pour l’Agent IA » sous ce document, puis collez le prompt dans l’Agent IA que vous utilisez, par exemple Claude Code, Codex ou OpenCode. Vérifiez son plan et confirmez avant de l’autoriser à lire ou modifier ce dépôt.

Le prompt copié est destiné à l’Agent : il contient l’adresse du dépôt, les méthodes REST et MCP et les instructions d’authentification. Ce README est le guide de l’utilisateur.

## Importer vos fichiers

Cliquez sur « Importer un dossier » sous ce document et sélectionnez le dossier contenant vos Skills ou réglages Agent. Koinote enverra son contenu comme fichiers du dépôt. Un README.md présent dans le dossier remplace ce guide ; sinon le guide actuel est conservé.

Organisation conseillée : **skills/** pour les Skills, **prompts/** pour les prompts système et **settings/** pour les réglages Agent portables.

## Synchroniser avec un autre outil

Vous pouvez demander à votre Agent ou à un autre outil de synchroniser ce dépôt via l’API REST ou MCP de Koinote. Le prompt copié indique l’ID du dépôt, les adresses, l’authentification et les opérations disponibles. Les mises à jour normales n’envoient que les fichiers modifiés.

## Sécurité et limites

- Supprimez ou remplacez les clés API, tokens, mots de passe, cookies, clés privées, secrets OAuth et autres identifiants par **<REDACTED>** avant l’envoi.
- Ne stockez jamais de token Koinote dans ce dépôt. Gardez-le dans un secret sécurisé ou une variable d’environnement.
- Vérifiez les fichiers avant leur utilisation par un Agent. N’approuvez pas les scripts ou l’installation de dépendances sans les comprendre.
- Chaque fichier peut atteindre 5 MiB et un dépôt peut contenir 200 fichiers. Il n’y a pas de limite fixe de taille totale.

README.md est un fichier normal du dépôt et peut être remplacé par vos propres instructions lors d’un import ou d’une synchronisation.
$koinote_readme_fr$, 'UTF8'),
    mime_type = 'text/markdown',
    size_bytes = 2217,
    sha256 = 'efd1b9dc6b13157bcbbbe266c1b7a731df32bc8421941d2814e89d0b0ec5ee33'
WHERE path = 'README.md'
  AND convert_from(content, 'UTF8') LIKE '# Dépôt Koinote Skills / Agent%'
  AND convert_from(content, 'UTF8') LIKE '%Ce dépôt conserve des Skills%';

UPDATE agent_workspace_files
SET content = convert_to($koinote_readme_ja$
# Koinote Skills / Agent リポジトリ

ようこそ。このリポジトリは、再利用可能な Skills、システムプロンプト、Agent 設定を保存するクラウド上の場所です。端末を変更しても、設定ファイルを手動で移動せずに利用できます。

## AI Agent で始める

このドキュメントの下にある「AI Agent 用にコピー」をクリックし、Claude Code、Codex、OpenCode など使用する AI Agent に貼り付けます。Agent に読み取りや更新を許可する前に、計画を確認してください。

コピーされるプロンプトは Agent 用で、リポジトリのアドレス、REST API と MCP の方法、認証手順が含まれます。この README はユーザー向けのガイドです。

## ファイルを手動でアップロードする

このドキュメントの下にある「フォルダーを取り込む」をクリックし、Skills や Agent 設定を含むフォルダーを選択します。Koinote はフォルダーの内容をリポジトリのファイルとしてアップロードします。選択したフォルダーに README.md があればこのガイドを置き換え、なければ現在のガイドを保持します。

推奨構成：**skills/** は Skills、**prompts/** はシステムプロンプト、**settings/** は移植可能な Agent 設定に使用します。

## 他のツールから同期する

Koinote の REST API または MCP を使って同期するよう Agent や他のツールに依頼できます。コピーされるプロンプトには、リポジトリ ID、アドレス、認証方法、利用可能な操作が含まれます。通常の更新では変更されたファイルだけが同期されます。

## セキュリティと制限

- アップロード前に API キー、アクセス Token、パスワード、Cookie、秘密鍵、OAuth Secret などを削除または **<REDACTED>** に置き換えてください。
- Koinote Token をリポジトリに保存せず、安全な Secret または環境変数に保管してください。
- Agent にファイルを使わせる前に内容を確認してください。理解していないスクリプトの実行や依存関係のインストールは承認しないでください。
- 1 ファイルは最大 5 MiB、1 リポジトリは最大 200 ファイルです。合計サイズの固定上限はありません。

README.md は通常のリポジトリファイルで、取り込みや同期の際に独自の案内へ置き換えられます。
$koinote_readme_ja$, 'UTF8'),
    mime_type = 'text/markdown',
    size_bytes = 2585,
    sha256 = 'da4e094c2ed884c88b5d151fe3bbdffa3deb3cfdbaa2e41c01cedf7997a06f5f'
WHERE path = 'README.md'
  AND convert_from(content, 'UTF8') LIKE '# Koinote Skills / Agent リポジトリ%'
  AND convert_from(content, 'UTF8') LIKE '%このリポジトリには、移植可能な Skills%';
