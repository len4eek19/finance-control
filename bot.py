"""Finance Control — Telegram Bot.

Two operating modes
-------------------
Local mode (default):
  Start via «Запустить бота.cmd».  Config read from data/bot.json.
  Expenses written directly to data/finance.db; CSV files saved to bot-imports/.

Cloud mode (Railway / Render / any Linux server):
  Set environment variable BOT_TOKEN.  No local files required.
  Expenses queued in data/bot-queue.json; the desktop app syncs them on startup
  by calling GET /api/pending (protected by X-API-Key header).

Required packages: python-telegram-bot>=20.0  aiohttp>=3.9  (cloud mode only)

Setup (local)
-------------
1. @BotFather → /newbot → copy token into data/bot.json
2. Run «Запустить бота.cmd»
3. Add bot to a Telegram group; disable Group Privacy in BotFather

Setup (cloud)
-------------
Set environment variables:
  BOT_TOKEN          — token from @BotFather
  ALLOWED_CHAT_IDS   — comma-separated chat IDs  (-123456789,987654321)
  API_KEY            — random secret for sync endpoint  (e.g. openssl rand -hex 16)
  PORT               — HTTP port (Railway/Render set this automatically)

Then put the same API_KEY and the deployed URL in data/bot.json:
  "cloud_bot_url": "https://your-app.railway.app",
  "cloud_sync_key": "your-api-key"
"""
from __future__ import annotations

import asyncio
import base64
import io
import json
import logging
import os
import re
import signal
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

try:
    from telegram import InlineKeyboardButton, InlineKeyboardMarkup, Update
    from telegram.ext import (
        Application, CallbackQueryHandler, CommandHandler,
        ConversationHandler, MessageHandler, filters, ContextTypes,
    )
except ImportError:
    raise SystemExit(
        "Установите зависимости:\n  py -3 -m pip install python-telegram-bot\n"
        "Или запустите «Запустить бота.cmd» — он сделает это автоматически."
    )

# ─────────────────────────────────────────── paths & mode detection ──

ROOT       = Path(__file__).resolve().parent
DATA_DIR   = Path(os.environ.get("DATA_DIR", str(ROOT / "data")))
DATABASE   = DATA_DIR / "finance.db"
CONFIG_FILE = DATA_DIR / "bot.json"
BOT_IMPORTS = ROOT / "bot-imports"
QUEUE_FILE  = DATA_DIR / "bot-queue.json"

# Cloud mode: BOT_TOKEN supplied via environment variable
IS_CLOUD = bool(os.environ.get("BOT_TOKEN"))

if IS_CLOUD:
    try:
        from aiohttp import web as aio_web
    except ImportError:
        raise SystemExit(
            "aiohttp is required for cloud mode.\n"
            "  pip install aiohttp"
        )

logging.basicConfig(
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    level=logging.INFO,
)
log = logging.getLogger("finbot")

# ─────────────────────────────────────────── conversation states ──

SELECT_CAT, ENTER_AMOUNT, ENTER_DESC = range(3)

# ─────────────────────────────────────────── categories ──

CATEGORIES = [
    "Продукты",         "Кафе и досуг",
    "Транспорт",        "Покупки и дом",
    "Здоровье",         "Одежда",
    "Образование",      "Коммуналка и связь",
    "Цифровые сервисы", "Путешествия",
    "Артем",            "Накопления",
    "Неразобранное",
]


def cat_keyboard() -> InlineKeyboardMarkup:
    pairs = [CATEGORIES[i : i + 2] for i in range(0, len(CATEGORIES), 2)]
    rows = [
        [InlineKeyboardButton(c, callback_data=f"cat:{c}") for c in pair]
        for pair in pairs
    ]
    rows.append([InlineKeyboardButton("❌ Отмена", callback_data="cancel")])
    return InlineKeyboardMarkup(rows)


# ─────────────────────────────────────────── pending queue (cloud) ──

_queue_lock = threading.Lock()


