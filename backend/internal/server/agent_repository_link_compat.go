package server

import (
	"encoding/base64"
	"fmt"
	"net/http"
	"strings"
)

const repositoryLinksHeader = "X-Koinote-Repository-Links"

// Older clients only render repository files and cannot interpret link entries.
// Give them an application-authored guide, never a fake Skill or upstream file.
// The guide exists only in HTTP responses; storage, Forks and task sources stay
// independent of this presentation fallback.
func (a *App) repositoryLinkGuide(repository *agentRepositoryPublication) *agentWorkspaceFileContentView {
	if repository.GitHubSource == nil || !repository.GitHubSource.LinkOnly {
		return nil
	}
	base := strings.TrimRight(a.cfg.AppURL, "/")
	if base == "" {
		base = "https://koinote.app"
	}
	content := []byte(fmt.Sprintf(`# GitHub 链接 · GitHub link

## 中文

此条目仅收录来源链接，没有托管仓库文件。若当前客户端未显示安装入口，请升级到 1.1.21 或更高版本，或在网页版预览并安装技能。

[在网页版安装到 Koi AI][install] · [下载新版客户端][download] · [查看 GitHub 原仓库][source]

安装需要登录终身会员账号。网页版安装的技能会保存在同一账号的云端技能库，客户端也可使用；已有技能无需重新安装。此条目不支持 Clone 或 Fork。

## English

This entry stores a source link, without mirrored repository files. If your client has no installation button, upgrade to 1.1.21 or later, or install on the web. Sign in with the same lifetime-member account to preview and confirm installation. Skills are saved to that account's cloud library and are also available in the client. Existing Skills do not need reinstalling. Clone and Fork are unavailable for link entries.

[Install to Koi AI on the web][install] · [Download the latest client][download] · [Original GitHub repository][source]

## Français

Cette entrée contient uniquement un lien vers GitHub. Si le bouton d’installation n’apparaît pas, passez à la version 1.1.21 ou ultérieure, ou installez les Skills sur le Web. Connectez-vous au même compte membre à vie pour vérifier l’aperçu et confirmer l’installation. Les Skills sont enregistrés dans sa bibliothèque cloud, également accessible depuis le client. Les Skills existants sont conservés. Clone et Fork ne sont pas disponibles pour les liens.

[Installer dans Koi AI sur le Web][install] · [Télécharger le client][download] · [Dépôt GitHub d’origine][source]

## 日本語

この項目は GitHub へのリンクのみを掲載しています。インストールボタンが表示されない場合は、1.1.21 以降に更新するか、Web 版をご利用ください。同じ永久会員アカウントでログインし、プレビューを確認してインストールします。スキルはそのアカウントのクラウドライブラリに保存され、クライアントからも利用できます。既存のスキルを再インストールする必要はありません。リンク項目は Clone・Fork に対応していません。

[Web 版で Koi AI にインストール][install] · [クライアントをダウンロード][download] · [元の GitHub リポジトリ][source]

[install]: %s/repositories/%d?installKoi=true
[download]: %s/download
[source]: %s
`, base, repository.WorkspaceID, base, repository.GitHubSource.RepositoryURL))
	return &agentWorkspaceFileContentView{FileID: 1, Path: "README.md", MimeType: "text/markdown", SizeBytes: int64(len(content)), SHA256: koiDigest(content), ContentBase64: base64.StdEncoding.EncodeToString(content)}
}

func (a *App) publicRepositoryForClient(r *http.Request, repository *agentRepositoryPublication) *agentRepositoryPublication {
	if r.Header.Get(repositoryLinksHeader) == "1" {
		return repository
	}
	guide := a.repositoryLinkGuide(repository)
	if guide == nil {
		return repository
	}
	view := *repository
	view.Files = []agentWorkspaceFileView{{FileID: guide.FileID, Path: guide.Path, MimeType: guide.MimeType, SizeBytes: guide.SizeBytes, SHA256: guide.SHA256}}
	return &view
}
