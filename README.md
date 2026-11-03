# 🤖 Autonomous Telegram AI Agent & Userbot

Полноценная автономная система управления Telegram с интеграцией **Telegram Bot (grammY)**, **Telegram Userbot (GramJS)**, ядром **AI Agent (ReAct Loop + Function Calling)**, долговременной памятью и фоновыми очередями задач.

---

## 🌟 Архитектура и возможности

1. **Telegram Bot (`grammY`)**:
   - Интерфейс управления личным ассистентом в Telegram.
   - Строгая изоляция доступа — доступ разрешен только владельцу по `OWNER_TELEGRAM_ID`.
   - Поддержка inline-кнопок для подтверждения действий агента (Human-in-the-loop).

2. **Telegram Userbot (`GramJS`)**:
   - Чтение недавних диалогов, истории сообщений и поиск по текстам.
   - Отправка и ответы на сообщения от имени вашего личного аккаунта.
   - Защищенная авторизация и шифрование StringSession с помощью AES-256-GCM.
   - Автоматический перехват входящих сообщений (автоответчик с настраиваемыми правилами).

3. **AI Agent Core (ReAct Planner & Function Calling)**:
   - Совместим с любым OpenAI-совместимым API (OpenRouter, OpenAI, Groq, Ollama, DeepSeek).
   - Автономный цикл рассуждений (ReAct: Thought -> Action -> Observation -> Final Answer).
   - Лимит шагов (`LLM_MAX_STEPS`), таймауты и защита от зацикливания.

4. **Реестр инструментов (Tool Registry)**:
   - `get_dialogs`: Получение списка чатов, групп и каналов.
   - `get_chat_history`: Чтение истории сообщений выбранного чата с пагинацией.
   - `search_messages`: Поиск сообщений по тексту.
   - `send_message`: Отправка сообщений (с поддержкой режима черновиков).
   - `remember_fact`, `search_memory`, `delete_memory`: Долговременная память.
   - `get_current_time`, `calculate`: Вспомогательные утилиты.

5. **Безопасность и Human-in-the-loop**:
   - Режим черновиков (`DEFAULT_AUTO_REPLY_MODE=draft`): агент не отправляет сообщение напрямую, пока владелец не нажмет кнопку **[✅ Отправить]** в Telegram-боте.
   - Полное протоколирование действий в MongoDB (`AuditLog`).
   - Маскирование всех токенов и секретов в логах Winston.

6. **Очереди и надежность**:
   - BullMQ на базе Redis с автоматическим fallback на InMemoryQueue, если Redis временно недоступен.
   - Дедупликация задач и повторные попытки с экспоненциальной задержкой.
   - Express HTTP сервер с эндпоинтом мониторинга `/health` и `/api/status`.
   - Конфигурация PM2 (`ecosystem.config.js`) для круглосуточной работы 24/7.

---

## 🚀 Быстрый старт

### 1. Установка зависимостей
```bash
npm install
```

### 2. Сборка проекта
```bash
npm run build
```

### 3. Настройка переменных окружения
Откройте файл `.env` и укажите необходимые параметры (см. руководство ниже):
```env
TELEGRAM_BOT_TOKEN=...
OWNER_TELEGRAM_ID=...
TELEGRAM_API_ID=...
TELEGRAM_API_HASH=...
LLM_API_KEY=...
MONGODB_URI=mongodb://localhost:27017/telegram_ai_bot
```

### 4. Авторизация Userbot аккаунта
Запустите интерактивную утилиту авторизации Telegram Userbot:
```bash
npm run login
```
Скрипт запросит номер телефона, код подтверждения из Telegram и 2FA пароль (если включен). Сессия будет зашифрована и сохранена в `.env` и файл `sessions/userbot.session`.

### 5. Запуск
- Режим разработки:
  ```bash
  npm run dev
  ```
- Режим production:
  ```bash
  npm run build
  npm start
  ```
- Запуск 24/7 через PM2:
  ```bash
  npx pm2 start ecosystem.config.js
  npx pm2 logs
  ```

---

## 📋 Команды Telegram Бота

- `/start` — приветствие и краткий обзор.
- `/help` — подробная справка и примеры промптов.
- `/status` — состояние подключения MongoDB, Userbot, Очередей и LLM.
- `/dialogs` — вывод последних диалогов из вашего аккаунта Telegram.
- `/memories` — просмотр сохраненных фактов в памяти.
- `/delmemory <ID>` — удаление факта из памяти.
- `/rules` — список активных правил автоответчика.
- `/addrule <name> <type> <keywords> <draft|auto>` — добавление правила.
- `/mode <draft|auto>` — переключение режима отправки.
