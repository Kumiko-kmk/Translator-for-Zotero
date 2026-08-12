from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent


def _load_dotenv(path: Path) -> None:
    """Small dependency-free .env loader used before optional packages import."""
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip("'\""))


@dataclass(slots=True)
class AppConfig:
    database_path: Path
    log_dir: Path
    deepseek_api_key: str = ""
    deepseek_base_url: str = "https://api.deepseek.com"
    deepseek_model: str = "deepseek-v4-flash"

    @property
    def mock_mode(self) -> bool:
        return not bool(self.deepseek_api_key)

    @classmethod
    def from_env(cls, env_path: Path | None = None) -> "AppConfig":
        _load_dotenv(env_path or ROOT / ".env")

        def rooted(name: str, default: str) -> Path:
            candidate = Path(os.getenv(name, default))
            return candidate if candidate.is_absolute() else ROOT / candidate

        return cls(
            database_path=rooted("APP_DATABASE_PATH", "data/pdf_understanding.db"),
            log_dir=rooted("APP_LOG_DIR", "logs"),
            deepseek_api_key=os.getenv("DEEPSEEK_API_KEY", ""),
            deepseek_base_url=os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com").rstrip("/"),
            deepseek_model=os.getenv("DEEPSEEK_MODEL", "deepseek-v4-flash"),
        )

    def ensure_directories(self) -> None:
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        self.log_dir.mkdir(parents=True, exist_ok=True)
