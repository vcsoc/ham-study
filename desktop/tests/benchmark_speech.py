"""Benchmark the real resident Piper process against study-guide passages.

Usage: python tests/benchmark_speech.py /path/to/piper /path/to/voice.onnx
"""
import json
import pathlib
import subprocess
import sys
import tempfile
import time
import wave
from html.parser import HTMLParser


class Passages(HTMLParser):
    def __init__(self):
        super().__init__()
        self.depth = 0
        self.text = []
        self.passages = []

    def handle_starttag(self, tag, attrs):
        if self.depth:
            self.depth += 1
        elif dict(attrs).get("class") == "question" or tag == "strong":
            self.depth = 1
            self.text = []

    def handle_endtag(self, tag):
        if self.depth:
            self.depth -= 1
            if not self.depth:
                self.passages.append(" ".join("".join(self.text).split()))

    def handle_data(self, data):
        if self.depth:
            self.text.append(data)


parser = Passages()
parser.feed((pathlib.Path(__file__).parent / "../ui/index.html").read_text())
with tempfile.TemporaryDirectory() as directory:
    output = str(pathlib.Path(directory) / "passage.wav")
    started = time.perf_counter()
    process = subprocess.Popen(
        [sys.argv[1], "-m", sys.argv[2], "--json-input", "--sentence_silence", "0", "--quiet"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
    )
    results = []
    try:
        for i, text in enumerate(parser.passages[:40]):
            before = time.perf_counter()
            process.stdin.write(json.dumps({"text": text, "speaker_id": i % 2, "output_file": output}) + "\n")
            process.stdin.flush()
            assert process.stdout.readline().strip() == output
            elapsed = time.perf_counter() - before
            with wave.open(output) as audio:
                duration = audio.getnframes() / audio.getframerate()
            results.append({"generation_s": elapsed, "audio_s": duration})
        print(json.dumps({
            "passages": len(results),
            "first_passage_including_model_load_s": results[0]["generation_s"],
            "total_elapsed_s": time.perf_counter() - started,
            "total_audio_s": sum(r["audio_s"] for r in results),
            "slowest_generation_s": max(r["generation_s"] for r in results),
            "worst_realtime_factor_after_startup": max(r["generation_s"] / r["audio_s"] for r in results[1:]),
        }, indent=2))
        assert all(r["generation_s"] < r["audio_s"] for r in results), "Generation must stay ahead of playback"
    finally:
        process.stdin.close()
        process.wait(timeout=10)
