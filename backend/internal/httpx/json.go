package httpx

import (
	"encoding/json"
	"net/http"
)

// JSON 写出 JSON 响应。
func JSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

// Error 写出统一的错误 JSON：{"error": "..."}。
func Error(w http.ResponseWriter, status int, message string) {
	JSON(w, status, map[string]string{"error": message})
}

// ErrorCode 写出带稳定错误码的错误 JSON：{"error": "<英文兜底>", "code": "<code>"}。
// 前端用 code 查 i18n 表做本地化，message 作为兜底（前端未覆盖该 code 时直接显示）。
func ErrorCode(w http.ResponseWriter, status int, code, message string) {
	JSON(w, status, map[string]string{"error": message, "code": code})
}
