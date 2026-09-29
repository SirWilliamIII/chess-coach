"""Snapshot of the Lessons library for reviewing your own questions and habits.

  .venv/bin/python scripts/lessons_digest.py

Writes data/digests/lessons-YYYY-MM-DD.md (data/ is gitignored, so this stays local; a same-day
rerun overwrites). Read-only against data/library.sqlite. Sections: stats, a DRAFT "Recurring
mistakes" block for prompts/player.md, every habit line, every question, and a heuristic list of
questions that may be worth rewording. Nothing here edits player.md — promote lines by hand.
"""

import collections
import sqlite3
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "data" / "library.sqlite"
OUT_DIR = ROOT / "data" / "digests"

# Tags that appear on nearly everything, so grouping habits by them says nothing.
GENERIC_TAGS = {"habit", "special", "tactics", "opening", "endgame"}
SHORT_QUESTION_WORDS = 4  # heuristic only: very short questions tend to get generic answers


def fmt_day(ts: float) -> str:
    return time.strftime("%Y-%m-%d", time.localtime(ts))


def cell(s: str, n: int = 110) -> str:
    s = " ".join((s or "").split()).replace("|", "\\|")
    return s if len(s) <= n else s[: n - 1] + "…"


def main() -> None:
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    rows = con.execute("SELECT * FROM entries ORDER BY created_at").fetchall()
    if not rows:
        raise SystemExit("Library is empty — nothing to digest yet.")

    def tags(r):
        return (r["tags"] or "").split()

    questions = [r for r in rows if r["kind"] != "gm alert"]  # gm alerts are the app's, not yours
    habits = [r for r in rows if r["habit"]]
    tag_counts = collections.Counter(t for r in rows for t in tags(r) if t not in GENERIC_TAGS)
    out = [f"# Lessons digest — {fmt_day(time.time())}", "",
           f"{len(rows)} saved answers ({len(questions)} your questions, {len(rows) - len(questions)} GM alerts) · "
           f"{len(habits)} with a habit line · {sum(r['starred'] for r in rows)} starred · "
           f"{fmt_day(rows[0]['created_at'])} → {fmt_day(rows[-1]['created_at'])}", ""]

    out += ["## Stats", "", "**Where you ask:** " + ", ".join(
        f"{m or '?'} {n}" for m, n in collections.Counter(r["mode"] for r in questions).most_common()), "",
        "**Most common pattern tags** (generic ones like `tactics`/`opening` left out): "
        + ", ".join(f"{t} {n}" for t, n in tag_counts.most_common(15)), "",
        "**Questions per day:** " + ", ".join(
            f"{d} {n}" for d, n in sorted(collections.Counter(fmt_day(r["created_at"]) for r in questions).items())), ""]

    # --- draft recurring-mistakes block: newest habits grouped by their most common informative tag
    by_tag: dict[str, list[sqlite3.Row]] = collections.defaultdict(list)
    for r in habits:
        informative = [t for t in tags(r) if t not in GENERIC_TAGS]
        if informative:
            by_tag[max(informative, key=lambda t: tag_counts[t])].append(r)
    out += ["## DRAFT — Recurring mistakes for prompts/player.md", "",
            "_Grouped by pattern tag, biggest groups first, newest habits shown. This is a keyword grouping, "
            "not real clustering: several lines in a group may be the same idea worded differently, and "
            "unrelated ones can share a tag. Pick and merge by hand before pasting._", "",
            "```markdown", "# Recurring mistakes (from my own lessons)", ""]
    for tag, rs in sorted(by_tag.items(), key=lambda kv: -len(kv[1]))[:8]:
        out.append(f"- **{tag}** (came up {len(rs)}×):")
        for r in sorted(rs, key=lambda r: -r["created_at"])[:2]:
            out.append(f"  - {' '.join(r['habit'].split())}")
    out += ["```", ""]

    out += [f"## All habit lines ({len(habits)}, newest first)", ""]
    for r in sorted(habits, key=lambda r: -r["created_at"]):
        where = " · ".join(x for x in (r["position_label"], r["game_label"]) if x)
        out.append(f"- {fmt_day(r['created_at'])} — {' '.join(r['habit'].split())}"
                   + (f"  _({where})_" if where else ""))
    out.append("")

    vague = [r for r in questions if len(r["question"].split()) <= SHORT_QUESTION_WORDS]
    out += [f"## All your questions ({len(questions)}, oldest first)", "",
            "| date | where | question | tags |", "|---|---|---|---|"]
    for r in questions:
        out.append(f"| {fmt_day(r['created_at'])} | {r['mode'] or ''} | {cell(r['question'])} | "
                   f"{' '.join(t for t in tags(r) if t not in GENERIC_TAGS)} |")
    out += ["", f"## Maybe reword next time ({len(vague)}) — heuristic: {SHORT_QUESTION_WORDS} words or fewer", ""]
    out += [f"- {fmt_day(r['created_at'])}: {cell(r['question'], 90)}" for r in vague]
    out += ["", "## Review notes (add these by hand; a rerun on a new day makes a fresh file)", "", "- "]

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    path = OUT_DIR / f"lessons-{fmt_day(time.time())}.md"
    path.write_text("\n".join(out) + "\n")
    print(f"wrote {path.relative_to(ROOT)}  ({len(rows)} entries, {len(habits)} habits, {len(vague)} flagged short)")


if __name__ == "__main__":
    main()
