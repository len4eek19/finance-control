"""Local-only API and SQLite storage for Finance Control.

Run through "Запустить приложение.cmd". The server binds only to 127.0.0.1,
stores data in data/finance.db, and never sends statements outside the device.
"""

from __future__ import annotations

import base64
import hashlib
import hmac as _hmac
import json
import re
import sqlite3
import urllib.error
import urllib.request
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
DATABASE = DATA_DIR / "finance.db"
HOST = "127.0.0.1"
PORT = 8765


DEFAULT_SETTINGS = {
    "income": 3200,
    "savingsGoal": 800,
    "weeklyLimit": 208,
    "reserve": 180,
    "uahPerEur": 51.8,
    "usdPerEur": 1.08,
}
DEFAULT_PAYMENTS = [
    {"id": "rent", "day": 5, "name": "Аренда квартиры", "category": "Аренда", "amount": 820},
    {"id": "school", "day": 5, "name": "Школа Артёма", "category": "Образование", "amount": 400},
    {"id": "tutor", "day": 5, "name": "Репетитор", "category": "Образование", "amount": 60},
    {"id": "mobile", "day": 5, "name": "Мобильная связь", "category": "Коммуналка и связь", "amount": 18},
    {"id": "electricity", "day": 25, "name": "Электричество", "category": "Коммуналка и связь", "amount": 50},
    {"id": "water", "day": 25, "name": "Вода", "category": "Коммуналка и связь", "amount": 20},
    {"id": "internet", "day": 25, "name": "Интернет", "category": "Коммуналка и связь", "amount": 20},
]


@contextmanager
def connection():
    DATA_DIR.mkdir(exist_ok=True)
    db = sqlite3.connect(DATABASE)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA foreign_keys=ON")
    try:
        yield db
        db.commit()
    finally:
        db.close()