def _q_load() -> dict:
    if QUEUE_FILE.exists():
        try:
            return json.loads(QUEUE_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {"expenses": [], "csv_files": []}


def _q_save(data: dict) -> None:
    DATA_DIR.mkdir(exist_ok=True)
    QUEUE_FILE.write_text(
        json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def queue_add_expense(payload: dict) -> None:
    with _queue_lock:
        data = _q_load()
        data["expenses"].append(payload)
        _q_save(data)


def queue_add_csv(filename: str, content_b64: str) -> None:
    with _queue_lock:
        data = _q_load()
        data["csv_files"].append({"filename": filename, "content": content_b64})
        _q_save(data)


def queue_snapshot() -> dict:
    with _queue_lock:
        return _q_load()


def queue_ack(expense_ids: list[str], csv_filenames: list[str]) -> None:
    id_set = set(expense_ids)
    fn_set = set(csv_filenames)
    with _queue_lock:
        data = _q_load()
        data["expenses"]  = [e for e in data["expenses"]  if e.get("id")       not in id_set]
        data["csv_files"] = [f for f in data["csv_files"] if f.get("filename") not in fn_set]
        _q_save(data)


# ─────────────────────────────────────────── database helpers (local) ──

@contextmanager
def db_conn():
    if not DATABASE.exists():
        raise RuntimeError(
            "База данных не найдена. Сначала запустите «Запустить приложение.cmd»."
        )
    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def get_settings() -> dict:
    try:
        with db_conn() as conn:
            rows = conn.execute("SELECT key, value FROM settings").fetchall()
        return {r["key"]: json.loads(r["value"]) for r in rows}
    except Exception:
        return {"uahPerEur": 51.8, "usdPerEur": 1.08}


def to_eur(amount: float, currency: str, settings: dict) -> float:
    c = currency.upper()
    a = abs(amount)
    if c == "EUR": return a
    if c == "BGN": return a / 1.95583
    if c in ("UAH", "ГРН"): return a / max(float(settings.get("uahPerEur", 51.8)), 0.01)
    if c == "USD":           return a / max(float(settings.get("usdPerEur", 1.08)), 0.01)
    return a


# ─────────────────────────────────────────── amount parsing ──

CURRENCY_MAP = {
    "€": "EUR", "eur": "EUR",
    "$": "USD", "usd": "USD",
    "uah": "UAH", "грн": "UAH", "₴": "UAH",
    "bgn": "BGN", "лв": "BGN",
}
AMOUNT_RE = re.compile(
    r"(?<!\d)(\d[\d\s]*(?:[.,]\d{1,2})?)\s*([€$₴]|eur|uah|грн|usd|bgn|лв)?(?!\d)",
    re.IGNORECASE,
)


def parse_amount(text: str) -> tuple[float, str] | None:
    m = AMOUNT_RE.search(text.strip())
    if not m:
        return None
    try:
        amount = float(m.group(1).replace(" ", "").replace(",", "."))
    except ValueError:
        return None
    if amount <= 0:
        return None
    currency = CURRENCY_MAP.get((m.group(2) or "").lower(), "EUR")
    return (amount, currency)


# ─────────────────────────────────────────── save expense ──

def save_expense(
    category: str, amount: float, currency: str, description: str, sender: str
) -> str:
    now    = datetime.now(timezone.utc).isoformat()
    tx_id  = f"bot-{uuid.uuid4().hex[:12]}"
    # In cloud mode exchange rates are unknown; use defaults
    settings = {} if IS_CLOUD else get_settings()
    eur    = round(to_eur(amount, currency, settings), 4)

    payload = {
        "id": tx_id,
        "accountId": f"Telegram ({sender})",
        "imported": False, "cashEntry": False,
        "date": now, "description": description,
        "mcc": "", "operationAmount": -amount,
        "currency": currency, "baseAmount": eur,
        "conversion": "telegram bot",
        "type": "expense", "category": category, "manualCategory": True,
    }

    if IS_CLOUD:
        queue_add_expense(payload)
    else:
        with db_conn() as conn:
            conn.execute(
                """INSERT OR IGNORE INTO transactions
                   (id, account_id, operation_date, description, mcc,
                    operation_amount, currency, base_amount,
                    transaction_type, category, manual_category, cash_entry, imported, payload)
                   VALUES (?, ?, ?, ?, '', ?, ?, ?, 'expense', ?, 1, 0, 0, ?)""",
                (tx_id, payload["accountId"], now, description,
                 -amount, currency, eur, category,
                 json.dumps(payload, ensure_ascii=False)),
            )

    log.info("Saved expense %s: %s %s → %s (%.2f €)", tx_id, amount, currency, category, eur)
    return tx_id


# ─────────────────────────────────────────── helpers ──

def _expense_preview(ud: dict) -> str:
    s      = {} if IS_CLOUD else get_settings()
    eur    = to_eur(ud["amount"], ud["currency"], s)
    suffix = f" ≈ {eur:.2f} €" if ud["currency"] != "EUR" else ""
    return (
        f"Категория: {ud['category']}\n"
        f"Сумма: {ud['amount']} {ud['currency']}{suffix}"
    )


def safe_import_path(filename: str) -> Path:
    stem      = re.sub(r"[^A-Za-zА-Яа-яЁё0-9 _.-]", "_", Path(filename).stem).strip(" ._") or "statement"
    candidate = BOT_IMPORTS / f"{stem}.csv"
    if not candidate.exists():
        return candidate
    return BOT_IMPORTS / f"{stem}-{uuid.uuid4().hex[:8]}.csv"


# ─────────────────────────────────────────── conversation handlers ──

async def cmd_add(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    context.user_data.clear()
    await update.message.reply_text("Выбери категорию:", reply_markup=cat_keyboard())
    return SELECT_CAT


async def cb_select_cat(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()

    if query.data == "cancel":
        await query.edit_message_text("Отменено.")
        context.user_data.clear()
        return ConversationHandler.END

    cat = query.data.removeprefix("cat:")
    if cat not in CATEGORIES:
        await query.edit_message_text("Неизвестная категория. Начните ввод заново через /add.")
        context.user_data.clear()
        return ConversationHandler.END

    context.user_data["category"] = cat
    await query.edit_message_text(
        f"Категория: *{cat}*\n\n"
        "Введи сумму:\n"
        "`12.5` · `45` · `500 грн` · `15 BGN`",
        parse_mode="Markdown",
    )
    return ENTER_AMOUNT


async def msg_enter_amount(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    result = parse_amount(update.message.text or "")
    if result is None:
        await update.message.reply_text(
            "Не понял сумму. Введи число, например: `12.5` или `500 грн`",
            parse_mode="Markdown",
        )
        return ENTER_AMOUNT

    context.user_data["amount"], context.user_data["currency"] = result
    skip_kb = InlineKeyboardMarkup([[
        InlineKeyboardButton("Пропустить описание →", callback_data="skip_desc"),
        InlineKeyboardButton("❌ Отмена", callback_data="cancel_desc"),
    ]])
    await update.message.reply_text(
        f"{_expense_preview(context.user_data)}\n\n"
        "Добавь описание (магазин, повод) или пропусти:",
        reply_markup=skip_kb,
    )
    return ENTER_DESC


async def msg_enter_desc(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    context.user_data["description"] = (update.message.text or "").strip() or "Ручная трата"
    return await _finish(update.message, update, context)


async def cb_skip_desc(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()
    if query.data == "cancel_desc":
        await query.edit_message_text("Отменено.")
        context.user_data.clear()
        return ConversationHandler.END
    context.user_data.setdefault("description", "Ручная трата")
    return await _finish(query.message, update, context)


async def _finish(message, update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    ud     = context.user_data
    sender = update.effective_user.first_name or update.effective_user.username or "bot"
    try:
        save_expense(ud["category"], ud["amount"], ud["currency"], ud["description"], sender)
        s      = {} if IS_CLOUD else get_settings()
        eur    = to_eur(ud["amount"], ud["currency"], s)
        suffix = f" ≈ {eur:.2f} €" if ud["currency"] != "EUR" else ""
        sync_note = "\n_(синхронизируется при запуске приложения)_" if IS_CLOUD else ""
        await message.reply_text(
            f"✅ Сохранено\n"
            f"{ud['description']} — {ud['amount']} {ud['currency']}{suffix}\n"
            f"Категория: {ud['category']}" + sync_note,
            parse_mode="Markdown",
        )
    except Exception:
        log.exception("save_expense failed")
        await message.reply_text("Не удалось записать операцию. Проверьте журнал.")
    context.user_data.clear()
    return ConversationHandler.END


async def cmd_cancel(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    context.user_data.clear()
    await update.message.reply_text("Отменено.")
    return ConversationHandler.END


# ─────────────────────────────────────────── non-conversation handlers ──

async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    mode_note = (
        "Работает в облаке — данные синхронизируются при следующем открытии приложения."
        if IS_CLOUD else
        "CSV-выписку просто отправь файлом — сохраню в очередь импорта."
    )
    await update.message.reply_text(
        "Finance Control Bot\n\n"
        "/add — Добавить расход (меню категорий)\n"
        "/status — Статус очереди\n"
        "/cancel — Отменить ввод\n\n"
        + mode_note
    )


async def cmd_status(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if IS_CLOUD:
        data = queue_snapshot()
        exp  = len(data.get("expenses", []))
        csv  = len(data.get("csv_files", []))
        await update.message.reply_text(
            f"Ожидают синхронизации:\n"
            f"Расходы: {exp}\n"
            f"CSV: {csv}"
        )
        return

    pending = list(BOT_IMPORTS.glob("*.csv")) if BOT_IMPORTS.exists() else []
    try:
        with db_conn() as conn:
            count = conn.execute(
                "SELECT COUNT(*) FROM transactions WHERE account_id LIKE 'Telegram%'"
            ).fetchone()[0]
        await update.message.reply_text(
            f"Транзакций от бота: {count}\n"
            f"CSV ожидают импорта: {len(pending)}"
            + ("\n— " + "\n— ".join(f.name for f in pending) if pending else "")
        )
    except Exception:
        log.exception("status failed")
        await update.message.reply_text("Не удалось получить статус.")


async def handle_document(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    doc = update.message.document
    if not doc.file_name.lower().endswith(".csv"):
        return
    tg_file = await context.bot.get_file(doc.file_id)

    if IS_CLOUD:
        buf = io.BytesIO()
        await tg_file.download_to_memory(buf)
        safe_name   = re.sub(r"[^A-Za-z0-9._-]", "_", doc.file_name)
        content_b64 = base64.b64encode(buf.getvalue()).decode()
        queue_add_csv(safe_name, content_b64)
        log.info("Queued CSV: %s (%d bytes)", safe_name, len(buf.getvalue()))
        await update.message.reply_text(
            f"CSV получен: {doc.file_name}\n"
            "Откроешь приложение — данные автоматически подтянутся."
        )
    else:
        BOT_IMPORTS.mkdir(exist_ok=True)
        dest = safe_import_path(doc.file_name)
        await tg_file.download_to_drive(str(dest))
        log.info("Saved CSV: %s", dest)
        await update.message.reply_text(
            f"CSV сохранён: {doc.file_name}\n"
            "Открой приложение → Настройки → «Импорт из Telegram»."
        )


# ─────────────────────────────────────────── HTTP API (cloud mode) ──

def _make_web_app(api_key: str) -> "aio_web.Application":
    app = aio_web.Application()

    def _check_key(request: "aio_web.Request") -> None:
        key = request.headers.get("X-API-Key") or request.rel_url.query.get("key", "")
        if api_key and key != api_key:
            raise aio_web.HTTPForbidden(reason="Invalid API key")

    async def health(request: "aio_web.Request") -> "aio_web.Response":
        data = queue_snapshot()
        return aio_web.json_response({
            "ok": True,
            "mode": "cloud",
            "pending_expenses": len(data.get("expenses", [])),
            "pending_csvs":     len(data.get("csv_files", [])),
        })

    async def pending(request: "aio_web.Request") -> "aio_web.Response":
        _check_key(request)
        return aio_web.json_response(queue_snapshot())

    async def ack(request: "aio_web.Request") -> "aio_web.Response":
        _check_key(request)
        body = await request.json()
        queue_ack(
            body.get("expense_ids", []),
            body.get("csv_filenames", []),
        )
        return aio_web.json_response({"ok": True})

    app.router.add_get("/health",       health)
    app.router.add_get("/api/pending",  pending)
    app.router.add_post("/api/ack",     ack)
    return app


# ─────────────────────────────────────────── build application ──

def _build_app(token: str, allowed: list[int]) -> Application:
    access = filters.Chat(chat_id=allowed) if allowed else filters.ALL
    conv = ConversationHandler(
        entry_points=[CommandHandler("add", cmd_add, filters=access)],
        states={
            SELECT_CAT: [CallbackQueryHandler(cb_select_cat)],
            ENTER_AMOUNT: [
                MessageHandler(filters.TEXT & ~filters.COMMAND & access, msg_enter_amount),
                CommandHandler("cancel", cmd_cancel, filters=access),
            ],
            ENTER_DESC: [
                CallbackQueryHandler(cb_skip_desc),
                MessageHandler(filters.TEXT & ~filters.COMMAND & access, msg_enter_desc),
                CommandHandler("cancel", cmd_cancel, filters=access),
            ],
        },
        fallbacks=[CommandHandler("cancel", cmd_cancel, filters=access)],
        conversation_timeout=300,
        per_user=True,
        per_chat=True,
    )
    bot_app = Application.builder().token(token).build()
    bot_app.add_handler(CommandHandler("start",  cmd_start,  filters=access))
    bot_app.add_handler(CommandHandler("help",   cmd_start,  filters=access))
    bot_app.add_handler(CommandHandler("status", cmd_status, filters=access))
    bot_app.add_handler(MessageHandler(filters.Document.ALL & access, handle_document))
    bot_app.add_handler(conv)
    return bot_app


# ─────────────────────────────────────────── entry points ──

async def _run_cloud(token: str, allowed: list[int], api_key: str, http_port: int) -> None:
    bot_app = _build_app(token, allowed)

    runner  = aio_web.AppRunner(_make_web_app(api_key))
    await runner.setup()
    site = aio_web.TCPSite(runner, "0.0.0.0", http_port)
    await site.start()
    log.info("HTTP sync API listening on port %d", http_port)

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, stop.set)
        except (NotImplementedError, OSError):
            pass  # Windows doesn't support add_signal_handler

    async with bot_app:
        await bot_app.start()
        await bot_app.updater.start_polling(allowed_updates=Update.ALL_TYPES)
        log.info("Bot polling started (cloud mode)")
        try:
            await stop.wait()
        except asyncio.CancelledError:
            pass
        await bot_app.updater.stop()
        await bot_app.stop()

    await runner.cleanup()


def _run_local(token: str, allowed: list[int]) -> None:
    bot_app = _build_app(token, allowed)
    print("Finance Control Bot запущен (Ctrl+C для остановки)")
    print(f"CSV folder : {BOT_IMPORTS}")
    print(f"Allowed IDs: {allowed}")
    bot_app.run_polling(allowed_updates=Update.ALL_TYPES)


def main() -> None:
    if IS_CLOUD:
        token     = os.environ["BOT_TOKEN"]
        raw_ids   = os.environ.get("ALLOWED_CHAT_IDS", "")
        allowed   = [int(x.strip()) for x in raw_ids.split(",") if x.strip().lstrip("-").isdigit()]
        api_key   = os.environ.get("API_KEY", "")
        http_port = int(os.environ.get("PORT", "8080"))

        if not api_key:
            log.warning("API_KEY is not set — sync endpoint is unprotected!")

        log.info("Cloud mode | port=%d | allowed_chats=%s", http_port, allowed)
        asyncio.run(_run_cloud(token, allowed, api_key, http_port))

    else:
        # Local mode — read config from file
        if not CONFIG_FILE.exists():
            DATA_DIR.mkdir(exist_ok=True)
            CONFIG_FILE.write_text(
                json.dumps(
                    {
                        "token": "ВСТАВЬ_ТОКЕН_ЗДЕСЬ",
                        "allowed_chat_ids": [],
                        "cloud_bot_url": "",
                        "cloud_sync_key": "",
                    },
                    indent=2, ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            print(f"Создан конфиг: {CONFIG_FILE}")
            print("Вставь токен от @BotFather в поле 'token' и запусти снова.")
            return

        config  = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        token   = config.get("token", "")
        if not token or "ВСТАВЬ" in token or "PASTE" in token:
            print(f"Открой {CONFIG_FILE} и вставь токен бота.")
            return

        allowed = [int(x) for x in config.get("allowed_chat_ids", []) if x]
        if not allowed:
            print(f"Добавь хотя бы один chat ID в {CONFIG_FILE} → 'allowed_chat_ids'.")
            return

        _run_local(token, allowed)


if __name__ == "__main__":
    main()
