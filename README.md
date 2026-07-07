# Ямщик (Coachman)

Простой зашифрованный веб-мессенджер с поддержкой PWA (работает офлайн), групп и отправки изображений.

## Возможности

- **E2E шифрование** — сообщения шифруются в браузере (ECDH P-256 + AES-GCM). Сервер хранит только зашифрованные данные.
- **PWA** — приложение устанавливается на устройство и открывается без интернета с кэшированной историей сообщений (IndexedDB).
- **Личные чаты** — переписка один на один.
- **Группы** — групповые чаты с общим ключом шифрования.
- **Изображения** — отправка картинок с шифрованием на клиенте.
- **Real-time** — доставка сообщений через WebSocket.
- **Офлайн-очередь** — исходящие сообщения сохраняются и отправляются при появлении сети.
- **Кэш изображений** — просмотр фото офлайн после первой загрузки.
- **Парольная фраза** — опциональное шифрование ключей на устройстве (PBKDF2 + AES-GCM).
- **Сверка ключей** — fingerprint в личных чатах.

## Стек

- **Client**: React, Vite, vite-plugin-pwa, Web Crypto API, IndexedDB
- **Server**: Go, chi, PostgreSQL, Redis (опционально), WebSocket

## Требования

- Go 1.22+
- Node.js 20+
- PostgreSQL (или SQLite для локальной отладки без `DATABASE_URL`)

## Запуск (разработка)

Укажите `DATABASE_URL` в `server/.env`, накатите миграции и запустите:

```bash
npm install
npm run migrate
npm run dev
```

- Клиент: http://localhost:5173
- Сервер: http://localhost:3001

## Продакшен

```bash
npm run build
npm start
```

Сервер раздаёт собранный клиент из `client/dist` и API на порту 3001.

### Переменные окружения

| Переменная | По умолчанию | Описание |
|------------|--------------|----------|
| `PORT` | `3001` | Порт HTTP/WebSocket |
| `DATABASE_URL` | `postgres://coachman:coachman@localhost:5432/coachman?sslmode=disable` | PostgreSQL (основная БД) |
| `DB_PATH` | `data/coachman.db` | SQLite только если `DATABASE_URL` не задан |
| `REDIS_URL` | — | Redis для fan-out WebSocket между инстансами, например `redis://localhost:6379` |
| `JWT_SECRET` | `dev-secret-change-in-production` | Секрет для JWT (обязательно сменить в prod) |
| `BOOTSTRAP_TOKEN` | — | Токен для создания первого пользователя (админа). Ссылка: `?bootstrap=TOKEN` |
| `INVITE_TTL_HOURS` | `168` | Срок жизни ссылки-приглашения в часах (`0` = без срока) |
| `CORS_ORIGIN` | `http://localhost:5173,http://localhost:3001` | Разрешённые origins через запятую |
| `S3_ENDPOINT` | — | MinIO/S3 endpoint (например `localhost:9000`). Если пусто — BLOB в PostgreSQL |
| `S3_ACCESS_KEY` | — | Ключ доступа S3 |
| `S3_SECRET_KEY` | — | Секрет S3 |
| `S3_BUCKET` | `coachman` | Имя bucket |
| `S3_USE_SSL` | `false` | HTTPS для S3 (`true` / `1`) |

### Object storage (S3)

Для хранения изображений вне PostgreSQL укажите S3-совместимое хранилище в `server/.env` (например Yandex Object Storage — см. `server/.env.example`).

Без `S3_ENDPOINT` изображения хранятся в PostgreSQL.

### Redis (масштабирование WebSocket)

Для нескольких инстансов API укажите `REDIS_URL`, например `redis://localhost:6379`.

- Без `REDIS_URL` — WebSocket fan-out только внутри одного процесса.
- С `REDIS_URL` каждый инстанс подписывается на канал `coachman:ws` и доставляет события локальным клиентам.

Два инстанса для проверки:

```bash
PORT=3001 REDIS_URL=redis://localhost:6379 npm run dev:server
PORT=3002 REDIS_URL=redis://localhost:6379 npm run dev:server
```

Клиенты на разных портах получают сообщения через общий Redis.

### SQLite (legacy)

Для отладки можно убрать `DATABASE_URL` из `.env` — тогда используется `DB_PATH` (файл SQLite).

### Первый запуск (invite-only)

Открытая регистрация отключена. Первый пользователь (админ) создаётся по bootstrap-ссылке. Токен задаётся в `BOOTSTRAP_TOKEN` в `server/.env` — **не публикуйте его в репозитории**.

**Локально:**

```bash
export BOOTSTRAP_TOKEN=your-secret-bootstrap-token
npm run dev
```

Откройте: `http://localhost:5173/?bootstrap=YOUR_BOOTSTRAP_TOKEN`

**Продакшен (Ямщик):**

`https://coachman.eugen-bash.com/?bootstrap=YOUR_BOOTSTRAP_TOKEN`

Подставьте значение `BOOTSTRAP_TOKEN` из `--env-file server/.env` на сервере. Ссылка работает только пока в базе нет пользователей (`needsBootstrap: true`).

Дальше админ и любой участник круга могут создавать одноразовые ссылки-приглашения (кнопка 🔗 в списке чатов). Новый пользователь переходит по `?invite=TOKEN`, создаёт аккаунт и попадает в тот же круг.

- Поиск и новые чаты — только внутри круга (все, кто связан цепочкой приглашений от одного админа).
- У админа есть страница с графом приглашений (кнопка 🕸): кто кого пригласил.

## Безопасность

- **Аутентификация**: challenge-response с ECDSA-подписью + JWT (24ч).
- **Авторизация**: все API-запросы требуют токен; проверяется членство в чате.
- **WebSocket**: подключение по JWT; fan-out получателей на сервере (через Redis при горизонтальном масштабировании).
- **Forward secrecy (личные чаты)**: каждое новое сообщение шифруется с ephemeral ECDH (v2 envelope); старые сообщения (v1) читаются как раньше.
- **Ротация групповых ключей**: при добавлении/удалении участника генерируется новый ключ (`group_key_epoch`); удалённые не читают новые сообщения.
- Для продакшена: HTTPS (Caddy/nginx) + смените `JWT_SECRET`.

## Docker

Сборка и запуск (переменные — в `server/.env`):

```bash
docker build -t coachman .

docker run -d \
  --name coachman \
  --restart unless-stopped \
  --env-file server/.env \
  -p 127.0.0.1:3001:3001 \
  coachman
```

Миграции PostgreSQL накатываются автоматически при старте. Для SQLite без `DATABASE_URL` смонтируйте том: `-v coachman-data:/app/server/data` и задайте `DB_PATH=data/coachman.db`.

## Структура

```
coachman/
├── client/          # React PWA
├── server/
│   ├── cmd/api/     # Точка входа
│   └── internal/    # handlers, store, ws, db, auth
└── package.json
```
