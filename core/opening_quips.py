"""One-line reactions to a named opening, e.g. "A Catalan setup. Get ready for the long haul."

Free and instant (no Claude call): the name comes from core/eco.py, the flavour from this table.
Keys match by longest prefix of the opening's name, so a key can be a whole family ("Vienna Game")
or one specific variation ("Sicilian Defense: Najdorf Variation"). Names without an entry get a
generic line built from a nickname, so every named opening still gets a reaction."""

import random

QUIPS: dict[str, list[str]] = {
    # --- e4 e5 and friends
    "Italian Game": ["Italian Game. Classic — bishop on c4 eyeing f7.", "Italian. Old school, and still sharp."],
    "Italian Game: Evans Gambit": ["Evans Gambit! A pawn for tempo — they want a fight."],
    "Ruy Lopez": ["Ruy Lopez. Strap in, this one's a slow burn.", "The Spanish. Centuries of theory behind that bishop."],
    "Ruy Lopez: Berlin Defense": ["The Berlin wall. Good luck winning this one on the queen trade."],
    "Scotch Game": ["Scotch Game. Opening the centre right away — no time to waste."],
    "Vienna Game": ["Vienna Game. Time to get aggressive.", "Vienna — that f4 push is coming, watch e5."],
    "Vienna Gambit": ["Vienna Gambit. They're coming for the kingside."],
    "King's Gambit": ["King's Gambit! Pure 19th-century swashbuckling.", "King's Gambit — expect fireworks, and a wide-open king."],
    "Four Knights Game": ["Four Knights. Symmetrical and sensible — the fight comes later."],
    "Petrov's Defense": ["Petrov. Copying my knight — solid, and hard to crack."],
    "Philidor Defense": ["Philidor. A bit passive, but it holds together."],
    "Bishop's Opening": ["Bishop's Opening. Sneaky — an Italian without the knight commitment."],
    "Center Game": ["Center Game. Queen out early — brave."],
    "Danish Gambit": ["Danish Gambit. Two pawns down for a pile of development — bold."],
    "Ponziani Opening": ["Ponziani. Rare — c3 with ideas of d4."],
    "Bongcloud Attack": ["The Bongcloud. Absolutely unserious. Punish it."],
    "Latvian Gambit": ["Latvian Gambit. Wild, risky — and often unsound."],
    "Elephant Gambit": ["Elephant Gambit. Optimistic!"],
    # --- Sicilian & other e4 replies
    "Sicilian Defense": ["Sicilian. They're playing for a win with Black.", "Sicilian Defense — asymmetry, and a fight all game."],
    "Sicilian Defense: Najdorf Variation": ["The Najdorf. Fischer's favourite — it's going to get sharp."],
    "Sicilian Defense: Dragon Variation": ["The Dragon! Bishop on g7, and a race of attacks."],
    "French Defense": ["French Defense. Solid, but that c8 bishop is going to be jealous.", "French — pawn chains and long manoeuvres ahead."],
    "Caro-Kann Defense": ["Caro-Kann player, I see… solid and patient.", "Caro-Kann. They'd rather grind than gamble."],
    "Scandinavian Defense": ["Scandinavian. Queen out early — hit it with tempo.", "Scandinavian! Straight at the centre."],
    "Pirc Defense": ["Pirc. Let White build a centre, then hit back at it."],
    "Modern Defense": ["Modern Defense. Fianchetto first, questions later."],
    "Alekhine Defense": ["Alekhine's. Bait the pawns forward, then attack them."],
    "Owen Defense": ["Owen's Defense. Rare, hypermodern — b6 and a long diagonal."],
    "Nimzowitsch Defense": ["Nimzowitsch Defense. Offbeat — Nc6 straight away."],
    # --- d4 and Indian systems
    "Queen's Gambit": ["Queen's Gambit. The classic — fight for the centre."],
    "Queen's Gambit Accepted": ["Queen's Gambit Accepted. Free pawn, but give it back gracefully."],
    "Queen's Gambit Declined": ["Queen's Gambit Declined. Sturdy — slow and strategic."],
    "Slav Defense": ["Slav. Rock solid — the c8 bishop stays free."],
    "Semi-Slav Defense": ["Semi-Slav. Complex, and full of sharp theory."],
    "King's Indian Defense": ["King's Indian. Let them have the centre — a kingside attack is coming.", "King's Indian — buckle up, this one gets wild."],
    "Nimzo-Indian Defense": ["Nimzo-Indian. Bishop pins the knight — a classy defence."],
    "Queen's Indian Defense": ["Queen's Indian. Solid, flexible, a touch cautious."],
    "Grünfeld Defense": ["Grünfeld! Give them the centre, then blow it up."],
    "Catalan Opening": ["A Catalan setup. Get ready for the long haul.", "Catalan — that bishop on g2 stares down the board all game."],
    "London System": ["London System. Predictable, but annoyingly solid.", "The London. Bishop out, e3, c3 — you know the drill."],
    "Colle System": ["Colle System. Quiet setup, with a sudden e4 break in mind."],
    "Trompowsky Attack": ["Trompowsky. Bishop out early — nudging the knight."],
    "Torre Attack": ["Torre Attack. Bishop on g5 — a bit of a system player."],
    "Dutch Defense": ["Dutch Defense. Aggressive — f5 and a kingside plan."],
    "Benoni Defense": ["Benoni. Unbalanced — counterplay on the queenside."],
    "Benko Gambit": ["Benko Gambit! A pawn for queenside pressure."],
    "Blackmar-Diemer Gambit": ["Blackmar-Diemer Gambit. Pure aggression — pawn down for open lines."],
    "Richter-Veresov Attack": ["Richter-Veresov. Bishop on g5 and quiet play — an offbeat choice."],
    "Englund Gambit": ["Englund Gambit. All in on move one — very risky."],
    # --- flank openings
    "English Opening": ["English Opening. Flank first, centre later.", "The English — flexible, and it can go anywhere."],
    "Réti Opening": ["Réti. Hypermodern — control the centre from a distance."],
    "Zukertort Opening": ["Zukertort. Flexible Nf3 — keeping the options open."],
    "Bird Opening": ["Bird's Opening. f4 first — an ambitious kingside play."],
    "King's Indian Attack": ["King's Indian Attack. The same setup every game — a plan more than a theory."],
    "Nimzo-Larsen Attack": ["Nimzo-Larsen. b3 and a long diagonal — offbeat."],
    "Polish Opening": ["The Polish — b4! Rare, and a little cheeky."],
    "Grob Opening": ["Grob's Opening. g4 on move one — dare I say, unusual."],
    "Hungarian Opening": ["Hungarian. Quiet, a flexible kingside fianchetto."],
}

