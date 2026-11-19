use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use sha2::{Digest, Sha256};
use sherpa_onnx::{GenerationConfig, OfflineTts, OfflineTtsConfig, OfflineTtsKokoroModelConfig, OfflineTtsModelConfig, OfflineTtsVitsModelConfig};
use std::{collections::HashSet, fs, io::Write, path::{Path, PathBuf}, sync::{Arc, LazyLock, Mutex as SyncMutex}, time::{Duration, Instant}};
use tokio::sync::{watch, Mutex};

const MODEL_BASE: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models";
const STUDY_LEXICON: &str = include_str!("../speech/study-lexicon.txt");
static STUDY_WORDS: LazyLock<HashSet<&'static str>> = LazyLock::new(|| STUDY_LEXICON.lines().filter_map(|line| line.split_once(" || ").map(|(word, _)| word)).collect());
static TOKENS: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"[A-Za-z]+(?:'[A-Za-z]+)*|[0-9]+(?:,[0-9]{3})*(?:\.[0-9]+)?|[.!?,;:]").unwrap());
const KOKORO: Model = Model {
    engine: "kokoro", folder: "kokoro-int8-multi-lang-v1_0", size: 132_353_410,
    sha: "72c347230107ef8a31098ec4d468a605244beef5f1ed00db97efa13518800653",
    files: &[("model.int8.onnx", 114_202_993), ("voices.bin", 28_200_960), ("tokens.txt", 687)],
};
const PIPER: Model = Model {
    engine: "piper", folder: "vits-piper-en_US-libritts_r-medium", size: 82_038_311,
    sha: "10dc268f3e371696d721486123e2705a9fc1faa113491979fde4d88dba1f1b1c",
    files: &[("en_US-libritts_r-medium.onnx", 78_529_840), ("tokens.txt", 954)],
};
#[derive(serde::Deserialize)]
struct KokoroVoice { speaker: usize, code: String, name: String, gender: String, language: String }
static KOKORO_VOICES: LazyLock<Vec<KokoroVoice>> = LazyLock::new(|| serde_json::from_str(include_str!("../speech/kokoro-voices.json")).expect("Bundled Kokoro voice metadata must be valid"));
#[derive(Clone, Copy)]
struct Model { engine: &'static str, folder: &'static str, size: u64, sha: &'static str, files: &'static [(&'static str, u64)] }
fn model_is_cached(dir: &Path, model: Model) -> bool {
    let folder = dir.join(model.folder);
    fs::read_to_string(folder.join(".verified")).ok().as_deref() == Some(model.sha)
        && model.files.iter().all(|(name, size)| fs::metadata(folder.join(name)).map(|file| file.is_file() && file.len() == *size).unwrap_or(false))
}
#[derive(Serialize)]
pub struct EngineOption { id: &'static str, name: &'static str, downloaded: bool }
pub fn engines(dir: &Path) -> Vec<EngineOption> {
    let kokoro = model_is_cached(dir, KOKORO);
    let piper = model_is_cached(dir, PIPER);
    vec![
        EngineOption { id: "auto", name: "Auto (speed-tested)", downloaded: kokoro || piper },
        EngineOption { id: "kokoro", name: "Kokoro", downloaded: kokoro },
        EngineOption { id: "piper", name: "Piper", downloaded: piper },
    ]
}
#[derive(Serialize)]
pub struct PruneResult { removed: Vec<String> }
fn prune_files(app_data: &Path, engine: &str, voices: &[String], voice_count: usize) -> Result<PruneResult, String> {
    let keep = match engine { "kokoro" => KOKORO, "piper" => PIPER, _ => return Err("Select a loaded engine before clearing its cache.".into()) };
    if voices.len() != 2 { return Err("Both selected voices must be preserved.".into()); }
    for voice in voices { voice_id(engine, voice, voice_count)?; }
    let dir = app_data.join("speech-neural-v1");
    if !model_is_cached(&dir, keep) { return Err("The active voice pack is incomplete; cache cleanup was not performed.".into()); }
    let mut candidates = Vec::new();
    // These are application-owned cache names, never user-supplied paths.
    for folder in [KOKORO.folder, PIPER.folder, "kokoro-int8-en-v0_19"] {
        if folder == keep.folder { continue; }
        for name in [folder.to_string(), format!("{folder}.tar.bz2"), format!("{folder}.tar.partial"), format!("{folder}-extract")] {
            candidates.push(dir.join(name));
        }
    }
    candidates.extend([app_data.join("speech"), app_data.join("speech-piper-v1")]);
    let mut removed = Vec::new();
    for path in candidates {
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("Could not inspect speech cache: {error}")),
        };
        // Do not follow a cache-root symlink outside the application's data directory.
        if metadata.is_dir() && !metadata.file_type().is_symlink() { fs::remove_dir_all(&path) } else { fs::remove_file(&path) }
            .map_err(|error| format!("Could not clear unused speech cache {}: {error}", path.display()))?;
        removed.push(path.strip_prefix(app_data).unwrap_or(&path).to_string_lossy().into_owned());
    }
    Ok(PruneResult { removed })
}
pub async fn prune_cache(state: &SpeechRuntime, app_data: PathBuf, engine: String, voices: Vec<String>, generation: u64) -> Result<PruneResult, String> {
    state.advance(generation);
    let token = state.generation.subscribe();
    let runtime = state.runtime.clone().lock_owned().await;
    check_generation(&token, generation)?;
    let loaded = runtime.as_ref().ok_or("No engine is loaded; cache was not cleared.")?;
    if loaded.engine != engine { return Err("Engine selection changed; cache was not cleared.".into()); }
    let voice_count = loaded.info.voices.len();
    tokio::task::spawn_blocking(move || {
        // Keep the runtime lock through pruning so another engine cannot load deleted files.
        let _guard = runtime;
        check_generation(&token, generation)?;
        prune_files(&app_data, &engine, &voices, voice_count)
    }).await.map_err(|error| error.to_string())?
}
fn archive_is_verified(path: &Path, expected: &str) -> bool {
    use std::io::Read;
    let Ok(mut file) = fs::File::open(path) else { return false };
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 65536];
    loop {
        match file.read(&mut buffer) { Ok(0) => break, Ok(count) => hash.update(&buffer[..count]), Err(_) => return false }
    }
    format!("{:x}", hash.finalize()) == expected
}
#[derive(Clone, Default, Serialize)]
pub struct SetupProgress { phase: String, label: String, downloaded: u64, total: u64 }
#[derive(serde::Deserialize)]
struct PiperVoice { speaker: usize, reader_id: String, name: String, gender: String }
static PIPER_VOICES: LazyLock<Vec<PiperVoice>> = LazyLock::new(|| serde_json::from_str(include_str!("../speech/piper-voices.json")).expect("Bundled Piper voice metadata must be valid"));
#[derive(Clone, Serialize)]
pub struct Voice { id: String, name: String }
fn voice_name(engine: &str, id: usize) -> String {
    if engine == "kokoro" {
        KOKORO_VOICES.get(id).filter(|voice| voice.speaker == id)
            .map(|voice| format!("{} ({}; {}) - {}", voice.name, voice.gender, voice.language, voice.code))
            .unwrap_or_else(|| format!("Kokoro voice {} (gender unavailable)", id + 1))
    } else {
        PIPER_VOICES.get(id).filter(|voice| voice.speaker == id && !voice.reader_id.is_empty())
            .map(|voice| format!("{} ({}) - Piper {}", voice.name, voice.gender, id + 1))
            .unwrap_or_else(|| format!("Piper voice {} (gender unavailable)", id + 1))
    }
}
fn voice_identifier(engine: &str, id: usize) -> String {
    if engine == "kokoro" {
        return KOKORO_VOICES.get(id).filter(|voice| voice.speaker == id)
            .map(|voice| format!("kokoro-{}", voice.code)).unwrap_or_else(|| format!("kokoro-speaker-{id}"));
    }
    format!("{engine}-{id}")
}
fn voice_catalog(engine: &str, count: usize) -> Vec<Voice> {
    // The runtime's speaker count is authoritative; metadata must never cap the list.
    (0..count).map(|id| Voice { id: voice_identifier(engine, id), name: voice_name(engine, id) }).collect()
}
#[derive(Clone, Serialize)]
pub struct SpeechInfo { pub engine: String, pub voices: Vec<Voice>, pub reason: String, pub realtime_factor: Option<f64> }
struct Loaded { engine: String, tts: OfflineTts, info: SpeechInfo }
pub struct SpeechRuntime {
    runtime: Arc<Mutex<Option<Loaded>>>,
    progress: Arc<SyncMutex<SetupProgress>>,
    generation: watch::Sender<u64>,
}
impl Default for SpeechRuntime {
    fn default() -> Self {
        let (generation, _) = watch::channel(0);
        Self { runtime: Arc::new(Mutex::new(None)), progress: Arc::default(), generation }
    }
}
impl SpeechRuntime {
    pub fn advance(&self, generation: u64) {
        self.generation.send_if_modified(|current| {
            if generation > *current { *current = generation; true } else { false }
        });
    }
    pub fn progress(&self) -> SetupProgress { self.progress.lock().map(|p| p.clone()).unwrap_or_default() }
    fn report(&self, phase: &str, label: &str, downloaded: u64, total: u64) {
        if let Ok(mut p) = self.progress.lock() { *p = SetupProgress { phase: phase.into(), label: label.into(), downloaded, total }; }
    }
}
fn check_generation(cancelled: &watch::Receiver<u64>, generation: u64) -> Result<(), String> {
    if *cancelled.borrow() > generation { Err("Speech request cancelled".into()) } else { Ok(()) }
}
async fn cancelled(cancelled: &mut watch::Receiver<u64>, generation: u64) {
    loop {
        if *cancelled.borrow() > generation || cancelled.changed().await.is_err() { return; }
    }
}

