# 自定义自媒体 API

自定义平台用于把 Koinote 文章同步到你自己的系统或其他支持 HTTP 接收的服务。每个平台配置一个公网 HTTPS 地址；用户在文章的“导出到自媒体”菜单中选择该平台后，Koinote 会发送一次 `POST` 请求。

## 接口要求

- 方法：`POST`
- 地址：公网 `HTTPS` URL。地址不能包含用户信息、查询参数或片段。
- 请求头：`Content-Type: application/json`、`Accept: application/json`
- 如果平台设置了 Bearer 令牌，Koinote 会额外发送 `Authorization: Bearer <token>`。
- 目标接口返回任意 `2xx` 状态码且响应体在大小上限内、能完整读取时，视为同步成功；其他状态码或响应体读取失败会提示同步失败。
- 成功响应体可以为空、非 JSON，或 JSON `{"url":"https://example.com/article/123"}`。`url` 可选；非 JSON 的成功响应没有文章链接。

## 请求示例

```http
POST /your-configured-path HTTP/1.1
Content-Type: application/json
Accept: application/json
Authorization: Bearer <your-token>
```

```json
{
  "version": 1,
  "event": "article.publish",
  "source": {
    "app": "koinote",
    "documentId": "document-uuid",
    "revision": 7,
    "platformName": "我的知识库"
  },
  "article": {
    "title": "文章标题",
    "markdown": "# 文章标题\n\n正文",
    "html": "<h1>文章标题</h1><p>正文</p>",
    "coverImageSource": "https://cdn.example.com/cover.png"
  }
}
```

`coverImageSource` 没有设置时为空字符串。`markdown` 是包含标题的完整 Markdown，`html` 是按文档主题生成的可发布 HTML。接口应按 `event` 和 `version` 处理协议版本，未识别的字段可以忽略。

## 限制与建议

- 平台名称最多 80 个字符，最多配置 20 个自定义平台。
- 文章标题最多 200 个字符；Markdown 最多 1 MiB，渲染后的 HTML 最多 3 MiB，封面地址最多 2048 字节。客户端请求体上限为这些字段字节上限总和的 6 倍加 64 KiB（约 24.08 MiB），容纳最坏情况下的 JSON 转义；字段限制仍单独校验。接收方也应容纳 JSON 转义后的请求大小。
- 返回体最大 1 MiB。同步服务建议在 45 秒内返回结果。
- 每个账号所有自定义平台共用每小时 10 次发布请求额度，限制用户可控目标的总出站流量。
- Bearer 令牌使用 `CUSTOM_MEDIA_CREDENTIAL_ENCRYPTION_KEY` 做 AES-GCM 加密保存；生产环境必须配置独立且持久的密钥。轮换密钥前需要迁移既有密文，否则旧令牌需要重新配置。
- 编辑时留空保留原令牌；勾选“移除已保存的令牌”后保存，会清除令牌，此后的同步不带 `Authorization` 请求头。
- 请在服务端校验 `Authorization`、`source.documentId` 和内容字段，不要把令牌写入日志。
- Koinote 不会重试失败请求；用户可以从文章导出菜单再次同步。

发布前客户端会先保存文档，`source.revision` 来自已保存的文档版本。接收方可结合文档 ID 和版本进行去重；若同一版本需要接受不同的渲染结果，也应比较文章内容。
