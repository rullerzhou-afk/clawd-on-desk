#!/usr/bin/env python3
"""Clawd's full dance track — 72-bar chiptune rave song, pure stdlib.

Structure @ 125 BPM, A minor (bars):
  0-7   intro      pads + offbeat hats + sparse kick
  8-15  build      bass pump, stabs, kick joins, snare roll + riser
  16-31 DROP A     full kit, lead riff A with echo
  32-39 breakdown  drums out, pads + gentle arp
  40-47 build 2    bass + stabs return, roll + riser
  48-63 DROP B     everything + lead riff B octave up, open hats
  64-71 outro      elements drop away, fade

Writes clawd-dance-track.wav (16-bit stereo 44.1 kHz, ~2:18).
"""
import math
import random
import struct
import wave

SR = 44100
BPM = 125
BEAT = 60.0 / BPM
STEP = BEAT / 4
BARS = 72
TOTAL = int(BARS * 16 * STEP * SR) + SR  # +1s tail for reverb-ish decay

random.seed(23333)

NOTES = {"C": 0, "C#": 1, "D": 2, "D#": 3, "E": 4, "F": 5,
         "F#": 6, "G": 7, "G#": 8, "A": 9, "A#": 10, "B": 11}


def freq(name, octave):
    return 440.0 * 2 ** ((NOTES[name] + (octave + 1) * 12 - 69) / 12)


# Buses: drums separate from music so drops can sidechain-pump the music.
drumL = [0.0] * TOTAL
drumR = [0.0] * TOTAL
musL = [0.0] * TOTAL
musR = [0.0] * TOTAL

_cache = {}


def add(buf, start_s, samples, gain=1.0):
    i0 = int(start_s * SR)
    for i, v in enumerate(samples):
        j = i0 + i
        if 0 <= j < TOTAL:
            buf[j] += v * gain


def square(f, dur, vol, duty=0.5, decay=6.0):
    key = ("sq", round(f, 2), round(dur, 4), vol, duty, decay)
    if key in _cache:
        return _cache[key]
    n = int(dur * SR)
    out = [vol * (1.0 if (i / SR * f) % 1.0 < duty else -1.0)
           * math.exp(-decay * i / SR) for i in range(n)]
    _cache[key] = out
    return out


def triangle(f, dur, vol, decay=3.0):
    key = ("tri", round(f, 2), round(dur, 4), vol, decay)
    if key in _cache:
        return _cache[key]
    n = int(dur * SR)
    out = []
    for i in range(n):
        t = i / SR
        p = (t * f) % 1.0
        out.append(vol * (4 * abs(p - 0.5) - 1) * math.exp(-decay * t))
    _cache[key] = out
    return out


def pad(f, dur, vol):
    """Two detuned squares, slow attack/release — chip 'pad'."""
    key = ("pad", round(f, 2), round(dur, 4), vol)
    if key in _cache:
        return _cache[key]
    n = int(dur * SR)
    atk = int(0.25 * SR)
    rel = int(0.4 * SR)
    out = []
    for i in range(n):
        t = i / SR
        v = (1.0 if (t * f) % 1.0 < 0.5 else -1.0) \
            + (1.0 if (t * f * 1.006) % 1.0 < 0.5 else -1.0)
        env = min(1.0, i / atk) * min(1.0, (n - i) / rel)
        out.append(vol * 0.5 * v * env)
    _cache[key] = out
    return out


def kick(vol=0.9):
    if "kick" in _cache:
        return [v * vol / 0.9 for v in _cache["kick"]] if vol != 0.9 else _cache["kick"]
    n = int(0.12 * SR)
    out = []
    phase = 0.0
    for i in range(n):
        t = i / SR
        f = 160 * math.exp(-25 * t) + 45
        phase += f / SR
        out.append(0.9 * math.sin(2 * math.pi * phase) * math.exp(-18 * t))
    _cache["kick"] = out
    return out


def snare(vol=0.5):
    n = int(0.11 * SR)
    return [vol * random.uniform(-1, 1) * math.exp(-30 * (i / SR)) for i in range(n)]


def hat(vol=0.22, open_=False):
    n = int((0.11 if open_ else 0.04) * SR)
    d = 35 if open_ else 90
    return [vol * random.uniform(-1, 1) * math.exp(-d * (i / SR)) for i in range(n)]


def riser(start_s, bars=2, vol=0.16):
    n = int(bars * 16 * STEP * SR)
    out = [vol * (i / n) ** 2 * random.uniform(-1, 1) for i in range(n)]
    add(musL, start_s, out, 0.9)
    add(musR, start_s, out, 0.9)


