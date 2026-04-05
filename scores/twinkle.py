"""
Twinkle Twinkle Little Star — right hand melody and left hand accompaniment.

Pitches use MIDI note numbers (middle C = 60).
Beats are in quarter-note units from the start of the piece.
Time signature: 4/4, key: C major.
"""

# Right-hand melody: list of (midi_pitch, beat_position)
RIGHT_HAND = [
    # Bar 1: Twin-kle twin-kle
    (60, 0.0),   # C  - Twin-
    (60, 1.0),   # C  - -kle
    (67, 2.0),   # G  - twin-
    (67, 3.0),   # G  - -kle
    # Bar 2: lit-tle star
    (69, 4.0),   # A  - lit-
    (69, 5.0),   # A  - -tle
    (67, 6.0),   # G  - star
    # Bar 3: how I won-der
    (65, 8.0),   # F  - how
    (65, 9.0),   # F  - I
    (64, 10.0),  # E  - won-
    (64, 11.0),  # E  - -der
    # Bar 4: what you are
    (62, 12.0),  # D  - what
    (62, 13.0),  # D  - you
    (60, 14.0),  # C  - are
    # Bar 5: up a-bove the world so high
    (67, 16.0),  # G  - up
    (67, 17.0),  # G  - a-
    (65, 18.0),  # F  - -bove
    (65, 19.0),  # F  - the
    # Bar 6
    (64, 20.0),  # E  - world
    (64, 21.0),  # E  - so
    (62, 22.0),  # D  - high
    # Bar 7: like a dia-mond in the sky
    (67, 24.0),  # G  - like
    (67, 25.0),  # G  - a
    (65, 26.0),  # F  - dia-
    (65, 27.0),  # F  - -mond
    # Bar 8
    (64, 28.0),  # E  - in
    (64, 29.0),  # E  - the
    (62, 30.0),  # D  - sky
    # Bar 9-16: repeat of bars 1-8
    (60, 32.0),
    (60, 33.0),
    (67, 34.0),
    (67, 35.0),
    (69, 36.0),
    (69, 37.0),
    (67, 38.0),
    (65, 40.0),
    (65, 41.0),
    (64, 42.0),
    (64, 43.0),
    (62, 44.0),
    (62, 45.0),
    (60, 46.0),
]

# Left-hand accompaniment
C_BASS  = [48]
C_CHORD = [52, 55]
G_BASS  = [43]
G_CHORD = [47, 50]
F_BASS  = [41]
F_CHORD = [45, 48]

def _two_beat_pattern(bass, chord, start_beat):
    return [(bass, start_beat), (chord, start_beat + 1.0)]

LEFT_HAND = []
for b in [0, 2, 4, 6]:
    LEFT_HAND += _two_beat_pattern(C_BASS, C_CHORD, b)
for b in [8, 10]:
    LEFT_HAND += _two_beat_pattern(F_BASS, F_CHORD, b)
for b in [12, 14]:
    LEFT_HAND += _two_beat_pattern(C_BASS, C_CHORD, b)
for b in [16, 18]:
    LEFT_HAND += _two_beat_pattern(G_BASS, G_CHORD, b)
for b in [20, 22]:
    LEFT_HAND += _two_beat_pattern(C_BASS, C_CHORD, b)
for b in [24, 26]:
    LEFT_HAND += _two_beat_pattern(G_BASS, G_CHORD, b)
for b in [28, 30]:
    LEFT_HAND += _two_beat_pattern(C_BASS, C_CHORD, b)
for (pitches, beat) in list(LEFT_HAND):
    LEFT_HAND.append((pitches, beat + 32.0))

LEFT_HAND.sort(key=lambda x: x[1])
