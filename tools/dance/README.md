# Clawd Dance

Soundtrack system for Clawd. `clawd-dance.sh` puts Clawd in his headphones-groove
state (via the local state server on 127.0.0.1:23333) and shuffles the album in
`~/.clawd/dance/tracks/`; `clawd-dance chip [min]` plays the homemade chiptune
instead; a minutes argument auto-stops the party.

- `tracks/` — instrumental album generated with Google Lyria 3
  (downtempo, rave, soulful, cinematic ambient, and a West Texas
  modern-western track). Drop any extra mp3s in `~/.clawd/dance/tracks/`
  and the shuffle picks them up.
- `make_song.py` — pure-stdlib chiptune composer (72-bar arrangement:
  intro/build/drop/breakdown/build/drop/outro, sidechain pump, echo).
- `make_track.py` — the original 8-bar loop version.

Install: copy or symlink `clawd-dance.sh` into PATH, put tracks in
`~/.clawd/dance/tracks/`.
