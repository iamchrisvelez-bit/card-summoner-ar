"""Refresh or extend the Yu-Gi-Oh! pack's card data from the YGOPRODeck API.

Usage:
  python3 tools/import_ygoprodeck.py                      # refresh every card already in cards.json
  python3 tools/import_ygoprodeck.py 89631139 "Dark Hole"  # add cards by passcode or exact name

Only card data (names, stats, passcodes) is written. Card art is not downloaded: use your own
scans of cards you own if you want image targets. Existing `model` settings are kept.
API docs: https://ygoprodeck.com/api-guide/ (please respect its rate limits).
"""
import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path

API = "https://db.ygoprodeck.com/api/v7/cardinfo.php"
CARDS = Path(__file__).resolve().parent.parent / "app/games/yugioh/cards.json"
EXTRA_FRAMES = {"fusion", "synchro", "xyz", "link", "fusion_pendulum", "synchro_pendulum", "xyz_pendulum"}


def fetch(query):
    key = "id" if query.isdigit() else "name"
    url = f"{API}?{urllib.parse.urlencode({key: int(query) if key == 'id' else query})}"
    with urllib.request.urlopen(url, timeout=20) as res:
        return json.load(res)["data"][0]


def to_card(api, previous=None):
    frame = api.get("frameType", "normal")
    passcode = f"{api['id']:08d}"
    if frame == "spell":
        typ = "field-spell" if api.get("race") == "Field" else "spell"
    elif frame == "trap":
        typ = "trap"
    else:
        typ = "extra-monster" if frame in EXTRA_FRAMES else "monster"
    stats = {"passcode": passcode, "race": api.get("race", "")}
    if typ in ("monster", "extra-monster"):
        # Link monsters have no level or DEF; use their link rating so tribute rules still read a number.
        stats.update({"level": api.get("level", api.get("linkval", 0)), "atk": api.get("atk", 0),
                      "def": api.get("def", 0), "attribute": api.get("attribute", "")})
    card = {"id": f"ygo-{passcode}", "name": api["name"], "type": typ,
            "frame": frame.split("_")[0] if frame.split("_")[0] in ("normal", "effect", "fusion", "spell", "trap") else "effect",
            "stats": stats}
    if previous and "model" in previous:
        card["model"] = previous["model"]
    elif typ in ("monster", "extra-monster"):
        card["model"] = {"scale": 1.0, "placeholder": True}
    return card


def main(args):
    data = json.loads(CARDS.read_text())
    by_id = {c["id"]: c for c in data["cards"]}
    queries = args or [c["stats"]["passcode"] for c in data["cards"]]
    for q in queries:
        api = fetch(q)
        card = to_card(api, by_id.get(f"ygo-{api['id']:08d}"))
        by_id[card["id"]] = card
        print("ok", card["stats"]["passcode"], card["name"])
    data["cards"] = list(by_id.values())
    CARDS.write_text(json.dumps(data, indent=2) + "\n")


if __name__ == "__main__":
    main(sys.argv[1:])
