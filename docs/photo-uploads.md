# Photo uploads (direct browser → Yandex Object Storage)

Photos are uploaded and downloaded **directly between the browser and Yandex
Object Storage** using short-lived pre-signed URLs. The Go backend only handles
small JSON metadata; photo bytes never pass through nginx or Go.

## 1. Architecture

```
Browser (PWA)                    Go backend (behind nginx)         Yandex Object Storage
     |                                     |                                |
     | 1. compress (resize/re-encode)      |                                |
     | 2. POST /api/uploads/photos/init -->|  auth + chat access + type/size|
     |                                     |  generate object key           |
     |                                     |  presign PUT (Content-Type) --> |
     |<-- {uploadId, uploadUrl, objectKey} |                                |
     | 3. PUT bytes ------------------------------------------------------->| (direct, no nginx/Go)
     | 4. POST /api/uploads/photos/complete|  HeadObject: size + type check |
     |                                     |  create attachment + return id |
     |<-- {attachmentId, url, ...}         |                                |
     | 5. POST /api/chats/{id}/messages    |  message references attachment |
     |    (type=image, imageId=attachmentId)                               |
     |                                     |                                |
     | Download: GET /api/images/{id} ---> |  auth + chat access            |
     |                                     |  presign GET ----------------> |
     |<-- {url}                            |                                |
     | GET url ------------------------------------------------------------>| (direct, no nginx/Go)
```

Key server files:

- `server/internal/blob/s3.go` — minio-go S3 client: `PresignPutContentType`,
  `PresignGet`, `Stat` (HeadObject), `Bucket`.
- `server/internal/store/photo.go` — `InitPhotoUpload`, `CompletePhotoUpload`,
  `GetAttachmentURL`, `CleanupExpiredUploads` and the MIME whitelist.
- `server/internal/handler/handler.go` — `POST /api/uploads/photos/init`,
  `POST /api/uploads/photos/complete`, `GET /api/attachments/{attachmentId}/url`.
- `server/internal/db/migrations/*/021_photo_uploads.sql` — `uploads` table +
  extra `images` columns (`size_bytes`, `width`, `height`, `original_name`).

Key client files:

- `client/src/lib/image.ts` — `compressChatImage` (EXIF-aware resize + re-encode).
- `client/src/lib/photo-upload.ts` — `uploadPhoto` service (init → PUT → complete).
- `client/src/lib/api.ts` — `initPhotoUpload`, `completePhotoUpload`,
  `getAttachmentUrl`, `putToPresignedUrl` (XHR with progress + `AbortSignal`).
- `client/src/lib/outbox.ts` — FIFO send queue; image delivery uses `uploadPhoto`.
- `client/src/components/ChatImageBubble.tsx` — placeholder / progress / inline
  error + retry.

## 2. Why the file does not go through nginx

nginx sits in front of the Go backend and enforces `client_max_body_size`. That
config cannot be changed, so routing photo bytes through nginx would reject
larger images with `413`. Uploading straight to Object Storage with a pre-signed
`PUT` (and downloading with a pre-signed `GET`) bypasses nginx and Go entirely —
only tiny JSON metadata requests hit the backend.

## 3. Environment variables

`S3_*` and `YANDEX_STORAGE_*` names are interchangeable (see `server/.env.example`).

| Variable | Purpose | Default |
| --- | --- | --- |
| `S3_ENDPOINT` / `YANDEX_STORAGE_ENDPOINT` | `storage.yandexcloud.net` | — |
| `S3_REGION` / `YANDEX_STORAGE_REGION` | `ru-central1` | auto for yandex |
| `S3_ACCESS_KEY_ID` / `YANDEX_STORAGE_ACCESS_KEY` | static access key | — |
| `S3_SECRET_ACCESS_KEY` / `YANDEX_STORAGE_SECRET_KEY` | static secret key | — |
| `S3_BUCKET` / `YANDEX_STORAGE_BUCKET` | bucket name | `coachman` |
| `S3_USE_SSL` | force HTTPS (auto for yandex) | off |
| `YANDEX_CDN_BASE_URL` | public CDN origin (public model only) | empty → private/presigned GET |
| `PHOTO_MAX_FILE_SIZE` | hard server-side size limit (bytes) | `31457280` (30 MB) |
| `PHOTO_UPLOAD_URL_TTL` | presigned PUT lifetime (seconds) | `600` |
| `PHOTO_DOWNLOAD_URL_TTL` | presigned GET lifetime (seconds) | `600` |

Secret keys stay on the server only — never shipped to the frontend or committed.

## 4. Create the bucket

1. In the Yandex Cloud console create an Object Storage bucket (e.g. `coachman`).
2. Access: **private** (recommended — see Privacy). Do **not** enable public
   write. Only enable public read if you intentionally use the CDN model below.
3. Create a service account and a static access key; put the pair in the server
   env (`S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`).

## 5. CORS configuration (manual, in the console)

Browser `PUT`/`GET` require bucket CORS. The service account key usually
**cannot** set CORS via API on Yandex, so configure it in the console (Bucket →
CORS). Yandex rejects `AllowedOrigins: ["*"]` for credentialed requests — list
your exact origins.

```json
[
  {
    "AllowedOrigins": [
      "https://messenger.example.com"
    ],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["Content-Type"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

Add `http://localhost:5173` (Vite) and `capacitor://localhost` / `https://localhost`
(mobile WebView) only for development. Keep production origins minimal.

The pre-signed PUT is signed **with `Content-Type`**, so `AllowedHeaders` must
include `Content-Type` and the browser must send exactly that header (the client
does — see §11).

