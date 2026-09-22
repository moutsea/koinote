# Custom publishing API

Custom platforms send a Koinote article to your own system or another HTTP service. Configure one public HTTPS endpoint for each platform. When a user chooses it from an article's publishing menu, Koinote sends one `POST` request.

## Contract

- Method: `POST`
- URL: a public `HTTPS` URL. User info, query parameters, and fragments are rejected.
- Headers: `Content-Type: application/json` and `Accept: application/json`.
- When a Bearer token is configured, Koinote sends `Authorization: Bearer <token>`.
- A `2xx` response whose body can be read completely within the size limit is treated as success. Other status codes or body read failures are shown as a publishing error.
- A successful response body may be empty, non-JSON, or JSON such as `{"url":"https://example.com/article/123"}`. The `url` field is optional; non-JSON success responses have no published article link.

## Request example

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
    "platformName": "My knowledge base"
  },
  "article": {
    "title": "Article title",
    "markdown": "# Article title\n\nBody",
    "html": "<h1>Article title</h1><p>Body</p>",
    "coverImageSource": "https://cdn.example.com/cover.png"
  }
}
```

When no cover is configured, `coverImageSource` is an empty string. `markdown` contains the title and `html` is generated from the document theme. Handle the request by `event` and `version`; unknown fields may be ignored.

## Limits and recommendations

- Platform names are limited to 80 characters; each account can configure up to 20 custom platforms.
- Article titles are limited to 200 characters, Markdown to 1 MiB, rendered HTML to 3 MiB, and cover sources to 2048 bytes. The client request body limit is six times the combined field byte limits plus 64 KiB (about 24.08 MiB), allowing worst-case JSON escaping; field limits are checked separately. Receivers should also allow for JSON escaping.
- Response bodies are limited to 1 MiB. Return within 45 seconds.
- All custom platforms on an account share a quota of 10 publish requests per hour to bound total outbound traffic to user-configured destinations.
- Bearer tokens are encrypted with `CUSTOM_MEDIA_CREDENTIAL_ENCRYPTION_KEY`; production must configure a separate, persistent key. Migrate existing ciphertext before rotating it, otherwise tokens must be configured again.
- Leaving the token blank while editing keeps the existing token. Select “Remove the saved token” and save to clear it; subsequent requests omit `Authorization`.
- Validate `Authorization`, `source.documentId`, and article fields on your server; never log the token.
- Koinote does not retry failed requests. Users can publish again from the article menu.

The client saves the document before publishing, and `source.revision` identifies the saved document version. Receivers can deduplicate by document ID and revision; compare article content as well if different renderings of the same revision should be accepted.