async fn download(state: &SpeechRuntime, path: &Path, url: &str, sha: &str, size: u64, label: &str, mut cancel: watch::Receiver<u64>, generation: u64) -> Result<(), String> {
    let partial = path.with_extension("partial");
    let client = reqwest::Client::builder().timeout(Duration::from_secs(300)).build().map_err(|e| e.to_string())?;
    state.report("download", label, 0, size);
    let operation = async {
        let mut response = client.get(url).send().await.map_err(|e| format!("Model download failed: {e}"))?.error_for_status().map_err(|e| e.to_string())?;
        let mut file = fs::File::create(&partial).map_err(|e| e.to_string())?;
        let mut hash = Sha256::new();
        let mut downloaded = 0;
        while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
            file.write_all(&chunk).map_err(|e| e.to_string())?;
            hash.update(&chunk);
            downloaded += chunk.len() as u64;
            state.report("download", label, downloaded, size);
        }
        drop(file);
        if format!("{:x}", hash.finalize()) != sha { return Err("Speech model failed its SHA-256 integrity check.".into()); }
        fs::rename(&partial, path).map_err(|e| e.to_string())?;
        Ok::<(), String>(())
    };
    let result = tokio::select! {
        result = operation => result,
        _ = cancelled(&mut cancel, generation) => Err("Speech request cancelled".into()),
    };
    if result.is_err() { let _ = fs::remove_file(&partial); }
    result
}

