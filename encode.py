#!/usr/bin/env python3
"""Прячет субтитры в звуковую дорожку видео/аудио так, чтобы на слух разницы не было.

    python encode.py video.mp4 out.mp4 --srt subs.srt [--id 3]
    python encode.py song.mp3 out.mp3 --text "Привет" --every 10    # только ультразвук

Два канала (параметры — в web/protocol.json, их же читает браузерный декодер):

  watermark  — неслышимый водяной знак в полосе 1–9 кГц: амплитуды мелких частотных ячеек
               чуть меняются (±1 дБ) по псевдослучайному узору; в пределах критической полосы
               слуха изменения взаимно гасятся. Несёт только «ролик №id, время t» — текст
               реплик телефон берёт с локального сервера (web/videos/<id>.json).
  ultrasound — сам текст реплики, ~17.9–19.7 кГц (взрослые не слышат). Исходный звук в этой
               полосе вырезается.
"""
import argparse
import json
import os
import re
import subprocess
import sys

import numpy as np
from reedsolo import RSCodec
from scipy.signal import butter, sosfiltfilt

SR = 48000
HERE = os.path.dirname(os.path.abspath(__file__))
PROTO = json.load(open(os.path.join(HERE, "web", "protocol.json")))
VIDEO_EXT = {".mp4", ".mov", ".mkv", ".webm", ".m4v"}


def ramp(n, fade):
    f = max(1, round(fade * SR))
    env = np.ones(n)
    r = 0.5 - 0.5 * np.cos(np.linspace(0, np.pi, f))
    env[:f] = r
    env[-f:] = r[::-1]
    return env


# ======================= ультразвуковой канал: текст целиком =======================

