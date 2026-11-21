#!/usr/bin/env python3
"""Строит общий словарь сжатия английского текста: web/vocab.json.

Токены: ~8000 частых слов (wordfreq), знаки препинания, служебные (<END>, <CAP>, <UPPER>,
<SPELL>…<ENDSPELL>) и буквы/цифры для побуквенного написания редких слов.
Каждому токену — длина канонического кода Хаффмана по его частоте; сами коды строит
web/textcodec.js. Словарь фиксированный и общий у передатчика и приёмника.
"""
import heapq
import json
import os
import re

from wordfreq import top_n_list, word_frequency

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
N_WORDS = 30000

freq = {}
for w in top_n_list("en", N_WORDS + 3000):
    if re.fullmatch(r"[a-z]+('[a-z]+)?", w) and len(freq) < N_WORDS:
        freq[w] = word_frequency(w, "en")
total_words = sum(freq.values())
for w in freq:
    freq[w] /= total_words

# служебные и знаки препинания — примерные частоты на слово
special = {"<END>": 0.02, "<CAP>": 0.04, "<UPPER>": 0.002, "<SPELL>": 0.03, "<ENDSPELL>": 0.03}
punct = {".": 0.035, ",": 0.04, "!": 0.004, "?": 0.005, "'": 0.002, '"': 0.004, ":": 0.002, ";": 0.001,
         "-": 0.003, "(": 0.001, ")": 0.001, "&": 0.0003, "/": 0.0005, "@": 0.0002, "#": 0.0002,
         "$": 0.0003, "%": 0.0003, "+": 0.0002, "=": 0.0001, "*": 0.0001, "…": 0.0002, "—": 0.0005}
letters = "etaoinshrdlcumwfgypbvkjxqz"
spell = {}
for i, ch in enumerate(letters):
    spell["#" + ch] = 0.03 * 6 * (0.13 * 0.86 ** i)          # грубо: частоты букв в редких словах
for d in "0123456789":
    spell["#" + d] = 0.004
spell["#'"] = 0.002
alltok = {**special, **punct, **spell, **freq}

# Хаффман: длины кодов
heap = [(f, i, [t]) for i, (t, f) in enumerate(alltok.items())]
heapq.heapify(heap)
length = {t: 0 for t in alltok}
uid = len(heap)
while len(heap) > 1:
    f1, _, a = heapq.heappop(heap)
    f2, _, b = heapq.heappop(heap)
    for t in a + b:
        length[t] += 1
    uid += 1
    heapq.heappush(heap, (f1 + f2, uid, a + b))
assert max(length.values()) <= 30, max(length.values())

# канонический порядок: по длине кода, затем по частоте
order = sorted(alltok, key=lambda t: (length[t], -alltok[t], t))
json.dump({"tokens": order, "lengths": [length[t] for t in order]},
          open(os.path.join(HERE, "web", "vocab.json"), "w"), ensure_ascii=False, separators=(",", ":"))
avg = sum(freq[w] * length[w] for w in freq)
print(f"{len(order)} токенов, длина кода {min(length.values())}–{max(length.values())} бит, "
      f"в среднем {avg:.1f} бит на слово; the={length['the']}, midnight={length['midnight']}")
