# Ham Study Desktop

A Tauri version of the Basic study guide. Click a question and choose Read to start there, or choose Read without selecting a question to start at the first question. Double-click a question or answer to read from that passage, including when the reader is stopped. Double-click the passage currently being read to pause or resume it without restarting. The reader skips IDs and interface labels, highlights words, and scrolls them into view. Space pauses or resumes reading; Escape stops it when focus is not in an interactive control.

## Offline Speech

Linux x86-64 and Android use sherpa-onnx 2.0.1 with local Kokoro and Piper models. Reader Settings offers three engine choices:

- Auto: reuses downloaded packs first. If only Piper is downloaded, it uses Piper without attempting another Kokoro download; select Kokoro explicitly to install that pack. Otherwise it tries Kokoro, measures generation speed with a sample question, and selects Piper if Kokoro is unavailable or its measured real-time factor exceeds 0.4. This is a startup estimate, not a guarantee for every passage or device.
- Kokoro: selects Kokoro explicitly, even on hardware where it cannot generate audio faster than playback.
- Piper: selects the lighter Piper model explicitly.

The application keeps one model resident, generates four passages ahead, and preloads their audio before playback reaches them. Questions and answers can use different speakers without reloading the model. Kokoro can still leave gaps when generation is slower than playback: lookahead cannot eliminate a sustained generation backlog. Piper or Auto is preferable for immediate transitions on slower hardware.

Reader Settings has separate question-to-answer and answer-to-next-question delay sliders, each from 250 milliseconds to 15 seconds in 250-millisecond increments, defaulting to 250 ms. Existing saved delays are rounded to the nearest valid step and clamped to this range. Timing is subject to browser and device scheduling. Delays overlap background generation, pause with the reader, and cancel when stopping or jumping to another passage. Slider changes apply to the current wait; double-click resets a slider to its default. Both delays persist across restarts alongside volume, speed, engine, and per-engine voice choices. The information icon at the top of Reader Settings contains the engine/cache help and slider instructions, accessible by hovering, focusing, or tapping/clicking; Escape, a second click, or clicking outside dismisses it.

The question and answer dropdowns always list the active runtime's complete catalogue, without language or gender filtering, and settings shows the number of voices available. The standard Kokoro v1.0 pack provides all 54 upstream voices, with names, gender, language/accent labels and voice codes. Saved choices from the old 11-voice v0.19 model migrate by name. All 904 Piper speakers have reader names and Female/Male labels mapped from the model configuration and original corpus metadata; see `src-tauri/speech/README.md` for attribution and regeneration instructions. Voice IDs remain stable, and selections are remembered separately for each engine. Changing a voice while reading restarts the selected question with the new setting; changing engines stops playback and cancels queued audio.

First use downloads the selected model with SHA-256 verification: approximately 132 MB for Kokoro and 82 MB for Piper. Auto may download both if Kokoro fails its availability or speed check. Subsequent use is offline. Old Qwen and standalone Piper downloads are left untouched. Initial setup, model loading, and the first passage still take time; subsequent transitions use preloaded audio. Generation speed depends on the device.

### Download Persistence And Refresh

Model weights and voice packs persist under the application's data directory (`~/.local/share/ca.hamstudy.desktop/speech-neural-v1` on a standard Linux installation, or the application's private data directory on Android). Restarting the application does not remove them. Cache readiness checks the verified archive marker and required file sizes. An already downloaded, verified archive is also reused if installation was interrupted before extraction completed. Missing or damaged assets may require a repair download; changing the pinned model version may require a new pack.

The recycle/refresh icon beside the Reader Settings heading stops playback and clears unused speech caches. It keeps the active engine's current downloaded pack, both selected voice choices, cached generated audio for those voices, and the shared study lexicon. It removes other engines' managed model directories and download artifacts, obsolete model versions, legacy Qwen/standalone-Piper caches, and cached generated audio for unselected voices. With Auto selected, it preserves the engine currently resolved by Auto instead of switching engines during cleanup.

Both engines store their speakers together in shared model/voice files. Those files must remain intact for the selected voices to work; individual unused speakers cannot be deleted from the active pack. The complete active voice catalogue remains available. Other engine packs download again if selected later. Saved voice preferences for other engines are not erased.

After cleanup, the button rescans engine availability and downloaded status, reloads the preserved engine, and repopulates both complete dropdowns while retaining selections. Engine options show which packs remain downloaded. Cleanup is limited to application-owned cache paths and refuses to run if the selected engine/voices are invalid or the active pack is incomplete. The button does not update the runtime software version.

The lexicon frontend includes pronunciations for the study-bank vocabulary and normalizes numbers, common units and radio acronyms. The application does not link or run eSpeak NG at runtime. A test checks that every question-bank passage has the required vocabulary.

## Build And Run

Start the installed Linux application from the application menu or run `ham-study` (`~/.local/bin/ham-study`). Close existing windows and reopen the application after installing an update.

To build from source, install the Tauri 2 prerequisites and run:

```sh
cd desktop
npm install
npm run build
```

Android builds additionally require the Android SDK, NDK, JDK and appropriate Rust targets:

```sh
npm run tauri -- android build --target aarch64 --apk
```

The sherpa-onnx Rust dependency downloads its platform libraries at build time and copies Android shared libraries into the generated project's ignored `jniLibs` directory. Models download to application data on first use, not into the APK. Android builds still need signing before installation.

## Limitations

Android speech has not been tested on a physical device. Windows and macOS speech are not enabled. Speech reads a selected question-bank category, not simulator results or About. Word highlighting is estimated from passage duration, not actual speech alignment. Pause takes effect immediately during playback; Stop discards queued audio and signals generation cancellation. PDF export depends on webview print support.

## Attribution

The runtime is [sherpa-onnx 2.0.1](https://github.com/k2-fsa/sherpa-onnx/releases/tag/v2.0.1), using the [Kokoro INT8 multilingual v1.0](https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-int8-multi-lang-v1_0.tar.bz2) and [Piper en_US libritts_r medium](https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_US-libritts_r-medium.tar.bz2) models. These dependencies and models have their own license terms; the project's noncommercial license does not replace them. Model archives retain their shipped license/model-card files. See `src-tauri/speech/README.md` for speaker metadata attribution. Legacy reference WAV attribution remains in `ui/voices/ATTRIBUTION.txt`.

## Validation

```sh
cargo test --manifest-path src-tauri/Cargo.toml --lib
SPEECH_MODEL_ROOT=/path/to/extracted/models \
  cargo test --manifest-path src-tauri/Cargo.toml --lib -- --ignored --nocapture
PLAYWRIGHT_MODULE=/path/to/playwright node --test tests/reader.test.cjs
```

The browser regression uses generated fixture audio and a mocked native bridge to check prefetching, default and configured transition delays, saved-delay migration to 250 ms steps, pausing/cancelling pending waits, double-click start/pause/resume/jump, accessible desktop/mobile settings help, engine selection, voice labels, per-engine persistence, cancellation, errors, retry and mobile settings layout. The optional real-model test exercises the first and last speaker of both models and checks that Piper generation stays ahead of playback on the test machine. `tests/benchmark_speech.py` is the legacy standalone-Piper benchmark, not a Kokoro benchmark.
