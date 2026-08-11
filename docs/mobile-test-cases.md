# Mobile Test Cases — Coachman Messenger

Проверяем поведение чата на:

* Android Chrome;
* Android WebView / Capacitor;
* iOS Safari;
* iOS PWA (если используется);
* portrait и landscape;
* экран с notch / safe-area;
* медленную сеть;
* offline/reconnect;
* входящие realtime messages;
* text/photo/reply/context menu;
* mobile keyboard;
* scroll behavior.

Автоматические инварианты (scroll / unread / gestures / menu geometry / identity)
покрыты unit-тестами в `client/src/lib/*`. Сценарии с реальной клавиатурой,
VisualViewport и device chrome — ручные (см. P0 gate ниже).

---

## Главные mobile invariants

| Область | Инвариант |
| --- | --- |
| Scroll | Пользователь контролирует scroll. |
| Keyboard | Keyboard не является причиной перейти вниз. |
| Realtime | Incoming message не отрывает пользователя от истории. |
| Identity | Одно logical message = один bubble. |
| Gestures | Vertical = scroll. Horizontal = reply. Hold = menu. |
| Menu | Menu появляется возле message, а не у нижнего края экрана. |
| Media | Фото и текст используют одинаковую систему message actions. |
| Viewport | Ни menu, ни ↓, ни composer не должны выходить за VisualViewport/safe-area. |

---

## P0 Mobile Release Gate

Перед релизом обязательны:

* MOB-001–MOB-025;
* MOB-026–MOB-030;
* MOB-032–MOB-045;
* MOB-048–MOB-055;
* MOB-059;
* MOB-065;
* MOB-066;
* MOB-071;
* MOB-075.

### Обязательная матрица устройств

**iOS:** современный iPhone с notch · Safari · portrait · keyboard open · safe area.

**Android:** Chrome · gesture navigation · portrait · keyboard open.

**Размеры:** маленький / средний / высокий экран.

Особенно важны: сообщение прямо над composer; сообщение прямо под header;
menu при открытой клавиатуре; history reading + incoming; typing + incoming.

---

## Cases

### MOB-001 — Открытие чата

Предусловия: в чате ≥ 50 сообщений.

1. Открыть чат.
2. Не касаться экрана.

Ожидаемо: последние сообщения видны; последнее внизу; лента не прыгает;
↓ скрыта; unread badge отсутствует; composer доступен.

### MOB-002 — Ручная прокрутка вверх

1. У низа прокрутить историю вверх на 2–3 экрана.
2. Остановить.

Ожидаемо: позиция сохраняется; появляется ↓; не перекрывает composer;
badge отсутствует, если новых не было.

### MOB-003 — Возврат вниз по кнопке

Предусловия: пользователь выше конца.

1. Нажать ↓.

Ожидаемо: один переход к последнему; ↓ исчезает; unread = 0;
нет второго скачка после render.

### MOB-004 — Ручной возврат вниз

1. Прокрутить вверх.
2. Самостоятельно докрутить до конца.

Ожидаемо: ↓ исчезает; unread = 0; автопрокрутки нет.

### MOB-005 — Incoming во время чтения истории

Предусловия: ~20 сообщений выше конца.

1. Со второго устройства отправить сообщение.

Ожидаемо: позиция не меняется; появляется ↓ + badge 1;
автопрокрутки к новому нет.

### MOB-006 — Несколько incoming

1. Уйти вверх.
2. С другого устройства отправить 5 сообщений подряд.

Ожидаемо: viewport не двигается; badge 1→5; ровно 5 новых; без автоскролла.

### MOB-007 — Duplicate realtime event

Повторная доставка одного WS event.

Ожидаемо: одно сообщение; badge +1 один раз.

### MOB-008 — Incoming внизу

1. У последнего сообщения.
2. Получить входящее.

Ожидаемо: новое видно; пользователь у конца; ↓ и badge не появляются;
нет заметного скачка.

### MOB-009 — Incoming burst внизу

1. Внизу.
2. Получить 20 сообщений быстро.

Ожидаемо: порядок верный; UI отзывчив; нет 20 отдельных scroll animations;
пользователь у конца.

### MOB-010 — Focus composer

1. Нажать в поле ввода.
2. Набирать текст.

Ожидаемо: клавиатура открыта; composer виден; лента не jump-ает;
текст сохраняется.

### MOB-011 — Incoming во время набора

1. Открыть composer, набрать слова.
2. Получить incoming.

Ожидаемо: клавиатура и focus сохраняются; текст не меняется;
list не форсируется вниз; если новое ниже viewport — ↓ + badge.

