"""Map Piper speaker indices to the original reader names and gender metadata.

Usage: python tests/build_piper_voices.py voice.onnx.json SPEAKERS.TXT
SPEAKERS.TXT is from the OpenSLR LibriSpeech corpus; speaker_id_map is
from the pinned en_US-libritts_r-medium Piper model configuration.
"""
import json
from pathlib import Path
import sys

model = json.loads(Path(sys.argv[1]).read_text())
speakers = {}
for line in Path(sys.argv[2]).read_text().splitlines():
    if not line.strip() or line.startswith(';'):
        continue
    reader, gender, _subset, _minutes, name = (part.strip() for part in line.split('|', 4))
    speakers[reader] = {'name': name, 'gender': {'F': 'Female', 'M': 'Male'}[gender]}

voices = []
for reader, index in sorted(model['speaker_id_map'].items(), key=lambda item: item[1]):
    assert reader in speakers, f'Missing reader metadata: {reader}'
    voices.append({'speaker': index, 'reader_id': reader, **speakers[reader]})
assert len(voices) == model['num_speakers']
assert [voice['speaker'] for voice in voices] == list(range(len(voices)))
output = Path(__file__).resolve().parents[1] / 'src-tauri/speech/piper-voices.json'
output.write_text(json.dumps(voices, ensure_ascii=True, indent=2) + '\n')
print(f'Wrote {len(voices)} mapped voices to {output}')
