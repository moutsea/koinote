# ---- builder ----
FROM golang:1.25-alpine AS builder
WORKDIR /src

ARG GOPROXY=https://goproxy.cn,direct
ENV GOPROXY=${GOPROXY} CGO_ENABLED=0 GOOS=linux

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN go build -ldflags="-s -w" -o /out/koinote-backend ./cmd/server

# ---- runtime ----
FROM alpine:3.21
WORKDIR /app

RUN apk add --no-cache ca-certificates curl && adduser -D -u 10001 koinote

COPY --from=builder /out/koinote-backend /app/koinote-backend
COPY --from=builder /src/migrations /app/migrations

USER koinote
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
  CMD curl -f http://localhost:8080/health || exit 1

CMD ["/app/koinote-backend"]
