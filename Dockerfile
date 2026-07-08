# syntax=docker/dockerfile:1

# --- Client (React PWA) ---
FROM node:22-alpine AS client
ARG VITE_PWA_ID=https://coachman.eugen-bash.com/
ENV VITE_PWA_ID=$VITE_PWA_ID
WORKDIR /app
COPY package.json package-lock.json ./
COPY client/package.json client/
RUN npm ci -w client
COPY client/ client/
RUN npm run build -w client

# --- Server (Go API + WebSocket) ---
FROM golang:1.25-alpine AS server
WORKDIR /src/server
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /api ./cmd/api

# --- Runtime ---
FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata \
  && addgroup -S coachman \
  && adduser -S -G coachman coachman

WORKDIR /app/server
COPY --from=server /api ./bin/api
COPY --from=client /app/client/dist /app/client/dist

ENV PORT=3001

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" | grep -q '"ok"' || exit 1

USER coachman

# Runtime: один env-файл на весь контейнер (--env-file .env)
# DATABASE_URL, JWT_SECRET, CORS_ORIGIN, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, PWA_MANIFEST_ID
# Опционально: BOOTSTRAP_TOKEN, S3_*, REDIS_URL
CMD ["./bin/api"]
