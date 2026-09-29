# How to ask the coach questions

Every coach answer is saved to the Lessons library with its position, tags and any "Habit to
build" line, so how you ask decides how useful the library is later. (`CLAUDE.md` has the
mechanics; this is the practical version.)

## Ask like this

- **One concept per question, with the move named.** "What pattern did I miss on move 21, and what
  habit prevents it?" usually yields a pattern name (becomes a tag) and a habit line (shows up
  under 🧠 Habits only).
- **Ask while the relevant position is on the board.** The answer is saved with that position.
- **Use the pattern vocabulary** the library tags on: back rank, fork, pin, skewer, x-ray,
  discovered attack, deflection, zwischenzug, outpost, opposition, removing the defender,
  overloaded, mating net, king safety, open file, tempo… Using these words in the question gets
  the answer tagged and makes search find it.
- **Use the chips (Hint, Test me, My plan?) and reuse exact wording for repeats.** An identical
  question at the same position and colour is answered locally, for free.
- **Ask about the opponent explicitly.** "What is he threatening after Nf3?" / "Where is his king
  going?" — reading the opponent is a recurring gap.
- **Ask for a comparison:** "Compare Nf3 and d4 here."
- **Ask to be tested:** "Quiz me on this position."
- **After a game review, ask about each mistake separately** — one question per mistake.

## Templates

- What pattern did I miss on move __, and what habit prevents it?
- What is he threatening after __?
- What are the plans for both sides in this position?
- Before I take the pawn on __, can he win it back with tempo?
- Is there a check or a forcing capture here before I do anything else?
- In the __ (opening), what do I do if he accepts, and if he declines?

## Don't

- **Vague questions** ("is this good?", "im scred") get generic answers that are hard to tag and
  search.
- **Bundled questions** ("explain the opening, my mistakes and the endgame") give muddled tags and
  an answer you can't find again.
- **"Just give me the move"** when you want to learn — you get the move without the idea.
- **Rephrasing a question you already asked** costs a new API call. Search `/lessons` first.
- **Asking with the wrong move showing** saves the answer against the wrong position.

## Before you ask

Search `/lessons` for two or three words (`back rank`, `Vienna`). Search is AND over word
prefixes, so short queries work best — you may already have the answer.

## Reviewing

Run `.venv/bin/python scripts/lessons_digest.py` for a dated snapshot in `data/digests/` (stats,
draft recurring mistakes, all habits and questions, and very short questions worth rewording).
Promote recurring habits into `prompts/player.md` by hand, generalized.
