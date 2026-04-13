# Ham2K Portable Logger - PoLo (Voice Logging Fork)

This is a fork of [Ham2K PoLo](https://github.com/ham2k/app-polo) that adds hands-free voice-controlled logging and CW (Morse code) decoding. It uses OpenAI Whisper for speech-to-text, GPT-4o-mini for QSO data extraction, and ggmorse for on-device Morse decoding, enabling continuous voice- and CW-driven contact logging during POTA/SOTA activations and other portable operations.

## Quick Start

### 1. Install

This is an unsigned debug build. On Android, sideload the APK:
- Download the `.apk` file
- On your phone, go to **Settings > Security** and enable **Install from unknown sources** (or allow it per-app when prompted)
- Open the APK to install

### 2. Configure

1. Open PoLo Voice and create or join an operation as normal
2. Go to the **Voice Logging** section in the operation settings
3. Tap **Account** and enter your **OpenAI API key** (needed for Whisper transcription and GPT extraction)
4. Enable the **Voice** control in the secondary controls panel

### 3. Use It

Place your phone next to your radio and tap the **Voice** chip. That's it.

PoLo listens continuously and logs for you:
- It hears callsigns, signal reports, and states from your QSOs and fills the fields automatically
- When it hears **"QSL"**, **"73"**, or **"72"**, it submits the log entry
- When a new callsign is heard while a QSO is in progress, it auto-submits the current entry and starts a new one

### 4. Make Corrections

You have three ways to fix anything:

- **Tap the field** on screen -- voice transcription pauses for that field, type your correction with the keyboard
- **Tap the ticker tape** -- the scrolling decoded text highlights callsigns, signal reports, and states in blue; tap any one to populate the corresponding field
- **Say "Polo"** -- no need to touch the phone at all:
  - *"Polo, fix K6AB, it should be K6ABC"* -- corrects a submitted log entry
  - *"Polo, correct N2YC, the state should be New York"* -- fixes the state on a previous entry
  - *"Polo, the signal report should be five seven nine"* -- corrects the current QSO in progress
  - *"Polo, we are now on 14.314 MHz"* -- changes the operating frequency

### Example Session

> You're running a POTA activation on 20m SSB. You place your phone on the picnic table, tap Voice, and start calling CQ.
>
> A station comes back: *"Whiskey One Alpha Whiskey, you're five nine in Connecticut."*
>
> PoLo fills in: callsign **W1AW**, RST sent **59**, state **CT**.
>
> You reply: *"W1AW, you're five nine too, QSL seventy-three."*
>
> PoLo fills RST received **59** and submits the entry.
>
> Next station: *"Kilo Five Delta Echo Zulu, five nine New Mexico."*
>
> PoLo auto-submits the previous QSO (if it wasn't already) and starts populating **K5DEZ**, **59**, **NM**.
>
> You glance at the log and notice the previous entry says "K5DE" instead of "K5DEZ". Without touching the phone, you say: *"Polo, fix K5DE, it should be K5DEZ."* Done.

## Voice Logging Features

- **Continuous listening** — always-on mic with 10s chunked recording (2s overlap), silence detection
- **Automatic QSO extraction** — GPT-4o-mini extracts callsigns, signal reports, states from transcribed speech
- **Auto-populate fields** — callsign triggers PoLo's lookup pipeline, RST and state fill automatically
- **Auto-submit** — say "QSL" or "seventy-three" to submit the current QSO
- **Field locking** — touch-edit a field and voice stops overwriting it
- **"Polo" voice commands**:
  - **Log correction** — "Polo, fix K6AB, it should be K6ABC" corrects already-submitted entries
  - **Frequency change** — "Polo, we are now on 14.314 MHz" updates the VFO
- **Tappable ticker tape** — decoded text highlights callsigns, signal reports, and states in blue; tap to populate fields

## CW Decoding (In Progress)

- **On-device Morse decoding** — ggmorse C++ library via JNI, phone mic near radio speaker
- **GPT-4o-mini error correction** — reconstructs noisy CW decode like an experienced ham operator
- **CW-aware extraction** — handles cut numbers (5NN=599), split words, stray characters
- **Hybrid approach** — regex for instant RST detection, GPT for callsigns/states/context

## Branch Strategy

- `voice-ssb-only` — Voice/SSB features only (PR 1)
- `voice-logging` — Voice + CW decoding (PR 2, builds on PR 1)

---

The fastest, easiest, bestest way to log your amateur radio operations on the go.

### Our Community

* [Forums](https://forums.ham2k.com) - Please use our forums to report bugs, suggestions and issues in general.

* [Discord](https://discord.gg/rT6B2fP7pU) - Come here for casual discussions, development help and to share your operation photos and videos.

* [Instagram](https://www.instagram.com/ham2kapps/) - Photos and Videos of Ham2K apps in use out in the real world.

* [Documentation](https://polo.ham2k.com/docs/) - Read The Fine Manual

# Install Links

### Official Releases
[![Google Play](https://polo.ham2k.com/google-play-badge-100.png)](https://play.google.com/store/apps/details?id=com.ham2k.polo.beta)
[![AppStore](https://polo.ham2k.com/apple-appstore-badge-100.png)](https://apps.apple.com/us/app/ham2k-portable-logger/id6478713938)

* Android - [Google Play](https://play.google.com/store/apps/details?id=com.ham2k.polo.beta)
* iOS - [AppStore](https://apps.apple.com/us/app/ham2k-portable-logger/id6478713938)

### Test Releases
* Android - [Beta Testing](https://play.google.com/apps/testing/com.ham2k.polo.beta) via Google Play testing
* iOS - [Beta Testing](https://testflight.apple.com/join/TjRq5t5Y) via TestFlight

This app is Open Source and licensed under the [Mozilla Public License 2.0](./LICENSE)

---

# Notes for Developers

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup, build workflow, translations, and troubleshooting.