async fn model_files(state: &SpeechRuntime, dir: &Path, model: Model, cancel: watch::Receiver<u64>, generation: u64) -> Result<PathBuf, String> {
    let destination = dir.join(model.folder);
    if model_is_cached(dir, model) {
        state.report("starting", &format!("Using downloaded {} model and voices", model.engine), 0, 0);
        return Ok(destination);
    }
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let archive = dir.join(format!("{}.tar.bz2", model.folder));
    let candidate = archive.clone();
    let verified = tokio::task::spawn_blocking(move || archive_is_verified(&candidate, model.sha)).await.map_err(|e| e.to_string())?;
    check_generation(&cancel, generation)?;
    if !verified {
        download(state, &archive, &format!("{MODEL_BASE}/{}.tar.bz2", model.folder), model.sha, model.size, &format!("{} speech model", model.engine), cancel.clone(), generation).await?;
    }
    state.report("starting", &format!("Installing {} voices", model.engine), 0, 0);
    let staging = dir.join(format!("{}-extract", model.folder));
    let output = destination.clone();
    tokio::task::spawn_blocking(move || {
        if staging.exists() { fs::remove_dir_all(&staging).map_err(|e| e.to_string())?; }
        fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
        let file = fs::File::open(&archive).map_err(|e| e.to_string())?;
        tar::Archive::new(bzip2::read::BzDecoder::new(file)).unpack(&staging).map_err(|e| e.to_string())?;
        fs::write(staging.join(model.folder).join(".verified"), model.sha).map_err(|e| e.to_string())?;
        if output.exists() { fs::remove_dir_all(&output).map_err(|e| e.to_string())?; }
        fs::rename(staging.join(model.folder), &output).map_err(|e| e.to_string())?;
        let _ = fs::remove_dir(&staging);
        let _ = fs::remove_file(&archive);
        Ok::<(), String>(())
    }).await.map_err(|e| e.to_string())??;
    check_generation(&cancel, generation)?;
    Ok(destination)
}

fn load(engine: &str, dir: &Path) -> Result<Loaded, String> {
    let path = |name: &str| Some(dir.join(name).to_string_lossy().into_owned());
    let lexicon = Some(dir.parent().ok_or("Missing speech model parent directory")?.join("study-lexicon.txt").to_string_lossy().into_owned());
    let mut model = OfflineTtsModelConfig { num_threads: 2, provider: Some("cpu".into()), ..Default::default() };
    if engine == "kokoro" {
        model.kokoro = OfflineTtsKokoroModelConfig {
            model: path("model.int8.onnx"), voices: path("voices.bin"), tokens: path("tokens.txt"),
            lexicon: lexicon.clone(), ..Default::default()
        };
    } else {
        model.vits = OfflineTtsVitsModelConfig {
            model: path("en_US-libritts_r-medium.onnx"), tokens: path("tokens.txt"),
            lexicon, ..Default::default()
        };
    }
    let config = OfflineTtsConfig { model, max_num_sentences: 1, silence_scale: 0.0, ..Default::default() };
    let tts = OfflineTts::create(&config).ok_or_else(|| format!("Could not load {engine} speech model."))?;
    let voices = voice_catalog(engine, tts.num_speakers().max(0) as usize);
    if voices.is_empty() { return Err("Speech model has no voices.".into()); }
    let info = SpeechInfo { engine: engine.into(), voices, reason: format!("Using local {engine} speech."), realtime_factor: None };
    Ok(Loaded { engine: engine.into(), tts, info })
}

fn number_words(value: u64) -> String {
    const SMALL: [&str; 20] = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
    const TENS: [&str; 10] = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
    if value < 20 { return SMALL[value as usize].into(); }
    if value < 100 { return format!("{}{}", TENS[(value / 10) as usize], if value % 10 == 0 { String::new() } else { format!(" {}", SMALL[(value % 10) as usize]) }); }
    for (scale, name) in [(1_000_000_000, "billion"), (1_000_000, "million"), (1000, "thousand"), (100, "hundred")] {
        if value >= scale { return format!("{} {name}{}", number_words(value / scale), if value % scale == 0 { String::new() } else { format!(" {}", number_words(value % scale)) }); }
    }
    unreachable!()
}

