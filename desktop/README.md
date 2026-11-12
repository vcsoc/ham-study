# Ham Study Desktop

A Tauri desktop version of the Basic study guide. Click a question and choose Read in the top bar to start there, or choose Read without selecting a question to start at the first question. The reader skips IDs and interface labels, highlights each word, and scrolls it into view. Space pauses or resumes reading and Escape stops it when focus is not in an interactive control.

## Linux x86-64

The application automatically downloads the pinned llama.cpp CPU runtime and Qwen3-TTS model files on first use (approximately 1.5 GB). The reader shows progress for each download, then reports verification and model loading before scrolling to the first spoken passage. It checks SHA-256 hashes, stores the files under the application data directory, starts its own local runtime on a private loopback port, and stops the runtime when the application exits. No separate server setup is needed. First use needs internet and sufficient free disk space and RAM; subsequent use is offline.

The application is installed for the current user as `~/.local/bin/ham-study`, and appears as **Ham Study** in the application menu. Start it from there or run `ham-study`.

To build from source, install the Tauri 2 prerequisites and run:

```sh
cd desktop
npm install
npm run build
```

## Limitations

The experimental ARM64 Android APK uses the phone's Android text-to-speech engine rather than llama.cpp. It lists offline English voices available from that engine and depends on the engine and language data installed on the device. It has not been tested on a device and is signed with a development key, not a production release key. Windows and macOS still need platform-specific speech runtime integration. Speech currently reads a selected question-bank category, not simulator results or About.

The llama.cpp speech API does not provide word-alignment timestamps. The app synthesizes each question and answer separately and estimates word timing from playback duration, so highlighting is approximate. It prefetches the next passage, but CPU generation can be slower than playback and cause pauses between passages. The settings panel controls volume, playback speed, and separate question and answer voices; double-click a slider to reset it. Kathleen and Kristin provide female voice references; John and Bryce provide male voice references. These references were generated with Piper TTS and are shipped with the app; Qwen approximates them, so the result may differ. Source information is in `ui/voices/ATTRIBUTION.txt`. Voice A and Voice B use generated reference samples, cached locally after first use; their gender and pitch are not guaranteed. The default voice may vary between passages. Pause takes effect immediately during playback or after an in-flight synthesis completes; Stop discards the in-flight response but cannot interrupt server-side generation. PDF export depends on webview print support.

The runtime is llama.cpp b12292. The model is `ggml-org/Qwen3-TTS-12Hz-1.7B-Base-GGUF`; see its model card for licence and usage terms.
