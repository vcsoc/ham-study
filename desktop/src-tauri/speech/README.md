# Bundled Speech Metadata

## Piper Voice Names

`piper-voices.json` maps all 904 speaker indices in the pinned `en_US-libritts_r-medium` model to the original LibriVox reader names and gender metadata. The mapping uses the model's `speaker_id_map`, not assumptions about speaker order or how a voice sounds. Voice identifiers remain `piper-0` through `piper-903`; changing labels does not change saved voice selections.

Sources and attribution:

- Piper voice configuration: https://huggingface.co/rhasspy/piper-voices/blob/main/en/en_US/libritts_r/medium/en_US-libritts_r-medium.onnx.json
- LibriSpeech speaker metadata: `LibriSpeech/SPEAKERS.TXT` in https://www.openslr.org/resources/12/train-clean-100.tar.gz
- LibriSpeech, Vassil Panayotov and collaborators: https://www.openslr.org/12/ ; licensed under Creative Commons Attribution 4.0: https://creativecommons.org/licenses/by/4.0/
- This derived table selects and reorders entries to match the model and presents the dataset's F/M field as Female/Male. Names may be reader pseudonyms. These are synthesized model voices, not recordings or endorsements by the readers.

Regenerate the table using `tests/build_piper_voices.py` with the model configuration and the corpus speaker metadata.

## Kokoro Voice Names

`kokoro-voices.json` lists all 54 standard Kokoro v1.0 voices in the pinned sherpa-onnx export's actual speaker order, including the final `em_santa` entry. Labels include the voice name, gender, original language/accent and upstream voice code. These language labels describe the original voices; the study guide continues to supply English text. No language or gender filtering is applied to either dropdown.

Sources:

- Standard Kokoro model and voice pack: https://huggingface.co/hexgrad/Kokoro-82M (Apache-2.0).
- Runtime speaker order: https://github.com/k2-fsa/sherpa-onnx/blob/master/scripts/kokoro/v1.0/generate_voices_bin.py
- Voice-file catalogue: https://huggingface.co/api/models/hexgrad/Kokoro-82M/tree/main/voices
- Installed model archive: https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-int8-multi-lang-v1_0.tar.bz2 ; SHA-256 `72c347230107ef8a31098ec4d468a605244beef5f1ed00db97efa13518800653`.

Regenerate with `tests/build_kokoro_voices.py`. It checks that the export mapping includes every upstream voice file. The runtime's reported speaker count determines dropdown length; metadata never caps the number of voices. Named voice IDs are stable across speaker-order changes. Legacy v0.19 numeric selections migrate to the corresponding named voice; the old unnamed default blend maps to Heart.

## Study Pronunciations

`study-lexicon.txt` contains IPA pronunciation data generated for the question-bank vocabulary using the development-time eSpeak NG English-US phonemizer. Regenerate it using `tests/build_study_lexicon.py`. The application uses sherpa-onnx 2.0.1's lexicon frontend; it does not link or run eSpeak NG at runtime. See `src/speech.rs` for number, acronym and unit normalization.