fn normalize_text(text: &str) -> Result<String, String> {
    let mut expanded = String::new();
    for c in text.chars() {
        let replacement = match c {
            '%' => " percent ", '=' => " equals ", '+' => " plus ", '/' => " per ",
            '\u{00d7}' => " times ", '\u{03a9}' => " ohms ", '\u{00b0}' => " degrees ",
            '\u{00b5}' | '\u{03bc}' => " micro ", '&' => " and ", '<' => " less than ", '>' => " greater than ",
            '\u{2212}' => " minus ", '\u{2019}' => "'", '-' | '(' | ')' | '[' | ']' | '"' => " ",
            _ => { expanded.push(c); continue; }
        };
        expanded.push_str(replacement);
    }
    let mut words = Vec::new();
    for token in TOKENS.find_iter(&expanded).map(|m| m.as_str()) {
        let spoken = if token.as_bytes()[0].is_ascii_digit() {
            let clean = token.replace(',', "");
            let (whole, fraction) = clean.split_once('.').map(|(a, b)| (a, Some(b))).unwrap_or((&clean, None));
            let mut number = whole.parse::<u64>().map(number_words).map_err(|_| "Number is too large for speech.")?;
            if let Some(fraction) = fraction {
                number.push_str(" point");
                for digit in fraction.bytes() { number.push(' '); number.push_str(&number_words((digit - b'0') as u64)); }
            }
            number
        } else {
            match token {
                "MHz" => "megahertz".into(), "kHz" => "kilohertz".into(), "GHz" => "gigahertz".into(), "Hz" => "hertz".into(),
                "dB" | "dBi" | "dBd" => "decibels".into(), "kW" => "kilowatts".into(), "mW" => "milliwatts".into(), "mV" => "millivolts".into(),
                _ if token.len() > 1 && token.len() <= 6 && token.bytes().all(|c| c.is_ascii_uppercase()) && !["NOT", "AND", "OR", "THE", "ON", "OFF", "YES", "NO", "AN", "IS"].contains(&token) => token.chars().map(|c| c.to_ascii_lowercase().to_string()).collect::<Vec<_>>().join(" "),
                _ => token.to_lowercase(),
            }
        };
        for word in spoken.split_whitespace() {
            if word.chars().any(|c| c.is_ascii_alphabetic()) && !STUDY_WORDS.contains(word) {
                return Err(format!("Missing study pronunciation for '{word}'; regenerate the study lexicon."));
            }
        }
        words.push(spoken);
    }
    if words.is_empty() { return Err("No speakable text in passage.".into()); }
    Ok(words.join(" "))
}

fn generate(loaded: &Loaded, text: &str, sid: i32, cancel: watch::Receiver<u64>, generation: u64) -> Result<(Vec<f32>, i32), String> {
    check_generation(&cancel, generation)?;
    let token = cancel.clone();
    let config = GenerationConfig { sid, silence_scale: 0.0, ..Default::default() };
    let text = normalize_text(text)?;
    let audio = loaded.tts.generate_with_config(&text, &config, Some(move |_: &[f32], _: f32| *token.borrow() <= generation)).ok_or("Speech generation failed")?;
    check_generation(&cancel, generation)?;
    if audio.samples().is_empty() || audio.samples().len() > 8 * 1024 * 1024 || audio.sample_rate() <= 0 { return Err("Speech engine returned invalid audio.".into()); }
    Ok((audio.samples().to_vec(), audio.sample_rate()))
}