### MOB-012 — Рост textarea

1. Писать длинный текст до 4–5 строк.

Ожидаемо: composer растёт; list уменьшается; scrollTop не сбрасывается;
лента сама не прыгает вниз.

### MOB-013 — Закрытие клавиатуры

1. Открыть клавиатуру.
2. Закрыть системно.

Ожидаемо: viewport восстанавливается; нет forced scroll;
логическая позиция сохраняется.

### MOB-014 — Landscape rotation

1. Portrait → прокрутить вверх → landscape.

Ожидаемо: не отправляет в конец; история примерно на месте; ↓ корректен;
composer доступен.

### MOB-015 — Portrait rotation обратно

Те же требования к сохранению позиции.

### MOB-016 — Отправка обычного текста

1. Ввести «Привет», Send.

Ожидаемо: один bubble сразу (pending → sent); второго нет.

### MOB-017 — Быстрая двойная отправка

«Да» + сразу ещё «Да».

Ожидаемо: два bubble; не merge; оба доставлены.

### MOB-018 — Три одинаковых текста

OK / OK / OK → ровно три bubble.

### MOB-019 — Быстрая отправка 1–10

10 bubble в порядке; без исчезновений/дублей; delayed ACK не переставляет хаотично.

### MOB-020 — Slow network send

Высокий latency → optimistic сразу, pending, UI не блокируется;
ACK обновляет тот же bubble.

### MOB-021 — Send timeout + retry

Failed → Retry → тот же bubble становится sent.

### MOB-022 — Lost ACK

Сервер принял, клиент не получил ACK, retry → сервер не дублирует;
клиент показывает один bubble.

### MOB-023 — Offline send

Сеть off → сообщение в UI (queued/failed); текст не теряется.

### MOB-024 — Reconnect после offline send

Outbox шлёт существующее; второй optimistic не создаётся; после sync — одно.

### MOB-025 — Reconnect WebSocket

Потеря сети → сообщения на другом устройстве → restore → недостающие
появляются без дублей, порядок верный.

### MOB-026 — History prepend

У верхней границы → догрузка старых → читаемое остаётся на том же Y;
не прыжок в начало/вниз.

### MOB-027 — Поздняя загрузка фото выше viewport

Читаемое не смещается резко.

### MOB-028 — Поздняя загрузка фото внизу

У конца: рост media bubble сохраняет логический конец.

### MOB-029 — Long press текста

Backdrop; выделение; menu рядом; не уезжает вниз; list не scroll-ится.

### MOB-030 — Long press фото

То же menu; native image menu не появляется; chat не двигается.

### MOB-031 — Photo + caption menu

Long press по фото и по caption → одно message entity;
media actions + «Копировать текст» при caption.

### MOB-032 — Menu у нижнего края

Над bubble; полностью в viewport; не перекрыто composer.

### MOB-033 — Menu у верхнего края

Menu снизу от bubble; полностью на экране.

### MOB-034 — Menu у правого края (own)

Выравнивание с bubble; не за правую границу; safe-area.

### MOB-035 — Menu у левого края (incoming)

Полностью в viewport.

### MOB-036 — Закрытие через backdrop

Menu + backdrop исчезают; scrollTop прежний.

### MOB-037 — Menu + incoming

Menu не прыгает; selected на месте; list не scroll-ится;
badge растёт; menu не закрывается само.

### MOB-038 — Reply через menu

Menu закрывается; reply preview; focus + keyboard; без лишнего jump.

### MOB-039 — Cancel reply

Preview исчезает; введённый текст сохраняется; следующее без reply ref.

### MOB-040 — Swipe-to-reply

Swipe вправо → reply; menu не открывается; vertical scroll нет.

### MOB-041 — Малый горизонтальный swipe

Ниже threshold → возврат; reply/menu нет.

### MOB-042 — Vertical scroll ≠ long press

Касание + сразу vertical scroll → scroll; menu/reply нет.

### MOB-043 — Vertical + небольшой horizontal

Доминирует vertical → scroll.

### MOB-044 — Long press без движения

После timeout → menu; swipe reply нет.

### MOB-045 — Один gesture — одно действие

Невозможны одновременно: reply+menu, scroll+menu, reply+tap.

### MOB-046 — Copy text

Только текст сообщения; без timestamp/author; viewport не меняется.

### MOB-047 — Copy у photo без caption

«Копировать текст» отсутствует.

### MOB-048 — Delete own text

Удаляется правильный message; соседи не затронуты; viewport не прыгает.

### MOB-049 — Delete own photo

Удаляется entity целиком, не только `<img>`.

