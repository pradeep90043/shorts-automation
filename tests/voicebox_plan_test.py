import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
from voicebox_plan import chunk, plan, sentences, split_long  # noqa: E402

HINDI = "दोस्तों, आजकल हर डेवलपर एआई टूल्स इस्तेमाल कर रहा है। एआई कोड लिख सकता है, पर समझना आपको ही पड़ेगा। आप क्या सोचते हो?"

# sentences split on the danda, full stop, question mark and newlines
assert sentences(HINDI) == [
    "दोस्तों, आजकल हर डेवलपर एआई टूल्स इस्तेमाल कर रहा है।",
    "एआई कोड लिख सकता है, पर समझना आपको ही पड़ेगा।",
    "आप क्या सोचते हो?",
]
assert sentences("One. Two!\nThree?") == ["One.", "Two!", "Three?"]

# a long sentence is cut at commas, then spaces, never inside a word, and loses nothing
long_sentence = ", ".join(["alpha beta gamma delta"] * 30)
parts = split_long(long_sentence, 100)
assert all(len(p) <= 100 for p in parts), [len(p) for p in parts]
assert " ".join(parts).replace(", ", " ").split() == long_sentence.replace(", ", " ").split()
assert split_long("a" * 300, 100) == ["a" * 300], "a single word longer than the limit stays whole"

# chunks never exceed the budget (when the sentences allow) and keep every word in order
text = " ".join(f"Sentence number {i} says something useful about code." for i in range(200))
chunks = chunk(text, 240)
assert all(len(c) <= 240 for c in chunks)
assert " ".join(chunks).split() == text.split()

# a 20-minute script (about 17k chars) gets 17 shards, a tiny one gets 1, a huge one is capped at 20
shards = plan(text * 1, max_shards=20, shard_chars=1000)
assert 1 < len(shards) <= 20
assert len(plan("Bas ek chhota sa vaakya.", 20)) == 1
huge = plan(text * 10, max_shards=20, shard_chars=1000)
assert len(huge) == 20, len(huge)

# order is preserved: names sort back into the script, and no chunk is lost or duplicated
names = [l["name"] for sh in huge for l in sh]
assert names == sorted(names) and len(names) == len(set(names))
assert " ".join(l["text"] for sh in huge for l in sh).split() == (text * 10).split()
# no empty shard, and the load is balanced (largest shard at most about 2x the average)
sizes = [sum(len(l["text"]) for l in sh) for sh in huge]
assert min(sizes) > 0 and max(sizes) <= 2 * (sum(sizes) / len(sizes)), sizes

print("✓ voicebox plan")
