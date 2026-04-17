# Samples

- `short-meeting.mp3` — 5s synthetic audio (two tones) used in contract tests.
  Regenerate with: `ffmpeg -y -f lavfi -i "sine=frequency=200:duration=2.5" -f lavfi -i "sine=frequency=500:duration=2.5" -filter_complex "[0][1]concat=n=2:v=0:a=1" samples/short-meeting.mp3`
- `short-meeting.expected.json` — schema contract both sides must conform to.