def snare_roll(bar_t):
    """Last-bar 16th roll, rising volume."""
    for s in range(16):
        v = 0.15 + 0.35 * (s / 15)
        sn = snare(v)
        add(drumL, bar_t + s * STEP, sn)
        add(drumR, bar_t + s * STEP, sn)


PROG = [("A", "minor"), ("F", "major"), ("C", "major"), ("G", "major")]
CHORD = {"minor": [0, 3, 7], "major": [0, 4, 7]}


def chord_freqs(root, quality, octave):
    base = NOTES[root] + (octave + 1) * 12 - 69
    return [440.0 * 2 ** ((base + iv) / 12) for iv in CHORD[quality]]


def bar_chord(bar):
    return PROG[bar % 4]


# ---- part writers ----------------------------------------------------------
def put_drums(bar, four_floor=True, snares=True, hats=True, opens=False):
    bar_t = bar * 16 * STEP
    for s in range(16):
        t = bar_t + s * STEP
        if four_floor and s % 4 == 0:
            k = kick()
            add(drumL, t, k)
            add(drumR, t, k)
        if snares and s in (4, 12):
            sn = snare()
            add(drumL, t, sn)
            add(drumR, t, sn)
        if hats and s % 2 == 0:
            h = hat(0.13 if s % 4 == 0 else 0.2, open_=(opens and s in (2, 10)))
            add(drumL, t, h)
            add(drumR, t, h)


