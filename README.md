# Ямщик (Coachman)

Простой зашифрованный веб-мессенджер с поддержкой PWA (работает офлайн), групп и отправки изображений. Android — через Capacitor (тот же веб-клиент в нативной оболочке).

## Возможности

- **E2E шифрование** — сообщения шифруются в браузере (ECDH P-256 + AES-GCM). Сервер хранит только зашифрованные данные.
- **PWA** — приложение устанавливается на устройство и открывается без интернета с кэшированной историей сообщений (IndexedDB).
- **Android** — APK через Capacitor: переиспользует UI и логику PWA (без отдельного React Native UI).
- **Личные чаты** — переписка один на один.
- **Группы** — групповые чаты с общим ключом шифрования.
- **Изображения** — отправка картинок с шифрованием на клиенте.
- **Real-time** — доставка сообщений через WebSocket.
- **Видеозвонки** — 1:1 WebRTC (сигналинг через WebSocket; STUN/TURN; входящий звонок будит устройство через Web Push).
- **Офлайн-очередь** — исходящие сообщения сохраняются и отправляются при появлении сети.
- **Кэш изображений** — просмотр фото офлайн после первой загрузки.
- **Парольная фраза** — опциональное шифрование ключей на устройстве (PBKDF2 + AES-GCM).
- **Сверка ключей** — fingerprint в личных чатах.

## Стек

- **Клиент:** React 19, Vite, TypeScript, IndexedDB, Web Crypto, vite-plugin-pwa, Capacitor (Android)
- **Сервер:** Go, Chi, WebSocket, PostgreSQL (или SQLite), Redis (опционально)
- **Деплой:** Docker / бинарь + статика `client/dist`
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
| `JWT_SECRET` | — (обязателен) | Секрет для JWT. Без `COACHMAN_DEV=1` сервер не стартует с пустым/дефолтным значением |
| `COACHMAN_DEV` | — | `1` разрешает дефолтный JWT только для локальной разработки |
| `BOOTSTRAP_TOKEN` | — | Токен первичной установки админа. Ссылка: `?bootstrap=TOKEN` |
| `BOOTSTRAP_ALLOW_REBIND` | off | `1` — разрешить смену ключей админа тем же bootstrap-токеном |
| `BOOTSTRAP_ALLOW_RESET` | off | `1` — разрешить `POST /auth/bootstrap-reset` (полный wipe БД) |
| `INVITE_TTL_HOURS` | `168` | Срок жизни ссылки-приглашения в часах (`0` = без срока) |
| `VAPID_PUBLIC_KEY` | — | Публичный ключ Web Push (см. ниже) |
| `VAPID_PRIVATE_KEY` | — | Приватный ключ Web Push |
| `VAPID_SUBJECT` | `mailto:admin@coachman.local` | Контакт для push-сервисов (обычно `mailto:...`) |
| `CORS_ORIGIN` | `http://localhost:5173,http://localhost:3001` | Разрешённые origins через запятую |
| `S3_ENDPOINT` | — | MinIO/S3 endpoint (например `localhost:9000`). Если пусто — BLOB в PostgreSQL |
| `S3_ACCESS_KEY` | — | Ключ доступа S3 |
| `S3_SECRET_KEY` | — | Секрет S3 |
| `S3_BUCKET` | `coachman` | Имя bucket |
| `S3_USE_SSL` | `false` | HTTPS для S3 (`true` / `1`) |
| `TURN_URLS` | — | TURN URLs через запятую (`turn:…`, `turns:…`) для видеозвонков через NAT |
| `TURN_SECRET` | — | Shared secret coturn (`static-auth-secret` / `use-auth-secret`). API выдаёт временный пароль |
| `TURN_USERNAME` | `coachman` | Id в ephemeral username (`expiry:id`) или статический логин |
| `TURN_CREDENTIAL` | — | Статический пароль TURN (если без `TURN_SECRET`) |
| `TURN_TTL_SECONDS` | `86400` | TTL ephemeral TURN credentials |
| `STUN_URLS` | Google STUN | STUN URLs через запятую |
| `ICE_SERVERS_JSON` | — | Полный JSON ICE (перекрывает `STUN_*` / `TURN_*`) |

