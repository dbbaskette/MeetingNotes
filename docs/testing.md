# MeetingNotes Manual Smoke Test

Run before every release.

## Preflight
- [ ] LM Studio running at configured URL
- [ ] LM Studio has a Whisper model and a chat LLM loaded
- [ ] Sidecar venv installed (`sidecar/.venv/bin/python` exists)
- [ ] `HF_TOKEN` env var set for pyannote
- [ ] Audio Hijack installed with a "Meeting" session

## Test flow
1. [ ] Launch app — Library view appears, no crashes
2. [ ] Open Settings, verify LM Studio models populate the dropdowns
3. [ ] Click Record — recording overlay shows, Audio Hijack starts
4. [ ] Click Stop — overlay closes, new meeting appears in Library with "TRANSCRIBING" pill
5. [ ] Watch meeting advance: transcribing → diarizing → merging → identifying → summarizing → extracting → DONE
6. [ ] Open meeting; verify Summary, Transcript, Audio tabs all render
7. [ ] Identify one unknown speaker via right-rail input; verify roster updates and re-running identification matches them
8. [ ] Click "→ Apple Reminders" — verify reminders appear in the "MeetingNotes" list
9. [ ] Click "↓ Markdown" — verify `<meeting-folder>/exports/action-items.md` is created
10. [ ] Re-run summary — verify `summary.md` is regenerated
11. [ ] Quit the app mid-processing; relaunch; verify the meeting resumes from the last completed stage
12. [ ] Check `~/Library/Logs/MeetingNotes/app.log` has JSON-lines entries