class Ultrasound:
    def __init__(self, P):
        self.P = P
        self.sym_n = round(P["sym"] * SR)
        self.step_n = self.sym_n + round(P["guard"] * SR)
        self.chirp_n = round(P["chirp"] * SR)
        self.gap_n = round(P["gap"] * SR)
        self.freqs = [[P["base"] + P["spacing"] * (g * (P["tones"] + 1) + t) for t in range(P["tones"])]
                      for g in range(P["groups"])]
        self.lo = self.freqs[0][0] - P["spacing"]
        self.hi = self.freqs[-1][-1] + P["spacing"]
        self.hdr_rs = RSCodec(P["hdr_nsym"])
        self.body_rs = RSCodec(P["body_nsym"])

    def chirp(self):
        t = np.arange(self.chirp_n) / SR
        k = (self.hi - self.lo) / self.P["chirp"]
        return np.sin(2 * np.pi * (self.lo * t + 0.5 * k * t * t)) * ramp(self.chirp_n, 0.01)

    def frame(self, text, duration):
        P = self.P
        try:
            payload, flags = text.encode("cp1251"), 1   # кириллица — 1 байт на символ
        except UnicodeEncodeError:
            payload, flags = text.encode("utf-8"), 0
        if len(payload) > P["max_len"]:
            print(f"  ! реплика обрезана до {P['max_len']} байт", file=sys.stderr)
            payload = payload[:P["max_len"]]
        dur = min(65535, max(0, round(duration * 10)))
        hdr = bytes(self.hdr_rs.encode(bytes([len(payload), flags, dur >> 8, dur & 0xFF])))
        body = bytes(self.body_rs.encode(payload))
        nibs = [n for b in hdr + body for n in (b & 15, b >> 4)]
        nibs += [0] * (-len(nibs) % P["groups"])
        n_sym = len(nibs) // P["groups"]
        sig = np.zeros(self.chirp_n + self.gap_n + n_sym * self.step_n)
        sig[:self.chirp_n] = self.chirp()
        t = np.arange(self.sym_n) / SR
        env = ramp(self.sym_n, 0.005) / P["groups"]
        pos = self.chirp_n + self.gap_n
        for i in range(n_sym):
            nib = nibs[i * P["groups"]:(i + 1) * P["groups"]]
            sig[pos:pos + self.sym_n] = sum(np.sin(2 * np.pi * self.freqs[g][nib[g]] * t)
                                            for g in range(P["groups"])) * env
            pos += self.step_n
        return sig

    def embed(self, audio, cues, level, lead, notch):
        frames, prev_end = [], 0
        for start, end, text in cues:
            sig = self.frame(text, max(0.0, end - start) if end else 0.0)
            want = round((start - lead) * SR) - len(sig)   # кадр кончается чуть раньше реплики
            pos = max(want, prev_end + round(0.1 * SR), 0)
            frames.append((pos, sig))
            prev_end = pos + len(sig)
            late = (pos - want) / SR
            print(f"  {start:7.2f}s  ультразвук {len(sig) / SR:4.1f} с  «{text.replace(chr(10), ' / ')[:44]}»"
                  + (f"  (опоздание {late:.1f} с)" if late > 0.3 else ""))
        if prev_end + SR // 2 > len(audio):
            audio = np.vstack([audio, np.zeros((prev_end + SR // 2 - len(audio), 2))])
        if notch:
            sos = butter(8, [self.lo - 150, min(self.hi + 150, SR / 2 - 100)], "bandstop", fs=SR, output="sos")
            audio = sosfiltfilt(sos, audio, axis=0)
        for pos, sig in frames:
            audio[pos:pos + len(sig)] += level * sig[:, None]
        return audio


# ======================= водяной знак: «ролик id, время t» =======================

def xorshift_pn(seed, n):
    """±1 на каждую частотную ячейку; тот же генератор — в decoder.js."""
    x = seed & 0xFFFFFFFF
    out = np.empty(n)
    for i in range(n):
        x ^= (x << 13) & 0xFFFFFFFF
        x ^= x >> 17
        x ^= (x << 5) & 0xFFFFFFFF
        out[i] = 1.0 if (x >> 16) & 1 else -1.0
    return out


def crc16(data):
    crc = 0xFFFF
    for b in data:
        crc ^= b << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) if crc & 0x8000 else crc << 1
            crc &= 0xFFFF
    return crc


class Watermark:
    def __init__(self, P):
        self.P = P
        self.n, self.hop, self.H = P["fft"], P["hop"], P["half_hops"]
        self.n_cells = int((P["fmax"] - P["fmin"]) // P["cell_hz"])
        if P.get("pairs"):
            # соседние ячейки всегда с противоположными знаками: в пределах критической полосы
            # слуха изменения громкости взаимно гасятся даже на низких частотах
            pn = xorshift_pn(P["seed"], (self.n_cells + 1) // 2)
            self.pn = np.array([pn[c >> 1] * (1 if c % 2 == 0 else -1) for c in range(self.n_cells)])
        else:
            self.pn = xorshift_pn(P["seed"], self.n_cells)
        self.msg_bits = len(P["sync"]) + P["id_bits"] + P["time_bits"] + 16
        self.half_n = self.H * self.hop                      # длительность полуслота, сэмплы
        self.msg_n = 2 * self.msg_bits * self.half_n
        self.msg_dur = self.msg_n / SR

    def whiten(self, vid, m):
        """Своя псевдослучайная маска для каждого ролика и каждого сообщения: узоры разных
        роликов и разных моментов времени не похожи друг на друга."""
        seed = self.P["seed"] ^ ((vid * 0x9E3779B1) & 0xFFFFFFFF) ^ ((m * 0x85EBCA6B) & 0xFFFFFFFF)
        return [1 if v > 0 else 0 for v in xorshift_pn(seed, self.msg_bits)]

    def bits(self, vid, m):
        P = self.P
        data = (vid << P["time_bits"]) | (m % (1 << P["time_bits"]))
        crc = crc16(bytes([data >> 8, data & 0xFF]))
        nbits = P["id_bits"] + P["time_bits"]
        raw = (list(P["sync"]) + [(data >> (nbits - 1 - i)) & 1 for i in range(nbits)]
               + [(crc >> (15 - i)) & 1 for i in range(16)])
        return [b ^ w for b, w in zip(raw, self.whiten(vid, m % (1 << P["time_bits"])))]

    def chips(self, vid, m):
        """Манчестер: 1 → (+1, −1), 0 → (−1, +1)."""
        return [c for b in self.bits(vid, m) for c in ((1, -1) if b else (-1, 1))]

    def embed(self, audio, vid, alpha):
        n, hop = self.n, self.hop
        freqs = np.fft.rfftfreq(n, 1 / SR)
        band = (freqs >= self.P["fmin"]) & (freqs < self.P["fmin"] + self.n_cells * self.P["cell_hz"])
        cell = ((freqs[band] - self.P["fmin"]) // self.P["cell_hz"]).astype(int)
        pat = self.pn[cell]                                  # ±1 на каждый бин полосы
        win = np.sqrt(np.hanning(n + 1)[:-1])                # sqrt-Hann: анализ+синтез = Hann
        L = len(audio)
        pad = np.vstack([np.zeros((n, 2)), audio, np.zeros((2 * n, 2))])
        out = np.zeros_like(pad)
        n_frames = (len(pad) - n) // hop + 1
        msg_cache = {}
        B = 512
        for f0 in range(0, n_frames, B):
            fs = np.arange(f0, min(f0 + B, n_frames))
            idx = fs[:, None] * hop + np.arange(n)[None, :]
            # чип кадра — по времени его центра относительно начала дорожки
            centers = fs * hop + n // 2 - n
            slot = np.floor_divide(centers, self.half_n)
            chip = np.zeros(len(fs))
            for i, s in enumerate(slot):
                if s < 0 or s * self.half_n >= L:
                    continue
                m, j = divmod(int(s), 2 * self.msg_bits)
                if m not in msg_cache:
                    msg_cache[m] = self.chips(vid, m)
                chip[i] = msg_cache[m][j]
            for ch in range(2):
                X = np.fft.rfft(pad[idx, ch] * win, axis=1)
                G = np.ones_like(X, dtype=float)
                G[:, band] = np.exp(alpha * pat[None, :] * chip[:, None])
                y = np.fft.irfft(X * G, n, axis=1) * win
                np.add.at(out[:, ch], idx, y)
        return out[n:n + L] / 2.0                            # сумма Hann при hop=n/4 равна 2


# ======================= общее =======================

def parse_time(s):
    h, m, rest = s.replace(".", ",").split(":")
    sec, ms = rest.split(",")
    return int(h) * 3600 + int(m) * 60 + int(sec) + int(ms) / 1000


def parse_srt(path):
    raw = open(path, encoding="utf-8-sig").read().replace("\r", "")
    cues = []
    for block in re.split(r"\n\s*\n", raw.strip()):
        lines = block.split("\n")
        for i, line in enumerate(lines):
            m = re.match(r"(\S+)\s*-->\s*(\S+)", line)
            if m:
                text = re.sub(r"<[^>]+>|\{[^}]+\}", "", "\n".join(lines[i + 1:])).strip()
                if text:
                    cues.append((parse_time(m.group(1)), parse_time(m.group(2)), text))
                break
    return sorted(cues)


def load_audio(path):
    cmd = ["ffmpeg", "-v", "error", "-i", path, "-vn", "-f", "f32le", "-ac", "2", "-ar", str(SR), "-"]
    raw = subprocess.run(cmd, check=True, capture_output=True).stdout
    return np.frombuffer(raw, dtype=np.float32).reshape(-1, 2).astype(np.float64)


def save(inp, out, audio, bitrate):
    ext = os.path.splitext(out)[1].lower()
    pcm = ["-f", "f32le", "-ac", "2", "-ar", str(SR), "-i", "-"]
    if ext in VIDEO_EXT:
        acodec = ["-c:a", "libopus"] if ext == ".webm" else ["-c:a", "aac"]
        cmd = ["ffmpeg", "-v", "error", "-y", "-i", inp, *pcm, "-map", "0:v?", "-map", "1:a",
               "-c:v", "copy", *acodec, "-b:a", bitrate, out]
    elif ext == ".wav":
        cmd = ["ffmpeg", "-v", "error", "-y", *pcm, out]
    else:
        cmd = ["ffmpeg", "-v", "error", "-y", *pcm, "-c:a", "libmp3lame", "-b:a", bitrate, out]
    subprocess.run(cmd, input=audio.astype(np.float32).tobytes(), check=True)


def write_index(vdir):
    """Список роликов для телефона: декодер перебирает только их — так быстрее и надёжнее."""
    items = []
    for f in sorted(os.listdir(vdir)):
        if re.fullmatch(r"\d+\.json", f):
            m = json.load(open(os.path.join(vdir, f)))
            items.append({"id": m["id"], "title": m.get("title", ""), "duration": m.get("duration", 0)})
    json.dump(items, open(os.path.join(vdir, "index.json"), "w"), ensure_ascii=False, indent=1)


def next_free_id(vdir):
    used = {int(f[:-5]) for f in os.listdir(vdir) if re.fullmatch(r"\d+\.json", f)}
    return next(i for i in range(1, 16) if i not in used) if len(used) < 15 else 1


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input", help="исходное видео или аудио")
    ap.add_argument("output", help=".mp4/.mov/.mkv/.webm (видео копируется как есть), .mp3 или .wav")
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--srt", help="субтитры: каждая реплика всплывёт на телефоне в своё время")
    src.add_argument("--text", help="одна строка (только ультразвук), повтор каждые --every с")
    ap.add_argument("--every", type=float, default=10.0)
    ap.add_argument("--mode", choices=["both", "watermark", "ultrasound"], default="both")
    ap.add_argument("--id", type=int, help="номер ролика 1..15 (по умолчанию — первый свободный)")
    ap.add_argument("--alpha", type=float, default=0.1, help="сила водяного знака (0.1 ≈ ±0.9 дБ)")
    ap.add_argument("--level", type=float, default=0.12, help="громкость ультразвука, 0..1")
    ap.add_argument("--no-notch", action="store_true", help="не вырезать ультразвуковую полосу из исходника")
    ap.add_argument("--lead", type=float, default=0.4, help="ультразвук: запас на задержку декодера, с")
    ap.add_argument("--bitrate", default="256k")
    a = ap.parse_args()

    if a.text:
        a.mode = "ultrasound"
    audio = load_audio(a.input)
    total = len(audio) / SR
    cues = parse_srt(a.srt) if a.srt else \
        [(t, 0.0, a.text) for t in np.arange(1.0, max(total - 1.0, 1.5), a.every)]

    if a.mode in ("both", "watermark"):
        wm = Watermark(PROTO["watermark"])
        vdir = os.path.join(HERE, "web", "videos")
        os.makedirs(vdir, exist_ok=True)
        vid = a.id or next_free_id(vdir)
        audio = wm.embed(audio, vid, a.alpha)
        meta = {"id": vid, "title": os.path.basename(a.output), "duration": total,
                "cues": [{"start": s, "end": e, "text": t} for s, e, t in cues]}
        json.dump(meta, open(os.path.join(vdir, f"{vid}.json"), "w"), ensure_ascii=False, indent=1)
        write_index(vdir)
        print(f"водяной знак: ролик #{vid}, метка времени каждые {wm.msg_dur:.2f} с, "
              f"реплики → web/videos/{vid}.json")

    if a.mode in ("both", "ultrasound"):
        us = Ultrasound(PROTO["ultrasound"])
        print(f"ультразвук: {us.lo:.0f}–{us.hi:.0f} Гц")
        audio = us.embed(audio, cues, a.level, a.lead, not a.no_notch)

    peak = np.max(np.abs(audio))
    if peak > 0.99:
        audio *= 0.99 / peak
        print(f"громкость снижена в {peak / 0.99:.2f} раза, чтобы не было клиппинга")
    save(a.input, a.output, audio, a.bitrate)
    print(f"готово → {a.output}")


if __name__ == "__main__":
    main()