Список ICE/TURN отдаётся только авторизованным клиентам через `GET /api/ice-servers`. Публичный `/runtime-config.js` содержит только VAPID public key. При `TURN_SECRET` credentials генерируются на каждый запрос (HMAC-SHA1, формат coturn REST API).

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

Bootstrap-ссылка работает как приглашение: её можно открыть по URL или **вставить в поле ссылки** на экране входа.

**Локально:**

```bash
export BOOTSTRAP_TOKEN=your-secret-bootstrap-token
npm run dev
```

Откройте: `http://localhost:5173/?bootstrap=YOUR_BOOTSTRAP_TOKEN`

**Продакшен:**

`https://your-host/?bootstrap=YOUR_BOOTSTRAP_TOKEN`

Подставьте значение `BOOTSTRAP_TOKEN` из `--env-file server/.env` на сервере.

- Пока в базе нет пользователей — ссылка открывает форму: указываете **своё имя**, этот пользователь становится администратором (отдельной учётки `@admin` больше нет).
- Уже существующий пользователь может стать админом в **Настройки → Стать администратором**, вставив тот же bootstrap-токен или ссылку (предыдущий админ теряет права).
- Если админ уже есть и включён `BOOTSTRAP_ALLOW_REBIND=1` — bootstrap-ссылка может заново привязать ключи текущего админа к новому устройству.
- На устройстве, где аккаунт админа уже сохранён, bootstrap просто входит в него **без смены ключей**.

Дальше только админ создаёт одноразовые ссылки-приглашения. Новый пользователь переходит по `?invite=TOKEN` (или вставляет ссылку), создаёт аккаунт и попадает в тот же круг.

- Поиск и новые чаты — только внутри круга (все, кто связан цепочкой приглашений от одного админа).

### Web Push (уведомления в фоне)

Для push на иконку установленного PWA (iPhone/Android) нужны VAPID-ключи:

```bash
npm run generate:vapid
```

Добавьте вывод в `server/.env`:

```
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:you@example.com
```

После входа приложение запросит разрешение на уведомления и зарегистрирует устройство. Push отправляется всегда; если приложение открыто на экране, системное уведомление скрывается service worker'ом (сообщение приходит по WebSocket). В уведомлении **нет текста сообщения** — только тип («Новое сообщение» / «Фото» / …) и имя отправителя (E2E).

Входящий видеозвонок при закрытом/свёрнутом приложении тоже идёт через push («Входящий звонок» с кнопками Принять/Отклонить). В приложении — экран как у телефона (рингтон + вибрация). Полноценный системный CallKit/экран звонка ОС в PWA недоступен.

Требования: HTTPS, PWA с ярлыка на экране; iOS 16.4+.

Для iOS добавьте в `server/.env` (должен совпадать с `id` в PWA-манифесте):

```
PWA_MANIFEST_ID=https://your-host/
```

Если не задан, берётся из `CORS_ORIGIN`. Заголовок `Topic` для Apple задаётся отдельно (`coachman`, ≤32 символа).

При сборке Docker `VITE_PWA_ID` задаётся автоматически; для локальной сборки: `VITE_PWA_ID=https://your-host/ npm run build -w client`.

**iPhone:** приложение должно быть добавлено на экран «Домой»; разрешение на уведомления — по нажатию «Войти» / «Включить» в списке чатов. В iOS 17+ проверьте: Настройки → Safari → Дополнительно → Уведомления (API).

## Безопасность