pub async fn configure(state: &SpeechRuntime, dir: PathBuf, requested: &str, generation: u64, refresh: bool) -> Result<SpeechInfo, String> {
    if !["auto", "kokoro", "piper"].contains(&requested) { return Err("Unknown speech engine.".into()); }
    state.advance(generation);
    let cancel = state.generation.subscribe();
    let mut runtime = state.runtime.clone().lock_owned().await;
    check_generation(&cancel, generation)?;
    let preferred = if requested == "auto" { "kokoro" } else { requested };
    if requested != "auto" && !refresh {
        if let Some(loaded) = runtime.as_mut().filter(|loaded| loaded.engine == preferred) {
            loaded.info.reason = format!("Using downloaded {preferred} model and voices (offline ready).");
            return Ok(loaded.info.clone());
        }
    }
    // Keep inference serialized and only one model resident, especially on Android.
    *runtime = None;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    fs::write(dir.join("study-lexicon.txt"), STUDY_LEXICON).map_err(|e| e.to_string())?;
    let piper_only = requested == "auto" && model_is_cached(&dir, PIPER) && !model_is_cached(&dir, KOKORO);
    let mut fallback_reason = if piper_only { "Auto selected downloaded Piper. Select Kokoro to download its voice pack.".into() } else { String::new() };
    let candidates = if piper_only { vec!["piper"] } else if requested == "auto" { vec!["kokoro", "piper"] } else { vec![preferred] };
    for engine in candidates {
        check_generation(&cancel, generation)?;
        let files = model_files(state, &dir, if engine == "kokoro" { KOKORO } else { PIPER }, cancel.clone(), generation).await;
        let path = match files {
            Ok(path) => path,
            Err(error) if requested == "auto" && engine == "kokoro" => { fallback_reason = format!("Kokoro unavailable: {error}"); continue; }
            Err(error) => return Err(error),
        };
        state.report("starting", &format!("Loading {engine}"), 0, 0);
        let token = cancel.clone();
        let auto = requested == "auto";
        let engine_name = engine.to_string();
        let result = tokio::task::spawn_blocking(move || {
            let mut loaded = load(&engine_name, &path)?;
            check_generation(&token, generation)?;
            if auto && engine_name == "kokoro" {
                let start = Instant::now();
                let (samples, rate) = generate(&loaded, "Which document assigns the authority to make Canadian regulations governing radiocommunications?", 0, token, generation)?;
                loaded.info.realtime_factor = Some(start.elapsed().as_secs_f64() / (samples.len() as f64 / rate as f64));
            }
            Ok::<_, String>(loaded)
        }).await.map_err(|e| e.to_string())?;
        let mut loaded = match result {
            Ok(loaded) => loaded,
            Err(error) if requested == "auto" && engine == "kokoro" => { fallback_reason = format!("Kokoro unavailable: {error}"); continue; }
            Err(error) => return Err(error),
        };
        check_generation(&cancel, generation)?;
        if requested == "auto" && engine == "kokoro" && loaded.info.realtime_factor.unwrap_or(1.0) > 0.4 {
            fallback_reason = "Kokoro's speed check was too slow for continuous reading; using Piper.".into();
            continue;
        }
        loaded.info.reason = if requested != "auto" { format!("Using downloaded {engine} model and voices (offline ready).") }
            else if engine == "kokoro" { "Auto selected Kokoro after a local generation-speed check.".into() }
            else { fallback_reason };
        let info = loaded.info.clone();
        *runtime = Some(loaded);
        state.report("ready", &info.reason, 0, 0);
        return Ok(info);
    }
    Err("No offline speech engine could be loaded.".into())
}

