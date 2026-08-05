import tempfile
import unittest
from pathlib import Path

import server


class PlanPersistenceTests(unittest.TestCase):
    def test_plans_survive_database_round_trip(self):
        original_data_dir = server.DATA_DIR
        original_database = server.DATABASE
        with tempfile.TemporaryDirectory() as temp_dir:
            server.DATA_DIR = Path(temp_dir)
            server.DATABASE = server.DATA_DIR / "finance.db"
            server.initialize_database()
            server.replace_state({
                "settings": {"categoryLimits": {"Продукты": 500}},
                "payments": server.DEFAULT_PAYMENTS,
                "transactions": [],
                "paidPayments": {},
                "shoppingItems": [],
                "plans": [{
                    "id": "plan-1",
                    "title": "Зимняя одежда",
                    "type": "Одежда",
                    "targetAmount": 400,
                    "savedAmount": 120,
                    "targetDate": "2026-10-01",
                    "status": "active"
                }]
            })
            state = server.database_state()
            self.assertEqual(state["plans"][0]["title"], "Зимняя одежда")
            self.assertEqual(state["settings"]["categoryLimits"]["Продукты"], 500)
        server.DATA_DIR = original_data_dir
        server.DATABASE = original_database


if __name__ == "__main__":
    unittest.main()