- **Аутентификация**: challenge-response с ECDSA-подписью + JWT (24ч).
- **Авторизация**: все API-запросы требуют токен; проверяется членство в чате.
- **WebSocket**: подключение по JWT; fan-out получателей на сервере (через Redis при горизонтальном масштабировании).
- **Forward secrecy (личные чаты)**: каждое новое сообщение шифруется с ephemeral ECDH (v2 envelope); старые сообщения (v1) читаются как раньше.
- **Ротация групповых ключей**: при добавлении/удалении участника генерируется новый ключ (`group_key_epoch`); удалённые не читают новые сообщения.
- Для продакшена: HTTPS (Caddy/nginx) + сильный уникальный `JWT_SECRET` (без `COACHMAN_DEV`). Не включайте `BOOTSTRAP_ALLOW_REBIND` / `BOOTSTRAP_ALLOW_RESET`, пока не нужны осознанно.

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

### nginx / Caddy перед приложением

Загрузка фото на сервере — до **25 МБ**. Клиент сжимает фото до **~700 КБ**, чтобы проходить через nginx с лимитом **1 МБ** по умолчанию.

Если есть доступ к конфигу, лучше поднять лимит:

```nginx
client_max_body_size 25m;
```

## Структура

```
coachman/
├── client/          # React PWA (+ Capacitor Android shell)
│   └── android/     # Нативный проект Android Studio
├── server/
│   ├── cmd/api/     # Точка входа
│   └── internal/    # handlers, store, ws, db, auth
└── package.json
```

## Android (Capacitor)

Тот же React/Vite-клиент в нативной оболочке — **не** отдельный React Native UI.
WebRTC, IndexedDB, outbox и push (через WebView) остаются общими с PWA.

### Требования

- [Android Studio](https://developer.android.com/studio) (SDK + эмулятор или устройство)
- JDK 21 (или тот, что требует установленный AGP)
- Работающий сервер Ямщика по HTTPS (для эмулятора — см. ниже)

### Сборка и запуск

Рекомендуемый режим: APK загружает **задеплоенный** PWA (`CAP_SERVER_URL` в `client/.env`
или значение по умолчанию в `capacitor.config.ts`). Тогда `/api` и WebSocket работают как в браузере.

```bash
# 1) Собрать web + синхронизировать в android/
npm run android:sync

# 2) Открыть в Android Studio
npm run android:open

# или сразу на эмулятор/устройство (нужен SDK + adb)
npm run android:run
```

Локальная отладка против `npm run dev` на хосте — в `client/.env`:

```bash
# Эмулятор Android → хост-машина
CAP_SERVER_URL=http://10.0.2.2:3001/

# Физическое устройство в той же Wi‑Fi — IP вашего компьютера
CAP_SERVER_URL=http://192.168.1.10:3001/
```
Для HTTP на устройстве временно разрешите cleartext в `client/capacitor.config.ts`
(`server.cleartext` уже включается автоматически, если URL начинается с `http://`).
В `AndroidManifest` по умолчанию `usesCleartextTraffic="false"` — для HTTP-dev
поставьте `true` в `application` или используйте HTTPS через туннель.

### Разрешения

В манифесте уже есть: Internet, Camera, Microphone, Notifications, Bluetooth (гарнитура).
При первом звонке/съёмке WebView запросит runtime-permission.

### Ограничения оболочки

- Для **входящих звонков при закрытом приложении** нужен Firebase Cloud Messaging:
  1. Создайте проект Firebase → Android app `com.coachman.app`
  2. Скачайте `google-services.json` в `client/android/app/` (есть `google-services.json.example`)
  3. На сервере задайте `FCM_PROJECT_ID` и `FCM_SERVICE_ACCOUNT_JSON` (см. `server/.env.example`)
  4. Миграция `020_device_push_tokens` + перезапуск API
  5. В приложении включите уведомления (тот же UI, что для PWA push)
- Во время звонка Android держит foreground service + keep-awake (медиа не убивается при блокировке экрана).
- Входящий звонок: нативный полноэкранный UI (как телефон) с «Ответить» / «Отклонить». На Android 14+ при необходимости разрешите «полноэкранные уведомления» для Ямщика в настройках системы.
- Магазин (Play): понадобится signing keystore и `bundleRelease` из Android Studio.
