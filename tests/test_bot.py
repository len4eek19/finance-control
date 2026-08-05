import tempfile
import unittest
import logging
from pathlib import Path

import bot


class BotHelpersTests(unittest.TestCase):
    def test_telegram_http_loggers_do_not_emit_info_urls(self):
        for logger_name in ("httpx", "httpcore", "telegram.request"):
            self.assertGreaterEqual(logging.getLogger(logger_name).level, logging.WARNING)

    def test_parse_amount_supports_currency_and_decimal_comma(self):
        self.assertEqual(bot.parse_amount("500 грн"), (500.0, "UAH"))
        self.assertEqual(bot.parse_amount("12,5"), (12.5, "EUR"))

    def test_category_keyboard_contains_every_category(self):
        keyboard = bot.cat_keyboard()
        labels = {
            button.text
            for row in keyboard.inline_keyboard
            for button in row
        }
        self.assertTrue(set(bot.CATEGORIES).issubset(labels))
        self.assertIn("❌ Отмена", labels)

    def test_safe_import_path_stays_inside_import_directory(self):
        original_dir = bot.BOT_IMPORTS
        with tempfile.TemporaryDirectory() as temp_dir:
            bot.BOT_IMPORTS = Path(temp_dir)
            first = bot.safe_import_path("../statement.csv")
            first.parent.mkdir(parents=True, exist_ok=True)
            first.touch()
            second = bot.safe_import_path("../statement.csv")
            self.assertEqual(first.parent, Path(temp_dir))
            self.assertEqual(second.parent, Path(temp_dir))
            self.assertNotEqual(first, second)
            self.assertEqual(second.suffix, ".csv")
        bot.BOT_IMPORTS = original_dir


if __name__ == "__main__":
    unittest.main()