### MOB-050 — Delete чужого

Без moderator permissions → Delete отсутствует.

### MOB-051 — Delete выше viewport

Читаемое сохраняет положение; viewport не прыгает вверх.

### MOB-052 — Tap reply quote

Переход к target; краткая подсветка.

### MOB-053 — Reply target вне загруженной истории

Догрузка → переход именно к target.

### MOB-054 — ↓ при открытой клавиатуре

↓ над composer/keyboard-safe area; не перекрывает поле ввода.
Нажатие ↓ прокручивает к последним сообщениям; focus в composer и
клавиатура остаются открытыми (кнопка не забирает focus).

### MOB-055 — Badge при открытой клавиатуре

Писать + 3 incoming → viewport не двигается; badge = 3;
клавиатура не закрывается.

### MOB-056 — Safe area (notch)

Header / ↓ / menu / composer / backdrop не под notch/home indicator.

### MOB-057 — Menu + keyboard

Menu внутри VisualViewport; actions не за клавиатурой;
underlying scroll не прыгает.

### MOB-058 — Orientation при открытом menu

Допустимо: menu закрывается **или** пересчитывает позицию.
Недопустимо: menu за viewport; chat scroll прыгает.

### MOB-059 — Background/foreground

Уход → incoming на другом устройстве → возврат → sync без дублей;
позиция при чтении истории не сбрасывается бессмысленно; unread корректен.

### MOB-060 — Очень длинное сообщение

Перенос; без overflow; menu/long press/scroll ок.

### MOB-061 — Длинный URL

Без horizontal overflow; menu в viewport.

### MOB-062 — Большое изображение

Масштаб по ширине; без horizontal scroll; menu работает.

### MOB-063 — Несколько фото подряд

10 photo: viewport не дёргается при load; scroll отзывчив;
menu каждого независимо.

### MOB-064 — Очень длинная история

Сотни/тысячи: scroll usable; ↓/badge/long press без заметной задержки.

### MOB-065 — Incoming burst во время reading

Далеко вверх + 50 messages → visual anchor; badge = 50;
responsive; без scroll вниз; duplicates не крутят counter.

### MOB-066 — Incoming burst во время typing

Keyboard + набор + 20 messages → focus/текст/viewport; unread корректен;
UI не зависает.

### MOB-067 — Повторное открытие menu

10 раз open/close → scroll не дрейфует; overlay/backdrop не зависают.

### MOB-068 — Быстрое переключение menu A→B

Menu только для B; overlay A очищен.

### MOB-069 — Realtime delete выбранного

Не падает; menu закрывается или недоступно; viewport сохраняется.

### MOB-070 — Realtime update выбранного

Overlay не stale; обновление или безопасное закрытие.

### MOB-071 — System Back при открытом menu (Android)

Сначала закрывается menu; из чата сразу не выходим; scroll сохраняется.
После dismiss через backdrop следующий Back должен уводить из чата
(без phantom history step).

### MOB-072 — System Back при клавиатуре

Закрытие keyboard не ломает scroll state / не прыгает чат.

### MOB-073 — Double tap message

Без отдельного double-tap gesture → не запускает reply/delete/menu случайно.

### MOB-074 — Multi-touch

Два пальца → не несколько menus; gesture state не зависает.

### MOB-075 — App resume после pending send

Pending не дублируется; outbox продолжает; финал — один bubble.

---

## Automated coverage map

| MOB | Автопокрытие |
| --- | --- |
| 001–004 | `chat-viewport` (`syncFromUserScroll`, FAB/unread reset) + ChatView open pin |
| 005–009 | `incomingScrollPolicy`, `planBurstIncomingScroll`, `live-message-batch`, reconcile dedupe |
| 010–013 | `composerResizeSync`, `visualViewportResizeSync`, `shouldFollowBottomOnMediaLayout` |
| 016–025 | `message-reconcile` / outbox clientId / `messenger-regression` identity |
| 026–028 | `captureVisualScrollAnchor` / `applyVisualScrollAnchor` / delete policy |
| 029–045 | `message-gestures`, `placeMessageContextMenu` |
| 048–051 | `deleteScrollPolicy` |
| 055 / 066 | `shouldBumpUnreadBelowForIncoming` (preserve + typing/menu) |
| 065 | burst coalesce + unread delta |
| 071 | `message-context-menu-history` |

Ручные (device chrome): MOB-010/013 keyboard feel, MOB-014/015/056–058 notch & rotation,
MOB-030 native image menu, MOB-054 FAB над IME, MOB-059/072/074 multi-touch / app switch.