# generic lines for names with no entry above; {n} is a nickname ("Pirc", "Semi-Slav")
_DEFENSE = ["A {n} player, I see.", "{n} — noted.", "So it's the {n} today."]
_GAMBIT = ["A gambit — {n}! They want a fight.", "{n}. Material for time — let's see if they can back it up."]
_OTHER = ["{n}. Let's see where this goes.", "Ah, the {n}.", "{n} — noted."]

_SUFFIXES = (" Defense", " Opening", " Game", " Attack", " System", " Gambit")


def nickname(family: str) -> str:
    for s in _SUFFIXES:
        if family.endswith(s) and len(family) > len(s) + 2:
            return family[: -len(s)]
    return family


def pick(name: str) -> dict:
    """{"quip", "key", "flavored"} for an opening name. `key` is the table entry that matched (the
    caller uses it to avoid repeating itself), or the family when the line is generic."""
    keys = [k for k in QUIPS if name == k or name.startswith((k + ":", k + ",", k + " "))]
    if keys:
        key = max(keys, key=len)
        return {"quip": random.choice(QUIPS[key]), "key": key, "flavored": True}
    family = name.split(":")[0].strip()
    n = nickname(family)
    pool = _GAMBIT if "Gambit" in family else _DEFENSE if "Defense" in family else _OTHER
    return {"quip": random.choice(pool).format(n=n), "key": family, "flavored": False}
