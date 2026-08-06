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
	CreatedAt *time.Time `json:"createdAt"`
	UpdatedAt *time.Time `json:"updatedAt"`
	// Share 为空表示未分享。仅在文档主人自己读取时下发。
	Share *DocumentShare `json:"share"`
}

// DocumentShare 是分享状态。不含 password_hash——那东西永不出后端。
type DocumentShare struct {
	Token            string `json:"token"`
	Access           string `json:"access"`
	RequiresPassword bool   `json:"requiresPassword"`
}

// DocumentSummary 用于列表接口：不含 content，侧边栏渲染够用且省流量。
type DocumentSummary struct {
	DocID     string     `json:"docId"`
	Title     string     `json:"title"`
	UpdatedAt *time.Time `json:"updatedAt"`
}

// User 是对外暴露的用户模型，JSON 字段与前端 spa/src/api.ts 的 User 类型对齐。
type User struct {
	ID         int        `json:"id"`
	AuthUserID string     `json:"authUserId"`
	Email      string     `json:"email"`
	Username   *string    `json:"username"`
	Nickname   *string    `json:"nickname"`
	AvatarURL  *string    `json:"avatarUrl"`
	IsVerified bool       `json:"isVerified"`
	IsAdmin    bool       `json:"isAdmin"`
	CreatedAt  *time.Time `json:"createdAt"`
	UpdatedAt  *time.Time `json:"updatedAt"`
}
