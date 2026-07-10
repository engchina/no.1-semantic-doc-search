from __future__ import annotations

import unittest
from unittest.mock import MagicMock

from app.services.connection_pool_manager import ConnectionPoolManager


class ConnectionPoolManagerTests(unittest.TestCase):
    @staticmethod
    def manager() -> ConnectionPoolManager:
        manager = object.__new__(ConnectionPoolManager)
        manager._pool = MagicMock()
        manager._pool_settings = {}
        manager.MAX_RETRIES = 3
        manager.RETRY_DELAY = 0
        return manager

    def test_query_error_is_not_retried_as_connection_acquisition(self) -> None:
        manager = self.manager()
        connection = manager._pool.acquire.return_value

        with self.assertRaisesRegex(RuntimeError, "query failed"):
            with manager.acquire_connection():
                raise RuntimeError("query failed")

        manager._pool.acquire.assert_called_once_with()
        manager._pool.release.assert_called_once_with(connection)

    def test_connection_acquisition_error_is_still_retried(self) -> None:
        manager = self.manager()
        connection = MagicMock()
        manager._pool.acquire.side_effect = [RuntimeError("temporary"), connection]

        with manager.acquire_connection() as acquired:
            self.assertIs(acquired, connection)

        self.assertEqual(manager._pool.acquire.call_count, 2)
        manager._pool.release.assert_called_once_with(connection)


if __name__ == "__main__":
    unittest.main()
