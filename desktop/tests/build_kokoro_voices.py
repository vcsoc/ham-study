"""Generate labels in the pinned Kokoro export's actual speaker order.

Usage: python tests/build_kokoro_voices.py generate_voices_bin.py upstream-voices.json
The first input is sherpa-onnx's scripts/kokoro/v1.0/generate_voices_bin.py;
its literal id2speaker map is read with ast, never executed. The second is
https://huggingface.co/api/models/hexgrad/Kokoro-82M/tree/main/voices.
"""
import ast
import json
from pathlib import Path
import sys

module = ast.parse(Path(sys.argv[1]).read_text())
speakers = next(ast.literal_eval(node.value) for node in module.body
                if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == 'id2speaker' for target in node.targets))
upstream = {Path(entry['path']).stem for entry in json.loads(Path(sys.argv[2]).read_text()) if entry['path'].endswith('.pt')}
assert set(speakers.values()) == upstream, 'Export must include every upstream voice'
languages = {'a': 'US English', 'b': 'UK English', 'e': 'Spanish', 'f': 'French', 'h': 'Hindi', 'i': 'Italian', 'j': 'Japanese', 'p': 'Brazilian Portuguese', 'z': 'Mandarin Chinese'}
voices = [{'speaker': index, 'code': code, 'name': code.split('_', 1)[1].replace('_', ' ').title(),
           'gender': {'f': 'Female', 'm': 'Male'}[code[1]], 'language': languages[code[0]]}
          for index, code in sorted(speakers.items())]
assert [voice['speaker'] for voice in voices] == list(range(len(voices)))
output = Path(__file__).resolve().parents[1] / 'src-tauri/speech/kokoro-voices.json'
output.write_text(json.dumps(voices, indent=2) + '\n')
print(f'Wrote all {len(voices)} upstream voices to {output}')