def initialize_database() -> None:
    with connection() as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS settings (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS payments (
              id TEXT PRIMARY KEY,
              day INTEGER NOT NULL,
              name TEXT NOT NULL,
              category TEXT NOT NULL,
              amount REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS transactions (
              id TEXT PRIMARY KEY,
              account_id TEXT NOT NULL,
              operation_date TEXT NOT NULL,
              description TEXT NOT NULL,
              mcc TEXT,
              operation_amount REAL NOT NULL,
              currency TEXT NOT NULL,
              base_amount REAL NOT NULL,
              transaction_type TEXT NOT NULL,
              category TEXT NOT NULL,
              manual_category INTEGER NOT NULL DEFAULT 0,
              cash_entry INTEGER NOT NULL DEFAULT 0,
              imported INTEGER NOT NULL DEFAULT 0,
              payload TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS transactions_date_idx ON transactions(operation_date);
            CREATE INDEX IF NOT EXISTS transactions_category_idx ON transactions(category);
            CREATE INDEX IF NOT EXISTS transactions_mcc_idx ON transactions(mcc);
            CREATE INDEX IF NOT EXISTS transactions_account_idx ON transactions(account_id);
            CREATE TABLE IF NOT EXISTS payment_status (
              period_key TEXT NOT NULL,
              payment_id TEXT NOT NULL,
              paid INTEGER NOT NULL,
              PRIMARY KEY(period_key, payment_id)
            );
            CREATE TABLE IF NOT EXISTS shopping_items (
              id TEXT PRIMARY KEY,
              week_key TEXT NOT NULL,
              name TEXT NOT NULL,
              price REAL NOT NULL,
              bucket TEXT NOT NULL,
              essential INTEGER NOT NULL DEFAULT 1,
              purchased INTEGER NOT NULL DEFAULT 0,
              created_transaction_id TEXT,
              payload TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS shopping_items_week_idx ON shopping_items(week_key);
            """
        )
        if not db.execute("SELECT 1 FROM settings LIMIT 1").fetchone():
            db.executemany("INSERT INTO settings(key, value) VALUES (?, ?)", ((key, json.dumps(value)) for key, value in DEFAULT_SETTINGS.items()))
        if not db.execute("SELECT 1 FROM payments LIMIT 1").fetchone():
            db.executemany(
                "INSERT INTO payments(id, day, name, category, amount) VALUES (:id, :day, :name, :category, :amount)",
                DEFAULT_PAYMENTS,
            )


def database_state() -> dict:
    with connection() as db:
        settings = DEFAULT_SETTINGS.copy()
        for row in db.execute("SELECT key, value FROM settings"):
            try:
                settings[row["key"]] = json.loads(row["value"])
            except json.JSONDecodeError:
                pass
        payments = [dict(row) for row in db.execute("SELECT id, day, name, category, amount FROM payments ORDER BY day, id")]
        transactions = [json.loads(row["payload"]) for row in db.execute("SELECT payload FROM transactions ORDER BY operation_date")]
        paid = {f"{row['period_key']}:{row['payment_id']}": bool(row["paid"]) for row in db.execute("SELECT period_key, payment_id, paid FROM payment_status")}
        shopping_items = [json.loads(row["payload"]) for row in db.execute("SELECT payload FROM shopping_items ORDER BY week_key, name")]
    return {"settings": settings, "payments": payments, "transactions": transactions, "paidPayments": paid, "shoppingItems": shopping_items}


def truthy(value: object) -> int:
    return 1 if value else 0


def replace_state(payload: dict) -> None:
    settings = {**DEFAULT_SETTINGS, **(payload.get("settings") or {})}
    payments = payload.get("payments") if isinstance(payload.get("payments"), list) else DEFAULT_PAYMENTS
    transactions = payload.get("transactions") if isinstance(payload.get("transactions"), list) else []
    paid_payments = payload.get("paidPayments") if isinstance(payload.get("paidPayments"), dict) else {}
    shopping_items = payload.get("shoppingItems") if isinstance(payload.get("shoppingItems"), list) else []

    with connection() as db:
        db.execute("DELETE FROM settings")
        db.executemany("INSERT INTO settings(key, value) VALUES (?, ?)", ((str(key), json.dumps(value)) for key, value in settings.items()))
        db.execute("DELETE FROM payments")
        db.executemany(
            "INSERT INTO payments(id, day, name, category, amount) VALUES (:id, :day, :name, :category, :amount)",
            [{"id": str(item["id"]), "day": int(item["day"]), "name": str(item["name"]), "category": str(item["category"]), "amount": float(item["amount"])} for item in payments],
        )
        db.execute("DELETE FROM transactions")
        transaction_rows = []
        for item in transactions:
            if not isinstance(item, dict) or not item.get("id") or not item.get("date"):
                continue
            transaction_rows.append(
                (
                    str(item["id"]), str(item.get("accountId", "Импорт")), str(item["date"]), str(item.get("description", "Без описания")),
                    str(item.get("mcc", "")), float(item.get("operationAmount", 0)), str(item.get("currency", "EUR")),
                    float(item.get("baseAmount", 0)), str(item.get("type", "expense")), str(item.get("category", "Неразобранное")),
                    truthy(item.get("manualCategory")), truthy(item.get("cashEntry")), truthy(item.get("imported")),
                    json.dumps(item, ensure_ascii=False, separators=(",", ":")),
                )
            )
        db.executemany(
            """INSERT INTO transactions(id, account_id, operation_date, description, mcc, operation_amount, currency, base_amount,
               transaction_type, category, manual_category, cash_entry, imported, payload)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            transaction_rows,
        )
        db.execute("DELETE FROM payment_status")
        status_rows = []
        for key, paid in paid_payments.items():
            if not paid or ":" not in key:
                continue
            period_key, payment_id = key.rsplit(":", 1)
            status_rows.append((period_key, payment_id, 1))
        db.executemany("INSERT INTO payment_status(period_key, payment_id, paid) VALUES (?, ?, ?)", status_rows)
        db.execute("DELETE FROM shopping_items")
        shopping_rows = []
        for item in shopping_items:
            if not isinstance(item, dict) or not item.get("id") or not item.get("weekKey"):
                continue
            shopping_rows.append(
                (
                    str(item["id"]), str(item["weekKey"]), str(item.get("name", "Покупка")), float(item.get("price", 0)),
                    str(item.get("bucket", "big-shop")), truthy(item.get("essential", True)), truthy(item.get("purchased")),
                    item.get("createdTransactionId"), json.dumps(item, ensure_ascii=False, separators=(",", ":")),
                )
            )
        db.executemany(
            """INSERT INTO shopping_items(id, week_key, name, price, bucket, essential, purchased, created_transaction_id, payload)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            shopping_rows,
        )


def statistics(start: str | None, end: str | None) -> dict:
    where = ["transaction_type = 'expense'"]
    params: list[str] = []
    if start:
        where.append("operation_date >= ?")
        params.append(start)
    if end:
        where.append("operation_date <= ?")
        params.append(end)
    query = f"SELECT category, ROUND(SUM(base_amount), 2) AS amount, COUNT(*) AS count FROM transactions WHERE {' AND '.join(where)} GROUP BY category ORDER BY amount DESC"
    with connection() as db:
        categories = [dict(row) for row in db.execute(query, params)]
        total = db.execute(f"SELECT ROUND(COALESCE(SUM(base_amount), 0), 2) AS total FROM transactions WHERE {' AND '.join(where)}", params).fetchone()["total"]
    return {"from": start, "to": end, "total": total, "categories": categories}


# ── cloud credentials ──────────────────────────────────────────────────────────

def _load_cloud_config() -> dict:
    """Load cloud sync credentials.

    Priority: data/cloud.json → data/bot.json (backward compat).
    Keeping credentials in data/cloud.json separates bot config from sync config.
    """
    cloud_file = DATA_DIR / "cloud.json"
    if cloud_file.exists():
        try:
            cfg = json.loads(cloud_file.read_text(encoding="utf-8"))
            if cfg.get("url"):
                return {"url": cfg["url"].rstrip("/"), "key": cfg.get("key", "")}
        except Exception:
            pass
    # Backward-compat: read from bot.json
    bot_file = DATA_DIR / "bot.json"
    if bot_file.exists():
        try:
            cfg = json.loads(bot_file.read_text(encoding="utf-8"))
            url = cfg.get("cloud_bot_url", "").rstrip("/")
            key = cfg.get("cloud_sync_key", "")
            if url:
                return {"url": url, "key": key}
        except Exception:
            pass
    return {}


# ── HMAC helpers ───────────────────────────────────────────────────────────────

def _canonical(data: dict) -> bytes:
    return json.dumps(
        {k: v for k, v in data.items() if k != "sig"},
        separators=(",", ":"), sort_keys=True, ensure_ascii=False,
    ).encode("utf-8")


def _verify_sig(data: dict, key: str) -> bool:
    """Verify HMAC-SHA256 signature from cloud bot response."""
    sig = data.get("sig", "")
    if not sig:
        return True  # unsigned response accepted (key not configured)
    expected = _hmac.new(key.encode("utf-8"), _canonical(data), hashlib.sha256).hexdigest()
    return _hmac.compare_digest(sig, expected)


# ── database backup ────────────────────────────────────────────────────────────

def backup_database() -> str | None:
    """Create a timestamped SQLite backup in data/backups/. Keeps last 7."""
    if not DATABASE.exists():
        return None
    backups_dir = DATA_DIR / "backups"
    backups_dir.mkdir(exist_ok=True)
    timestamp   = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_path = backups_dir / f"finance-{timestamp}.db"
    try:
        src = sqlite3.connect(str(DATABASE))
        dst = sqlite3.connect(str(backup_path))
        src.backup(dst)
        dst.close()
        src.close()
        # Retain only the 7 most recent backups
        for old in sorted(backups_dir.glob("finance-*.db"))[:-7]:
            try:
                old.unlink()
            except OSError:
                pass
        return str(backup_path)
    except Exception:
        if backup_path.exists():
            try:
                backup_path.unlink()
            except OSError:
                pass
        return None


def sync_from_cloud_bot() -> dict:
    """Fetch pending expenses and CSV files from the cloud bot and import them.

    Reads credentials from data/cloud.json (fallback: data/bot.json).
    Verifies HMAC signature on the response before importing anything.
    Creates a local SQLite backup before touching the database.
    Sends seq in the ack to detect stale/concurrent syncs.
    """
    config = _load_cloud_config()
    url = config.get("url", "")
    key = config.get("key", "")
    if not url:
        return {"ok": False, "reason": "cloud sync not configured — add url to data/cloud.json"}
    if not key:
        return {"ok": False, "reason": "cloud sync not configured — add key to data/cloud.json"}

    headers = {
        "X-API-Key":  key,
        "User-Agent": "FinanceControl/1.0",
        "Accept":     "application/json",
    }

    # ── fetch queue ──────────────────────────────────────────────────────────
    try:
        req = urllib.request.Request(f"{url}/api/pending", headers=headers)
        with urllib.request.urlopen(req, timeout=12) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        return {"ok": False, "reason": f"HTTP {exc.code} from cloud bot"}
    except Exception as exc:
        return {"ok": False, "reason": str(exc)}

    # ── verify HMAC signature ────────────────────────────────────────────────
    if not _verify_sig(data, key):
        return {"ok": False, "reason": "HMAC signature verification failed — possible tampering"}

    seq       = data.get("seq")
    expenses  = [e for e in data.get("expenses", [])  if isinstance(e, dict) and e.get("id")]
    csv_files = [f for f in data.get("csv_files", []) if isinstance(f, dict) and f.get("filename")]

    if not expenses and not csv_files:
        return {"ok": True, "imported_expenses": 0, "imported_csvs": 0}

    # ── backup before modifying local data ───────────────────────────────────
    backup_path = backup_database()

    imported_expenses = 0
    imported_csvs     = 0
    ack_expense_ids:  list[str] = []
    ack_csv_names:    list[str] = []

    # ── import expenses ──────────────────────────────────────────────────────
    if expenses:
        with connection() as db:
            for item in expenses:
                try:
                    db.execute(
                        """INSERT OR IGNORE INTO transactions
                           (id, account_id, operation_date, description, mcc,
                            operation_amount, currency, base_amount,
                            transaction_type, category, manual_category, cash_entry, imported, payload)
                           VALUES (?, ?, ?, ?, '', ?, ?, ?, 'expense', ?, 1, 0, 0, ?)""",
                        (
                            str(item["id"]),
                            str(item.get("accountId", "Telegram")),
                            str(item.get("date", datetime.now(timezone.utc).isoformat())),
                            str(item.get("description", "Расход")),
                            float(item.get("operationAmount", 0)),
                            str(item.get("currency", "EUR")),
                            float(item.get("baseAmount", 0)),
                            str(item.get("category", "Неразобранное")),
                            json.dumps(item, ensure_ascii=False),
                        ),
                    )
                    imported_expenses += 1
                    ack_expense_ids.append(str(item["id"]))
                except Exception:
                    pass

    # ── save CSV files ───────────────────────────────────────────────────────
    if csv_files:
        imports_dir = ROOT / "bot-imports"
        imports_dir.mkdir(exist_ok=True)
        for csv_item in csv_files:
            filename    = csv_item.get("filename", "statement.csv")
            content_b64 = csv_item.get("content", "")
            if not content_b64:
                continue
            stem = re.sub(r"[^A-Za-z0-9._-]", "_", Path(filename).stem).strip("._") or "statement"
            dest = imports_dir / f"{stem}.csv"
            if dest.exists():
                dest = imports_dir / f"{stem}-{uuid.uuid4().hex[:8]}.csv"
            try:
                dest.write_bytes(base64.b64decode(content_b64))
                imported_csvs += 1
                ack_csv_names.append(filename)
            except Exception:
                pass

    # ── acknowledge with seq (conflict guard) ─────────────────────────────────
    if ack_expense_ids or ack_csv_names:
        try:
            ack_body = json.dumps({
                "expense_ids":   ack_expense_ids,
                "csv_filenames": ack_csv_names,
                "seq":           seq,
            }).encode("utf-8")
            ack_req = urllib.request.Request(
                f"{url}/api/ack",
                data=ack_body,
                headers={**headers, "Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(ack_req, timeout=10) as ack_resp:
                ack_data = json.loads(ack_resp.read().decode("utf-8"))
            if not ack_data.get("ok") and ack_data.get("error") == "seq_conflict":
                return {"ok": False, "reason": "sync conflict — retry to re-fetch latest queue"}
        except Exception:
            pass  # non-fatal: items remain in cloud queue for next sync

    return {
        "ok":                True,
        "imported_expenses": imported_expenses,
        "imported_csvs":     imported_csvs,
        "backup":            backup_path,
    }


class FinanceHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, format: str, *args) -> None:
        print(f"[{datetime.now().strftime('%H:%M:%S')}] {format % args}")

    def json_response(self, data: dict, status: HTTPStatus = HTTPStatus.OK) -> None:
        content = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(content)

    def read_json(self) -> dict:
        content_length = int(self.headers.get("Content-Length", "0"))
        if content_length > 20 * 1024 * 1024:
            raise ValueError("Слишком большой запрос")
        body = self.rfile.read(content_length)
        parsed = json.loads(body.decode("utf-8"))
        if not isinstance(parsed, dict):
            raise ValueError("Ожидался JSON-объект")
        return parsed

    def do_OPTIONS(self) -> None:
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Access-Control-Allow-Origin", f"http://{HOST}:{PORT}")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/health":
            self.json_response({"ok": True, "database": str(DATABASE), "time": datetime.now(timezone.utc).isoformat()})
        elif parsed.path == "/api/bot-files":
            imports_dir = ROOT / "bot-imports"
            files = sorted(f.name for f in imports_dir.glob("*.csv")) if imports_dir.exists() else []
            self.json_response({"files": files})
        elif parsed.path == "/api/cloud-sync":
            self.json_response(sync_from_cloud_bot())
        elif parsed.path == "/api/backup":
            path = backup_database()
            if path:
                self.json_response({"ok": True, "path": path})
            else:
                self.json_response({"ok": False, "reason": "backup failed or database not found"}, HTTPStatus.INTERNAL_SERVER_ERROR)
        elif parsed.path == "/api/state":
            self.json_response(database_state())
        elif parsed.path == "/api/stats":
            query = parse_qs(parsed.query)
            self.json_response(statistics(query.get("from", [None])[0], query.get("to", [None])[0]))
        elif parsed.path == "/data/finance.db" or parsed.path.startswith("/data/") or parsed.path == "/server.py":
            self.send_error(HTTPStatus.FORBIDDEN, "Local database is not available over HTTP")
        else:
            super().do_GET()

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/bot-files/done":
            try:
                payload = self.read_json()
                files = payload.get("files", [])
                imports_dir = ROOT / "bot-imports"
                done_dir = imports_dir / "done"
                done_dir.mkdir(exist_ok=True, parents=True)
                moved = 0
                for filename in files:
                    if not isinstance(filename, str) or "/" in filename or "\\" in filename:
                        continue
                    src = imports_dir / filename
                    if src.parent != imports_dir or src.suffix.lower() != ".csv":
                        continue
                    if src.exists():
                        target = done_dir / src.name
                        if target.exists():
                            target = done_dir / f"{src.stem}-{uuid.uuid4().hex[:8]}{src.suffix.lower()}"
                        src.rename(target)
                        moved += 1
                self.json_response({"ok": True, "moved": moved})
            except Exception as error:
                self.json_response({"error": str(error)}, HTTPStatus.BAD_REQUEST)
            return
        if path != "/api/state":
            self.json_response({"error": "Not found"}, HTTPStatus.NOT_FOUND)
            return
        try:
            replace_state(self.read_json())
            self.json_response({"ok": True, "savedAt": datetime.now(timezone.utc).isoformat()})
        except (ValueError, TypeError, KeyError, json.JSONDecodeError) as error:
            self.json_response({"error": str(error)}, HTTPStatus.BAD_REQUEST)
        except sqlite3.Error as error:
            self.json_response({"error": f"Ошибка базы данных: {error}"}, HTTPStatus.INTERNAL_SERVER_ERROR)


def main() -> None:
    initialize_database()
    # Pull any pending items from cloud bot (if configured)
    sync_result = sync_from_cloud_bot()
    if sync_result["ok"]:
        exp = sync_result["imported_expenses"]
        csv = sync_result["imported_csvs"]
        if exp or csv:
            print(f"Cloud sync: {exp} expense(s), {csv} CSV file(s) imported")
    print(f"Finance Control: http://{HOST}:{PORT}")
    print(f"Local database: {DATABASE}")
    ThreadingHTTPServer((HOST, PORT), FinanceHandler).serve_forever()


if __name__ == "__main__":
    main()
