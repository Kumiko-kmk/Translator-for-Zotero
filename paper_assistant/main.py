from __future__ import annotations

from .config import AppConfig
from .database import Database
from .pipeline import PaperService


def build_service() -> PaperService:
    config = AppConfig.from_env()
    config.ensure_directories()
    database = Database(config.database_path)
    database.initialize()
    config.deepseek_api_key = database.get_setting("deepseek_api_key", config.deepseek_api_key)
    config.deepseek_base_url = database.get_setting("deepseek_base_url", config.deepseek_base_url)
    config.deepseek_model = database.get_setting("deepseek_model", config.deepseek_model)
    return PaperService(config, database)


def main() -> int:
    from .ui import run_desktop

    return run_desktop(build_service())


if __name__ == "__main__":
    raise SystemExit(main())