def put_bass(bar, vol=0.5, sixteenths=False):
    bar_t = bar * 16 * STEP
    root, _ = bar_chord(bar)
    stride = 1 if sixteenths else 2
    for s in range(0, 16, stride):
        octv = 1 if (s // 2) % 2 == 0 else 2
        b = triangle(freq(root, octv), STEP * 1.8, vol, decay=4)
        add(musL, bar_t + s * STEP, b)
        add(musR, bar_t + s * STEP, b)


def put_stabs(bar, vol=0.16):
    bar_t = bar * 16 * STEP
    root, qual = bar_chord(bar)
    for ss in (2, 6, 10, 14):
        t = bar_t + ss * STEP
        for i, f in enumerate(chord_freqs(root, qual, 3)):
            st = square(f, STEP * 1.5, vol, duty=0.25, decay=8)
            add(musL if i % 2 == 0 else musR, t, st)
            add(musR if i % 2 == 0 else musL, t, st, 0.6)


def put_pads(bar, vol=0.10):
    bar_t = bar * 16 * STEP
    root, qual = bar_chord(bar)
    for i, f in enumerate(chord_freqs(root, qual, 3)):
        p = pad(f, 16 * STEP, vol)
        add(musL, bar_t, p, 1.0 if i % 2 == 0 else 0.7)
        add(musR, bar_t, p, 0.7 if i % 2 == 0 else 1.0)


RIFF_A = ["A", "C", "E", "A", "G", "E", "C", "E",
          "A", "C", "E", "G", "A", "G", "E", "C"]
RIFF_B = ["A", "E", "A", "C", "D", "C", "A", "G",
          "A", "C", "D", "E", "G", "E", "D", "C"]


def put_lead(bar, riff, base_oct=4, vol=0.14, phrase=0):
    """Lead with a cheap dotted-8th echo for space."""
    bar_t = bar * 16 * STEP
    for s in range(16):
        note = riff[(s + phrase * 3) % 16]
        octv = base_oct if s % 4 != 3 else base_oct + 1
        m = square(freq(note, octv), STEP * 1.1, vol, duty=0.5, decay=10)
        pan = 0.5 + 0.35 * math.sin(s / 16 * 2 * math.pi)
        t = bar_t + s * STEP
        add(musL, t, m, (1 - pan))
        add(musR, t, m, pan)
        # echo: 3 sixteenths later, opposite pan, quieter
        te = t + 3 * STEP
        add(musL, te, m, pan * 0.35)
        add(musR, te, m, (1 - pan) * 0.35)


def put_arp(bar, vol=0.10):
    """Gentle up-down chord arp for the breakdown."""
    bar_t = bar * 16 * STEP
    root, qual = bar_chord(bar)
    fs = chord_freqs(root, qual, 4)
    order = [0, 1, 2, 1, 0, 1, 2, 1, 0, 1, 2, 1, 0, 1, 2, 1]
    for s in range(16):
        m = square(fs[order[s]], STEP * 1.4, vol, duty=0.5, decay=7)
        pan = 0.5 + 0.3 * math.sin((bar * 16 + s) / 32 * 2 * math.pi)
        add(musL, bar_t + s * STEP, m, 1 - pan)
        add(musR, bar_t + s * STEP, m, pan)


# ---- arrangement -----------------------------------------------------------
KICK_BARS = set()  # bars with four-on-floor, for the sidechain pump

# intro 0-7: pads, offbeat hats, kick on downbeat only
for bar in range(0, 8):
    put_pads(bar, 0.11)
    bar_t = bar * 16 * STEP
    k = kick()
    add(drumL, bar_t, k, 0.6)
    add(drumR, bar_t, k, 0.6)
    for s in range(2, 16, 4):
        h = hat(0.14)
        add(drumL, bar_t + s * STEP, h)
        add(drumR, bar_t + s * STEP, h)
    if bar >= 4:
        put_bass(bar, 0.32)

# build 8-15
for bar in range(8, 16):
    put_bass(bar, 0.45)
    put_stabs(bar, 0.12)
    put_pads(bar, 0.08)
    if bar >= 12:
        put_drums(bar, four_floor=True, snares=False)
        KICK_BARS.add(bar)
    else:
        put_drums(bar, four_floor=False, snares=False)
snare_roll(15 * 16 * STEP)
riser(14 * 16 * STEP, bars=2)

# DROP A 16-31
for bar in range(16, 32):
    put_drums(bar, opens=False)
    KICK_BARS.add(bar)
    put_bass(bar, 0.5)
    put_stabs(bar, 0.16)
    put_lead(bar, RIFF_A, 4, 0.14, phrase=(bar - 16) % 4)

# breakdown 32-39: music breathes
for bar in range(32, 40):
    put_pads(bar, 0.13)
    put_arp(bar, 0.10)
    bar_t = bar * 16 * STEP
    for s in range(2, 16, 4):
        h = hat(0.10)
        add(drumL, bar_t + s * STEP, h)
        add(drumR, bar_t + s * STEP, h)

# build 2 40-47
for bar in range(40, 48):
    put_bass(bar, 0.45)
    put_stabs(bar, 0.13)
    put_pads(bar, 0.08)
    if bar >= 44:
        put_drums(bar, four_floor=True, snares=False)
        KICK_BARS.add(bar)
snare_roll(47 * 16 * STEP)
riser(46 * 16 * STEP, bars=2)

# DROP B 48-63: bigger — open hats, 16th bass, riff B octave up
for bar in range(48, 64):
    put_drums(bar, opens=True)
    KICK_BARS.add(bar)
    put_bass(bar, 0.5, sixteenths=(bar >= 56))
    put_stabs(bar, 0.16)
    put_lead(bar, RIFF_B, 5 if bar >= 56 else 4, 0.13, phrase=(bar - 48) % 4)

# outro 64-71: strip down
for bar in range(64, 72):
    put_pads(bar, 0.11)
    if bar < 68:
        put_drums(bar, snares=False)
        KICK_BARS.add(bar)
        put_bass(bar, 0.4)
    if bar < 66:
        put_stabs(bar, 0.10)

# ---- sidechain pump on music bus ------------------------------------------
env = [1.0] * TOTAL
for bar in KICK_BARS:
    for beat in range(4):
        t0 = int((bar * 16 + beat * 4) * STEP * SR)
        dip_len = int(0.30 * BEAT * SR)
        for i in range(dip_len):
            j = t0 + i
            if j < TOTAL:
                duck = 1.0 - 0.45 * math.exp(-6.0 * i / dip_len)
                env[j] = min(env[j], duck)

# ---- mix, fade, master -----------------------------------------------------
fade_start = int(68 * 16 * STEP * SR)
outL, outR = [], []
for i in range(TOTAL):
    l = drumL[i] + musL[i] * env[i]
    r = drumR[i] + musR[i] * env[i]
    if i > fade_start:
        g = max(0.0, 1.0 - (i - fade_start) / (TOTAL - fade_start))
        l *= g
        r *= g
    outL.append(math.tanh(l * 1.2))
    outR.append(math.tanh(r * 1.2))

peak = max(max(abs(v) for v in outL), max(abs(v) for v in outR)) or 1.0
g = 0.92 / peak

with wave.open("/Users/anthony/.clawd/dance/clawd-dance-track.wav", "wb") as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    frames = bytearray()
    for l, r in zip(outL, outR):
        frames += struct.pack("<hh", int(l * g * 32767), int(r * g * 32767))
    w.writeframes(bytes(frames))

print(f"wrote {TOTAL / SR:.1f}s song @ {BPM} BPM ({BARS} bars)")
