"""Organization-wide month-to-date spend, from Anthropic's Cost Admin API.

Unlike core/usage.py (only what this app sent), this is the whole org's bill for the month — the
number the Console's billing page shows. Needs ANTHROPIC_ADMIN_KEY (sk-ant-admin...) in .env; a
regular API key is rejected. That key can manage org members and keys, so it is deliberately a
separate variable from ANTHROPIC_API_KEY and is only ever used for this one read-only endpoint.

The API exposes no spend-limit field, so the limit comes from MONTHLY_SPEND_LIMIT (dollars).
The cost endpoint excludes Priority Tier costs, so this can undercount vs. the billing page.
"""

import os
import threading
import time
from datetime import datetime, timezone
from decimal import Decimal

import requests

URL = "https://api.anthropic.com/v1/organizations/cost_report"
TTL = 60  # Anthropic asks for at most ~1 request/minute for sustained polling

_lock = threading.Lock()
_cache: dict = {"at": 0.0, "value": None}


def available() -> bool:
    return bool(os.environ.get("ANTHROPIC_ADMIN_KEY"))


def _month_bounds(now: datetime) -> tuple[datetime, datetime]:
    start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    end = start.replace(year=start.year + 1, month=1) if start.month == 12 else start.replace(month=start.month + 1)
    return start, end


def _fetch(start: datetime, end: datetime) -> Decimal:
    """Sum of every cost line in [start, end), in dollars. Raises RuntimeError with a readable message."""
    headers = {"x-api-key": os.environ["ANTHROPIC_ADMIN_KEY"], "anthropic-version": "2023-06-01",
               "User-Agent": "chess-coach/1.0 (personal spend readout)"}
    params = {"starting_at": start.strftime("%Y-%m-%dT%H:%M:%SZ"),
              "ending_at": end.strftime("%Y-%m-%dT%H:%M:%SZ"), "limit": 31}
    cents = Decimal(0)
    for _ in range(5):  # a month is at most 31 daily buckets = one page; loop only guards pagination
        try:
            r = requests.get(URL, headers=headers, params=params, timeout=15)
        except requests.RequestException as e:
            raise RuntimeError(f"couldn't reach Anthropic: {e}") from e
        if r.status_code in (401, 403):
            raise RuntimeError("the admin key was rejected — it must be an sk-ant-admin… key from an org admin")
        if not r.ok:
            raise RuntimeError(f"Anthropic returned HTTP {r.status_code}")
        body = r.json()
        for bucket in body.get("data", []):
            for item in bucket.get("results", []):
                cents += Decimal(item["amount"])  # decimal string, in cents (USD)
        if not body.get("has_more") or not body.get("next_page"):
            break
        params["page"] = body["next_page"]
    return cents / 100


def month_to_date() -> dict:
    """Never raises: the usage page must still render when this is unavailable."""
    if not available():
        return {"available": False, "reason": "no_key"}
    with _lock:
        if _cache["value"] and time.time() - _cache["at"] < TTL:
            return _cache["value"]
        now = datetime.now(timezone.utc)
        start, end = _month_bounds(now)
        try:
            spent = float(_fetch(start, end))
            value = {"available": True, "spent": round(spent, 2), "resets": end.strftime("%Y-%m-%d"),
                     "limit": _limit(), "as_of": time.time()}
        except (RuntimeError, ValueError, KeyError, ArithmeticError) as e:
            value = {"available": False, "reason": "error", "error": str(e)}
        _cache.update(at=time.time(), value=value)
        return value


def _limit() -> float | None:
    try:
        v = float(os.environ.get("MONTHLY_SPEND_LIMIT", ""))
    except ValueError:
        return None
    return v if v > 0 else None
