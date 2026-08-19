package model

import "time"

// Document 是对外暴露的文档模型，JSON 字段与前端 spa/src/api.ts 的 Document 类型对齐。
// 内部自增 id 与 user_id 不外泄，对外只用 DocID 标识。
type Document struct {
	DocID string `json:"docId"`
	Title string `json:"title"`
	// Theme 是微信排版主题 id，空串表示不套主题。取值由 server 侧白名单约束。
	Theme     string     `json:"theme"`
	Content   string     `json:"content"`
	Revision  int64      `json:"revision"`
	CreatedAt *time.Time `json:"createdAt"`
	UpdatedAt *time.Time `json:"updatedAt"`
	// Share 为空表示未分享。仅在文档主人自己读取时下发。
	Share *DocumentShare `json:"share"`
}

// Folder 是侧栏的目录节点。没有正文、不能分享、没有排版主题——
// 它只负责归类，见 migrations/0006_folders.sql 的说明。
type Folder struct {
	FolderID string `json:"folderId"`
	Name     string `json:"name"`
	// nil 表示在根下
	ParentFolderID *string `json:"parentFolderId"`
	// nil 表示用户手动创建或导入；非 nil 表示由文档整理器创建。
	OrganizerKind *string `json:"organizerKind"`
}

// DocumentShare 是分享状态。不含 password_hash——那东西永不出后端。
type DocumentShare struct {
	Token            string `json:"token"`
	Access           string `json:"access"`
	RequiresPassword bool   `json:"requiresPassword"`
	ViewCount        int64  `json:"viewCount"`
}

// DocumentSummary 用于列表接口：不含 content，侧边栏渲染够用且省流量。
type DocumentSummary struct {
	DocID string `json:"docId"`
	Title string `json:"title"`
	// nil 表示在根下
	FolderID  *string    `json:"folderId"`
	Revision  int64      `json:"revision"`
	CreatedAt *time.Time `json:"createdAt"`
	UpdatedAt *time.Time `json:"updatedAt"`
}

type TrashedDocumentSummary struct {
	DocID     string     `json:"docId"`
	Title     string     `json:"title"`
	Revision  int64      `json:"revision"`
	TrashedAt *time.Time `json:"trashedAt"`
	DeletesAt *time.Time `json:"deletesAt"`
}

type DocumentVersion struct {
	Revision       int64      `json:"revision"`
	Title          string     `json:"title"`
	Theme          string     `json:"theme"`
	Content        string     `json:"content,omitempty"`
	Source         string     `json:"source"`
	SafetySnapshot bool       `json:"safetySnapshot"`
	CreatedAt      *time.Time `json:"createdAt"`
}

// User 是对外暴露的用户模型，JSON 字段与前端 spa/src/api.ts 的 User 类型对齐。
type User struct {
	ID          int     `json:"id"`
	AuthUserID  string  `json:"authUserId"`
	Email       string  `json:"email"`
	Username    *string `json:"username"`
	Nickname    *string `json:"nickname"`
	AvatarURL   *string `json:"avatarUrl"`
	IsVerified  bool    `json:"isVerified"`
	IsAdmin     bool    `json:"isAdmin"`
	HasPassword bool    `json:"hasPassword"`
	// SessionVersion 只参与服务端会话校验，不下发给浏览器。
	SessionVersion int64 `json:"-"`
	// MembershipTier 是站内权益真值。支付完成后写为 lifetime，终生有效。
	MembershipTier      string     `json:"membershipTier"`
	MembershipGrantedAt *time.Time `json:"membershipGrantedAt"`
	// BonusStorageBytes 来自邀请奖励，在免费或会员基础配额之上永久叠加。
	BonusStorageBytes int64      `json:"bonusStorageBytes"`
	StripeCustomerID  *string    `json:"-"`
	CreatedAt         *time.Time `json:"createdAt"`
	UpdatedAt         *time.Time `json:"updatedAt"`
}
