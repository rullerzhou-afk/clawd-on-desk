#!/usr/bin/env python3
"""Generate Clawd's dance track: an 8-bar chiptune rave loop, pure stdlib.

Writes clawd-dance-track.wav (16-bit stereo, 44.1 kHz, seamless loop).
"""
import math
import random
import struct
import wave

SR = 44100
BPM = 125
BEAT = 60.0 / BPM          # seconds per quarter note
STEP = BEAT / 4            # 16th note
BARS = 8
STEPS = BARS * 16
TOTAL = int(STEPS * STEP * SR)

random.seed(23333)  # Clawd's port; deterministic render

NOTES = {"C": 0, "C#": 1, "D": 2, "D#": 3, "E": 4, "F": 5,
         "F#": 6, "G": 7, "G#": 8, "A": 9, "A#": 10, "B": 11}


def freq(name, octave):
    semis = NOTES[name] + (octave + 1) * 12 - 69  # A4 = 440
    return 440.0 * 2 ** (semis / 12)


L = [0.0] * TOTAL
R = [0.0] * TOTAL


def add(buf, start_s, samples):
    i0 = int(start_s * SR)
    for i, v in enumerate(samples):
        j = i0 + i
        if 0 <= j < TOTAL:
            buf[j] += v


def square(f, dur, vol, duty=0.5, decay=6.0):
    n = int(dur * SR)
    out = []
    for i in range(n):
        t = i / SR
        v = vol * (1.0 if (t * f) % 1.0 < duty else -1.0)
        out.append(v * math.exp(-decay * t))
    return out


def triangle(f, dur, vol, decay=3.0):
    n = int(dur * SR)
    out = []
    for i in range(n):
        t = i / SR
        p = (t * f) % 1.0
        v = vol * (4 * abs(p - 0.5) - 1)
        out.append(v * math.exp(-decay * t))
    return out


def kick(vol=0.9):
    n = int(0.12 * SR)
    out = []
    phase = 0.0
    for i in range(n):
        t = i / SR
        f = 160 * math.exp(-25 * t) + 45
        phase += f / SR
        out.append(vol * math.sin(2 * math.pi * phase) * math.exp(-18 * t))
    return out


def snare(vol=0.5):
    n = int(0.11 * SR)
    return [vol * random.uniform(-1, 1) * math.exp(-30 * (i / SR)) for i in range(n)]


def hat(vol=0.22):
    n = int(0.04 * SR)
    return [vol * random.uniform(-1, 1) * math.exp(-90 * (i / SR)) for i in range(n)]


# ---- arrangement -----------------------------------------------------------
# Chords per bar: Am F C G, twice.
PROG = [("A", "minor"), ("F", "major"), ("C", "major"), ("G", "major")] * 2
CHORD = {"minor": [0, 3, 7], "major": [0, 4, 7]}


def chord_freqs(root, quality, octave):
    base = NOTES[root] + (octave + 1) * 12 - 69
    return [440.0 * 2 ** ((base + iv) / 12) for iv in CHORD[quality]]


for bar in range(BARS):
    bar_t = bar * 16 * STEP
    root, qual = PROG[bar]

    for step in range(16):
        t = bar_t + step * STEP

        # drums: four-on-floor kick, snare 2+4, offbeat open-ish hats
        if step % 4 == 0:
            k = kick()
            add(L, t, k)
            add(R, t, k)
        if step in (4, 12):
            s = snare()
            add(L, t, s)
            add(R, t, s)
        if step % 2 == 0:
            h = hat(0.13 if step % 4 == 0 else 0.2)
            add(L, t, h)
            add(R, t, h)

        # bass: driving octave pump on 8ths (triangle, chip style)
        if step % 2 == 0:
            octv = 1 if (step // 2) % 2 == 0 else 2
            b = triangle(freq(root, octv), STEP * 1.8, 0.5, decay=4)
            add(L, t, b)
            add(R, t, b)

    # rave stabs: chord hits on the classic offbeat pattern
    for stab_step in (2, 6, 10, 14):
        t = bar_t + stab_step * STEP
        for i, f in enumerate(chord_freqs(root, qual, 3)):
            st = square(f, STEP * 1.5, 0.16, duty=0.25, decay=8)
            add(L if i % 2 == 0 else R, t, st)
            add(R if i % 2 == 0 else L, t, [v * 0.6 for v in st])

# lead hook, bars 5-8: pentatonic-ish riff over the loop (16th arps)
RIFF = ["A", "C", "E", "A", "G", "E", "C", "E",
        "A", "C", "E", "G", "A", "G", "E", "C"]
for bar in range(4, 8):
    bar_t = bar * 16 * STEP
    for step in range(16):
        note = RIFF[(step + (bar - 4) * 3) % 16]
        octv = 4 if step % 4 != 3 else 5
        m = square(freq(note, octv), STEP * 1.1, 0.14, duty=0.5, decay=10)
        pan = 0.5 + 0.35 * math.sin(step / 16 * 2 * math.pi)
        add(L, bar_t + step * STEP, [v * (1 - pan) for v in m])
        add(R, bar_t + step * STEP, [v * pan for v in m])

# ---- master: soft clip + normalize ----------------------------------------
def master(buf):
    out = [math.tanh(v * 1.2) for v in buf]
    peak = max(abs(v) for v in out) or 1.0
    g = 0.92 / peak
    return [v * g for v in out]


L = master(L)
R = master(R)

with wave.open("/Users/anthony/.clawd/dance/clawd-dance-track.wav", "wb") as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    frames = bytearray()
    for l, r in zip(L, R):
        frames += struct.pack("<hh", int(l * 32767), int(r * 32767))
    w.writeframes(bytes(frames))

print(f"wrote {STEPS * STEP:.2f}s loop @ {BPM} BPM")