## 6. CDN configuration

CDN is optional and only relevant to the public model (§7). To use it, put a
Yandex Cloud CDN resource in front of the bucket and set `YANDEX_CDN_BASE_URL` to
the CDN origin. When set, `complete`/download responses return
`YANDEX_CDN_BASE_URL/<objectKey>` instead of a presigned GET URL.

For the private model, leave `YANDEX_CDN_BASE_URL` empty.

## 7. Privacy model

The default (and recommended) model is **Variant 2 — private bucket + short-lived
pre-signed GET URLs**:

- The bucket stays private.
- Downloads go through `GET /api/images/{id}` (or
  `GET /api/attachments/{id}/url`), which checks chat membership and returns a
  fresh presigned GET URL valid for `PHOTO_DOWNLOAD_URL_TTL`.
- The presigned URL is never stored in the DB — only the object key is.

**Variant 1 — public CDN with unguessable URLs** is available by setting
`YANDEX_CDN_BASE_URL`. Object keys embed a cryptographically random UUID
(`chats/{chatId}/{year}/{month}/{uuid}.{ext}`), so URLs are unguessable, but
**anyone with the URL can read the photo** — the URL is not real authorization.
Only use this if that trade-off is acceptable.

## 8. Local run

- **MinIO** is the easiest S3-compatible local backend:
  ```
  S3_ENDPOINT=localhost:9000
  S3_ACCESS_KEY=minioadmin
  S3_SECRET_KEY=minioadmin
  S3_BUCKET=coachman
  ```
  The app auto-creates the bucket and attempts to set a permissive CORS policy on
  MinIO (unlike Yandex, MinIO allows the key to set CORS).
- Without `S3_ENDPOINT` object storage is disabled and the photo endpoints return
  `503 direct upload unavailable`.

## 9. Size limits

The backend is the source of truth: `PHOTO_MAX_FILE_SIZE` (default 30 MB) is
checked at `init` (declared size) and again at `complete` (real `HeadObject`
size). The client compresses before upload and may pre-check for UX, but the
server always re-validates. Over-limit uploads return `413` with a user-friendly
message; the chat bubble shows an inline error with a retry button.

## 10. Cleanup of unfinished uploads

`uploads` rows track `pending` / `completed` / `failed`. Expired `pending` rows
(URL TTL elapsed, no `complete`) and their orphaned objects are removed by
`Store.CleanupExpiredUploads`:

- The API server runs a sweep every 10 minutes (goroutine in `cmd/api`).
- Or run it manually / from cron:
  ```
  go run ./server/cmd/photocleanup
  ```

## 11. Content-Type signing gotcha

The PUT URL is signed with the exact `Content-Type` from `init`. The browser
**must** send the same `Content-Type` header on PUT and **must not** add
`Authorization`, cookies, or other headers — any deviation breaks the SigV4
signature (`403 SignatureDoesNotMatch`). `putToPresignedUrl` sets only
`Content-Type`. The value sent to `init` is the compressed `blob.type`.

## 12. Manual verification

1. Start the server with S3 env configured and the client (`npm run dev`).
2. In a chat, attach a photo. In DevTools → Network you should see:
   - `POST /api/uploads/photos/init` → `200` with `uploadUrl`,
   - a `PUT` to `storage.yandexcloud.net` (or MinIO) → `200`,
   - `POST /api/uploads/photos/complete` → `200` with `attachmentId`,
   - `POST /api/chats/{id}/messages` → `200`.
3. Reload as the recipient: `GET /api/images/{id}` → `200 {url}`, then a `GET` to
   storage → `200` (image renders).
4. cURL smoke test:
   ```bash
   TOKEN=... CHAT=...
   INIT=$(curl -s -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
     -d "{\"chatId\":\"$CHAT\",\"contentType\":\"image/jpeg\",\"size\":$(stat -f%z photo.jpg)}" \
     http://localhost:3001/api/uploads/photos/init)
   URL=$(echo "$INIT" | jq -r .uploadUrl); UID=$(echo "$INIT" | jq -r .uploadId)
   curl -s -X PUT -H 'Content-Type: image/jpeg' --data-binary @photo.jpg "$URL"
   curl -s -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
     -d "{\"uploadId\":\"$UID\",\"width\":0,\"height\":0}" \
     http://localhost:3001/api/uploads/photos/complete
   ```

## 13. Required IAM permissions

The service account needs **only** object-level rights on the specific bucket:

- `s3:PutObject` — presigned PUT writes.
- `s3:GetObject` — presigned GET reads (and legacy proxy fallback).
- `s3:GetObject` / `HeadObject` — object validation on `complete`.
- `s3:DeleteObject` — cleanup of orphaned uploads.

In Yandex terms, grant the service account `storage.uploader` + `storage.viewer`
(or a custom role limited to the bucket). It does **not** need bucket-policy or
CORS-management rights — configure CORS manually in the console.

## 14. Known limitations / future work

- **Server-side content validation** is minimal: MIME is whitelisted and size is
  verified via `HeadObject`, but the object bytes are not decoded/normalized on
  the server (no EXIF/GPS stripping, no re-encode, no thumbnail generation).
  Client-side compression already strips most metadata by re-encoding through a
  canvas. A background image-processing worker is the place to add server-side
  format sniffing, pixel-count limits, EXIF stripping, and thumbnails.
- **Multipart upload** is intentionally not implemented — a single presigned PUT
  is enough for photos. Multipart/resumable is left as future work for large
  video or unstable mobile links.
- **Thumbnails** are not generated; the client renders the full image lazily with
  a reserved placeholder.