fn voice_id(engine: &str, voice: &str, count: usize) -> Result<i32, String> {
    let id = if engine == "kokoro" {
        voice.strip_prefix("kokoro-").and_then(|code| KOKORO_VOICES.iter().find(|voice| voice.code == code).map(|voice| voice.speaker))
            .or_else(|| voice.strip_prefix("kokoro-speaker-").and_then(|id| id.parse::<usize>().ok()).filter(|id| *id >= KOKORO_VOICES.len()))
    } else {
        voice.strip_prefix(&format!("{engine}-")).and_then(|id| id.parse::<usize>().ok())
    };
    id.filter(|id| *id < count).map(|id| id as i32).ok_or_else(|| "Selected voice does not belong to the active engine.".into())
}
fn wav(samples: &[f32], rate: i32) -> Vec<u8> {
    let length = (samples.len() * 2) as u32;
    let mut bytes = Vec::with_capacity(44 + length as usize);
    bytes.extend_from_slice(b"RIFF"); bytes.extend_from_slice(&(36 + length).to_le_bytes());
    bytes.extend_from_slice(b"WAVEfmt "); bytes.extend_from_slice(&16_u32.to_le_bytes());
    bytes.extend_from_slice(&1_u16.to_le_bytes()); bytes.extend_from_slice(&1_u16.to_le_bytes());
    bytes.extend_from_slice(&(rate as u32).to_le_bytes()); bytes.extend_from_slice(&(rate as u32 * 2).to_le_bytes());
    bytes.extend_from_slice(&2_u16.to_le_bytes()); bytes.extend_from_slice(&16_u16.to_le_bytes());
    bytes.extend_from_slice(b"data"); bytes.extend_from_slice(&length.to_le_bytes());
    for sample in samples { bytes.extend_from_slice(&((sample.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes()); }
    bytes
}
pub async fn synthesize(state: &SpeechRuntime, text: String, voice: String, engine: String, generation: u64) -> Result<String, String> {
    if text.trim().is_empty() || text.chars().count() > 2000 || text.contains('\0') { return Err("Speech segment must contain 1 to 2000 characters, without NUL bytes.".into()); }
    state.advance(generation);
    let cancel = state.generation.subscribe();
    check_generation(&cancel, generation)?;
    let runtime = state.runtime.clone().lock_owned().await;
    check_generation(&cancel, generation)?;
    tokio::task::spawn_blocking(move || {
        let loaded = runtime.as_ref().ok_or("Select a speech engine before reading.")?;
        if loaded.engine != engine { return Err("Speech engine changed; restart reading.".into()); }
        let sid = voice_id(&engine, &voice, loaded.info.voices.len())?;
        let (samples, rate) = generate(loaded, &text, sid, cancel.clone(), generation)?;
        let encoded = STANDARD.encode(wav(&samples, rate));
        check_generation(&cancel, generation)?;
        Ok(encoded)
    }).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn test_directory(name: &str) -> PathBuf {
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("ham-speech-{name}-{}-{stamp}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }
    fn cache_fixture(app_data: &Path, model: Model) {
        let folder = app_data.join("speech-neural-v1").join(model.folder);
        fs::create_dir_all(&folder).unwrap();
        for (name, size) in model.files { fs::File::create(folder.join(name)).unwrap().set_len(*size).unwrap(); }
        fs::write(folder.join(".verified"), model.sha).unwrap();
    }
    #[test]
    fn pruning_preserves_selected_engine_and_shared_voices_only_removes_managed_caches() {
        for (keep, voices) in [(KOKORO, vec!["kokoro-af_bella".into(), "kokoro-em_santa".into()]), (PIPER, vec!["piper-0".into(), "piper-903".into()])] {
            let app_data = test_directory("prune");
            cache_fixture(&app_data, KOKORO);
            cache_fixture(&app_data, PIPER);
            let dir = app_data.join("speech-neural-v1");
            let discard = if keep.engine == "kokoro" { PIPER } else { KOKORO };
            for legacy in [app_data.join("speech"), app_data.join("speech-piper-v1"), dir.join("kokoro-int8-en-v0_19")] {
                fs::create_dir_all(&legacy).unwrap();
                fs::write(legacy.join("old-download"), b"cached").unwrap();
            }
            fs::write(dir.join(format!("{}.tar.bz2", discard.folder)), b"unused archive").unwrap();
            fs::write(dir.join(format!("{}.tar.partial", discard.folder)), b"unused partial").unwrap();
            fs::write(dir.join(format!("{}.tar.bz2", keep.folder)), b"retained archive").unwrap();
            fs::write(dir.join("study-lexicon.txt"), STUDY_LEXICON).unwrap();
            fs::write(dir.join("unrelated-notes.txt"), b"leave alone").unwrap();
            let before = keep.files.iter().map(|(name, _)| fs::metadata(dir.join(keep.folder).join(name)).unwrap().modified().unwrap()).collect::<Vec<_>>();
            let count = if keep.engine == "kokoro" { 54 } else { 904 };
            let result = prune_files(&app_data, keep.engine, &voices, count).unwrap();
            assert!(!result.removed.is_empty());
            assert!(model_is_cached(&dir, keep));
            assert!(!dir.join(discard.folder).exists());
            assert!(!dir.join(format!("{}.tar.bz2", discard.folder)).exists());
            assert!(!dir.join(format!("{}.tar.partial", discard.folder)).exists());
            assert!(dir.join(format!("{}.tar.bz2", keep.folder)).exists());
            assert!(!app_data.join("speech").exists());
            assert!(!app_data.join("speech-piper-v1").exists());
            assert!(!dir.join("kokoro-int8-en-v0_19").exists());
            assert_eq!(fs::read(dir.join("study-lexicon.txt")).unwrap(), STUDY_LEXICON.as_bytes());
            assert_eq!(fs::read(dir.join("unrelated-notes.txt")).unwrap(), b"leave alone");
            let after = keep.files.iter().map(|(name, _)| fs::metadata(dir.join(keep.folder).join(name)).unwrap().modified().unwrap()).collect::<Vec<_>>();
            assert_eq!(before, after);
            assert_eq!(voice_catalog(keep.engine, count).len(), count);
            fs::remove_dir_all(app_data).unwrap();
        }
    }
    #[test]
    fn pruning_refuses_invalid_selections_or_incomplete_active_pack() {
        let app_data = test_directory("prune-validation");
        cache_fixture(&app_data, KOKORO);
        cache_fixture(&app_data, PIPER);
        let dir = app_data.join("speech-neural-v1");
        assert!(prune_files(&app_data, "kokoro", &["kokoro-af_bella".into(), "piper-0".into()], 54).is_err());
        assert!(prune_files(&app_data, "auto", &[], 54).is_err());
        assert!(model_is_cached(&dir, PIPER));
        fs::remove_file(dir.join(KOKORO.folder).join("voices.bin")).unwrap();
        assert!(prune_files(&app_data, "kokoro", &["kokoro-af_bella".into(), "kokoro-em_santa".into()], 54).is_err());
        assert!(model_is_cached(&dir, PIPER));
        fs::remove_dir_all(app_data).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn pruning_does_not_follow_cache_directory_symlinks() {
        let app_data = test_directory("prune-links");
        let outside = test_directory("outside-cache");
        cache_fixture(&app_data, PIPER);
        fs::write(outside.join("keep.txt"), b"not cache").unwrap();
        std::os::unix::fs::symlink(&outside, app_data.join("speech")).unwrap();
        prune_files(&app_data, "piper", &["piper-0".into(), "piper-1".into()], 904).unwrap();
        assert!(!app_data.join("speech").exists());
        assert_eq!(fs::read(outside.join("keep.txt")).unwrap(), b"not cache");
        fs::remove_dir_all(app_data).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }
    #[tokio::test(flavor = "current_thread")]
    async fn downloaded_models_survive_fresh_runtime_instances_without_network() {
        let dir = test_directory("offline-restart");
        let folder = dir.join(PIPER.folder);
        fs::create_dir_all(&folder).unwrap();
        for (name, size) in PIPER.files { fs::File::create(folder.join(name)).unwrap().set_len(*size).unwrap(); }
        fs::write(folder.join(".verified"), PIPER.sha).unwrap();
        for _ in 0..3 {
            let state = SpeechRuntime::default();
            assert!(engines(&dir).iter().find(|engine| engine.id == "piper").unwrap().downloaded);
            let result = model_files(&state, &dir, PIPER, state.generation.subscribe(), 0).await.unwrap();
            assert_eq!(result, folder);
            assert_eq!(state.progress().phase, "starting");
            assert!(!dir.join(format!("{}.tar.bz2", PIPER.folder)).exists());
        }
        fs::remove_file(folder.join("tokens.txt")).unwrap();
        assert!(!model_is_cached(&dir, PIPER));
        assert!(!engines(&dir).iter().find(|engine| engine.id == "piper").unwrap().downloaded);
        fs::remove_dir_all(dir).unwrap();
    }
    #[tokio::test(flavor = "current_thread")]
    async fn interrupted_install_reuses_verified_downloaded_archive() {
        let dir = test_directory("archive-resume");
        let encoder = bzip2::write::BzEncoder::new(Vec::new(), bzip2::Compression::default());
        let mut archive = tar::Builder::new(encoder);
        let mut header = tar::Header::new_gnu();
        header.set_size(7);
        header.set_mode(0o644);
        header.set_cksum();
        archive.append_data(&mut header, "fixture/model.onnx", &b"offline"[..]).unwrap();
        let bytes = archive.into_inner().unwrap().finish().unwrap();
        let hash = Box::leak(format!("{:x}", Sha256::digest(&bytes)).into_boxed_str());
        let model = Model { engine: "fixture", folder: "fixture", size: bytes.len() as u64, sha: hash, files: &[("model.onnx", 7)] };
        fs::write(dir.join("fixture.tar.bz2"), bytes).unwrap();
        let state = SpeechRuntime::default();
        let folder = model_files(&state, &dir, model, state.generation.subscribe(), 0).await.unwrap();
        assert_eq!(fs::read(folder.join("model.onnx")).unwrap(), b"offline");
        assert!(model_is_cached(&dir, model));
        assert_ne!(state.progress().phase, "download");
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn normalizes_radio_units_acronyms_and_numbers() {
        assert_eq!(normalize_text("RF at 146.52 MHz, 1,000 W").unwrap(), "r f at one hundred forty six point five two megahertz , one thousand w");
        assert!(normalize_text("The Radiocommunication Act.").is_ok());
    }
    #[test]
    fn every_bank_passage_has_pronunciations() {
        let html = include_str!("../../ui/index.html");
        let bank = &html[html.find("<div id=\"study-page\">").unwrap()..];
        let html = bank.split("<script").next().unwrap();
        let passages = regex::Regex::new(r#"(?s)<div class="question">(.*?)</div>|<strong>(.*?)</strong>"#).unwrap();
        let tags = regex::Regex::new(r"<[^>]*>").unwrap();
        let mut count = 0;
        for capture in passages.captures_iter(html) {
            let text = capture.get(1).or_else(|| capture.get(2)).unwrap().as_str();
            let text = tags.replace_all(text, " ").replace("&quot;", "\"").replace("&#x27;", "'").replace("&#39;", "'").replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">");
            normalize_text(&text).unwrap_or_else(|error| panic!("{error}: {text}"));
            count += 1;
        }
        assert!(count > 1000);
    }
    #[test]
    fn voice_labels_use_verified_reader_metadata() {
        assert_eq!(PIPER_VOICES.len(), 904);
        for (index, voice) in PIPER_VOICES.iter().enumerate() {
            assert_eq!(voice.speaker, index);
            assert!(!voice.name.is_empty());
            assert!(!voice.reader_id.is_empty());
            assert!(["Female", "Male"].contains(&voice.gender.as_str()));
            let label = voice_name("piper", index);
            assert!(label.contains(&voice.name) && label.contains(&voice.gender));
        }
        assert_eq!(voice_name("piper", 0), "Ashley Candland (Female) - Piper 1");
        assert_eq!(voice_name("piper", 2), "Brett W. Downey (Male) - Piper 3");
        assert!(voice_name("kokoro", 2).contains("Bella (Female; US English)"));
        assert!(voice_name("kokoro", 11).contains("Adam (Male; US English)"));
    }
    #[test]
    fn catalogues_include_every_runtime_speaker_without_filtering() {
        assert_eq!(KOKORO_VOICES.len(), 54);
        let mut codes = HashSet::new();
        for (id, voice) in KOKORO_VOICES.iter().enumerate() {
            assert_eq!(voice.speaker, id);
            assert!(codes.insert(&voice.code));
            assert_eq!(voice_id("kokoro", &voice_identifier("kokoro", id), 54).unwrap(), id as i32);
        }
        for (engine, count) in [("kokoro", 54), ("piper", 904), ("kokoro", 56)] {
            let voices = voice_catalog(engine, count);
            assert_eq!(voices.len(), count);
            for (index, voice) in voices.iter().enumerate() {
                assert_eq!(voice_id(engine, &voice.id, count).unwrap(), index as i32);
                assert!(!voice.name.is_empty());
            }
        }
        assert_eq!(voice_identifier("kokoro", 53), "kokoro-em_santa");
        assert_eq!(voice_identifier("kokoro", 55), "kokoro-speaker-55");
    }
    #[test]
    fn voices_are_scoped_to_the_engine() {
        assert_eq!(voice_id("kokoro", "kokoro-em_santa", 54).unwrap(), 53);
        assert!(voice_id("kokoro", "piper-1", 54).is_err());
        assert!(voice_id("kokoro", "kokoro-em_santa", 53).is_err());
        assert!(voice_id("piper", "piper--1", 904).is_err());
    }
    #[test]
    fn wav_has_pcm_header_and_clips_samples() {
        let data = wav(&[-2.0, 0.0, 2.0], 22050);
        assert_eq!(&data[..4], b"RIFF");
        assert_eq!(data.len(), 50);
        assert_eq!(i16::from_le_bytes(data[44..46].try_into().unwrap()), -32767);
        assert_eq!(i16::from_le_bytes(data[48..50].try_into().unwrap()), 32767);
    }
    #[tokio::test(flavor = "current_thread")]
    async fn rejects_stale_requests_and_bad_configuration() {
        let state = SpeechRuntime::default();
        state.advance(20);
        assert!(configure(&state, PathBuf::new(), "wrong", 20, false).await.is_err());
        assert!(configure(&state, PathBuf::new(), "piper", 19, false).await.is_err());
        assert!(synthesize(&state, "hello".into(), "piper-0".into(), "piper".into(), 19).await.is_err());
        assert!(synthesize(&state, "bad\0text".into(), "piper-0".into(), "piper".into(), 20).await.is_err());
    }
    #[tokio::test(flavor = "current_thread")]
    #[ignore = "requires SPEECH_MODEL_ROOT containing verified downloaded model directories"]
    async fn actual_persisted_models_reload_and_refresh_without_changing_files() {
        let root = PathBuf::from(std::env::var("SPEECH_MODEL_ROOT").unwrap());
        for model in [KOKORO, PIPER] {
            assert!(model_is_cached(&root, model));
            let before = model.files.iter().map(|(name, _)| fs::metadata(root.join(model.folder).join(name)).unwrap().modified().unwrap()).collect::<Vec<_>>();
            for refresh in [false, true] {
                let state = SpeechRuntime::default();
                let info = configure(&state, root.clone(), model.engine, 0, refresh).await.unwrap();
                assert_eq!(info.voices.len(), if model.engine == "kokoro" { 54 } else { 904 });
                assert!(info.reason.contains("downloaded"));
            }
            let after = model.files.iter().map(|(name, _)| fs::metadata(root.join(model.folder).join(name)).unwrap().modified().unwrap()).collect::<Vec<_>>();
            assert_eq!(before, after, "Restart and refresh must not replace downloaded model or voice files");
        }
        #[cfg(unix)]
        {
            let piper_only = test_directory("piper-only-offline");
            std::os::unix::fs::symlink(root.join(PIPER.folder), piper_only.join(PIPER.folder)).unwrap();
            let state = SpeechRuntime::default();
            let info = configure(&state, piper_only.clone(), "auto", 0, false).await.unwrap();
            assert_eq!(info.engine, "piper");
            assert!(info.reason.contains("downloaded Piper"));
            assert!(!piper_only.join(KOKORO.folder).exists());
            fs::remove_dir_all(piper_only).unwrap();
        }
    }
    #[test]
    #[ignore = "requires SPEECH_MODEL_ROOT containing both extracted model directories"]
    fn actual_models_generate_first_and_last_voices() {
        let root = PathBuf::from(std::env::var("SPEECH_MODEL_ROOT").unwrap());
        fs::write(root.join("study-lexicon.txt"), STUDY_LEXICON).unwrap();
        for model in [KOKORO, PIPER] {
            let loaded = load(model.engine, &root.join(model.folder)).unwrap();
            assert_eq!(loaded.info.voices.len(), if model.engine == "kokoro" { 54 } else { 904 });
            let state = SpeechRuntime::default();
            let start = Instant::now();
            let (samples, rate) = generate(&loaded, "Which document assigns the authority to make Canadian regulations governing radiocommunications?", 0, state.generation.subscribe(), 0).unwrap();
            let duration = samples.len() as f64 / rate as f64;
            eprintln!("{}: {:.2}s generation for {:.2}s audio", model.engine, start.elapsed().as_secs_f64(), duration);
            if model.engine == "piper" { assert!(start.elapsed().as_secs_f64() < duration, "Piper must stay ahead of playback"); }
            let last = loaded.info.voices.len() as i32 - 1;
            let (samples, _) = generate(&loaded, "The Radiocommunication Act.", last, state.generation.subscribe(), 0).unwrap();
            assert!(!samples.is_empty());
        }
    }
}
