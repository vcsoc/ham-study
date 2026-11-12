use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{fs, io::Write, net::TcpListener, path::{Path, PathBuf}, process::{Child, Command, Stdio}, sync::Mutex as SyncMutex, time::Duration};
use tauri::Manager;
use tokio::sync::{watch, Mutex};

const RUNTIME_URL: &str = "https://github.com/ggml-org/llama.cpp/releases/download/b12292/llama-b12292-bin-ubuntu-x64.tar.gz";
const RUNTIME_SHA: &str = "ffaf53f17a4601493e6ffb5869c9f0c7d400bb7e124fe0096eee3b65a5862568";
const MODEL: (&str, &str) = ("Qwen3-TTS-12Hz-1.7B-Base-Q4_K_M.gguf", "8d18c94acb2addd042f97da63c98be144eafa76d0d9495177eab65130cf85129");
const PROJECTOR: (&str, &str) = ("mmproj-Qwen3-TTS-12Hz-1.7B-Base-Q8_0.gguf", "6fd65188839bcd6ecc91b277ad471e22a0edfada4699a0fe82f1165c18cfcce2");

struct Running { process: Child, port: u16 }
impl Drop for Running { fn drop(&mut self) { let _ = self.process.kill(); let _ = self.process.wait(); } }
#[derive(Clone, Default, Serialize)]
struct SetupProgress { phase: String, label: String, downloaded: u64, total: u64 }
struct SpeechRuntime { runtime: Mutex<Option<Running>>, progress: SyncMutex<SetupProgress>, generation: watch::Sender<u64> }
impl Default for SpeechRuntime {
    fn default() -> Self {
        let (generation, _) = watch::channel(0);
        Self { runtime: Mutex::new(None), progress: SyncMutex::new(SetupProgress::default()), generation }
    }
}
impl SpeechRuntime {
    fn advance(&self, generation: u64) {
        self.generation.send_if_modified(|current| {
            if generation > *current { *current = generation; true } else { false }
        });
    }
    fn progress(&self, phase: &str, label: &str, downloaded: u64, total: u64) {
        if let Ok(mut p) = self.progress.lock() { *p = SetupProgress { phase: phase.into(), label: label.into(), downloaded, total }; }
    }
}
#[cfg(target_os = "android")]
struct AndroidSpeech(tauri::plugin::PluginHandle<tauri::Wry>);
#[cfg(target_os = "android")]
#[derive(serde::Deserialize)]
struct AndroidAudio { audio: String }
#[cfg(target_os = "android")]
#[derive(serde::Deserialize)]
struct AndroidVoices { voices: Vec<String> }
#[tauri::command]
fn app_version(app: tauri::AppHandle) -> String { app.package_info().version.to_string() }
#[tauri::command]
fn speech_supported() -> bool { cfg!(target_os = "android") || cfg!(all(target_os = "linux", target_arch = "x86_64")) }
#[tauri::command]
fn speech_platform() -> &'static str { if cfg!(target_os = "android") { "android" } else { "desktop" } }
#[tauri::command]
async fn speech_voices(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    #[cfg(target_os = "android")]
    { return app.state::<AndroidSpeech>().0.run_mobile_plugin_async::<AndroidVoices>("voices", ()).await.map(|v| v.voices).map_err(|e| e.to_string()); }
    #[cfg(not(target_os = "android"))]
    { let _ = app; Ok(Vec::new()) }
}
#[tauri::command]
fn speech_cancel(app: tauri::AppHandle, state: tauri::State<'_, SpeechRuntime>, generation: u64) {
    state.advance(generation);
    #[cfg(target_os = "android")]
    {
        let plugin = app.state::<AndroidSpeech>().0.clone();
        tauri::async_runtime::spawn(async move { let _: Result<serde_json::Value, _> = plugin.run_mobile_plugin_async("cancel", serde_json::json!({"generation": generation})).await; });
    }
    #[cfg(not(target_os = "android"))]
    let _ = app;
}
#[tauri::command]
fn speech_progress(state: tauri::State<'_, SpeechRuntime>) -> SetupProgress {
    state.progress.lock().map(|p| p.clone()).unwrap_or_default()
}

async fn download(client: &reqwest::Client, url: &str, path: &Path, expected: &str, state: &SpeechRuntime, label: &str, expected_size: u64) -> Result<(), String> {
    fn verify(path: &Path, expected: &str) -> bool {
        use std::io::Read;
        let Ok(mut f) = fs::File::open(path) else { return false };
        let mut h = Sha256::new(); let mut buf = [0u8; 1024 * 1024];
        loop { match f.read(&mut buf) { Ok(0) => break, Ok(n) => h.update(&buf[..n]), Err(_) => return false } }
        format!("{:x}", h.finalize()) == expected
    }
    if path.exists() { state.progress("checking", label, 0, 0); }
    if verify(path, expected) { return Ok(()); }
    state.progress("download", label, 0, expected_size);
    let temp = path.with_extension("download");
    let mut response = client.get(url).send().await.map_err(|e| format!("Download failed: {e}"))?.error_for_status().map_err(|e| e.to_string())?;
    let mut file = fs::File::create(&temp).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut downloaded = 0u64;
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        file.write_all(&chunk).map_err(|e| e.to_string())?; hash.update(&chunk);
        downloaded += chunk.len() as u64;
        state.progress("download", label, downloaded, expected_size);
    }
    drop(file);
    state.progress("checking", label, 0, 0);
    if format!("{:x}", hash.finalize()) != expected { let _ = fs::remove_file(&temp); return Err("Downloaded file failed its SHA-256 integrity check.".into()); }
    if path.exists() { fs::remove_file(path).map_err(|e| e.to_string())?; }
    fs::rename(temp, path).map_err(|e| e.to_string())
}

async fn prepare(app: &tauri::AppHandle, state: &SpeechRuntime) -> Result<Running, String> {
    if !cfg!(all(target_os = "linux", target_arch = "x86_64")) { return Err("Automatic speech setup is currently supported on Linux x86-64 only.".into()); }
    let dir: PathBuf = app.path().app_data_dir().map_err(|e| e.to_string())?.join("speech");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let client = reqwest::Client::builder().timeout(Duration::from_secs(3600)).build().map_err(|e| e.to_string())?;
    let archive = dir.join("llama-runtime.tar.gz");
    download(&client, RUNTIME_URL, &archive, RUNTIME_SHA, state, "Speech runtime (1 of 3)", 23_283_641).await?;
    let server = dir.join("llama-b12292/llama-server");
    if !server.is_file() {
        state.progress("starting", "Installing speech runtime", 0, 0);
        let file = fs::File::open(&archive).map_err(|e| e.to_string())?;
        tar::Archive::new(flate2::read::GzDecoder::new(file)).unpack(&dir).map_err(|e| format!("Runtime extraction failed: {e}"))?;
    }
    for ((file, hash), label, size) in [(MODEL, "Speech model (2 of 3)", 1_035_965_280), (PROJECTOR, "Audio component (3 of 3)", 446_422_912)] {
        let url = format!("https://huggingface.co/ggml-org/Qwen3-TTS-12Hz-1.7B-Base-GGUF/resolve/main/{file}");
        download(&client, &url, &dir.join(file), hash, state, label, size).await?;
    }
    state.progress("starting", "Loading speech model", 0, 0);
    let port = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?.local_addr().map_err(|e| e.to_string())?.port();
    let process = Command::new(server)
        .arg("--model").arg(dir.join(MODEL.0)).arg("--mmproj").arg(dir.join(PROJECTOR.0))
        .args(["--host", "127.0.0.1", "--port", &port.to_string(), "--ctx-size", "2048", "--parallel", "1", "--threads", "4"])
        .stdout(Stdio::null()).stderr(Stdio::null()).spawn().map_err(|e| format!("Could not start speech runtime: {e}"))?;
    let mut running = Running { process, port };
    let health = format!("http://127.0.0.1:{port}/health");
    for _ in 0..300 {
        if let Some(status) = running.process.try_wait().map_err(|e| e.to_string())? { return Err(format!("Speech runtime exited during startup: {status}")); }
        if client.get(&health).timeout(Duration::from_secs(1)).send().await.map(|r| r.status().is_success()).unwrap_or(false) { return Ok(running); }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    Err("Speech runtime did not become ready in time.".into())
}

#[derive(Serialize)]
struct SpeechRequest<'a> {
    input: &'a str,
    response_format: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    speaker_ref_b64: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    seed: Option<i32>,
}

#[tauri::command]
async fn synthesize_word(app: tauri::AppHandle, state: tauri::State<'_, SpeechRuntime>, text: String, voice: Option<String>, generation: u64) -> Result<String, String> {
    state.advance(generation);
    let mut cancelled = state.generation.subscribe();
    if *cancelled.borrow() > generation { return Err("Speech request cancelled".into()); }
    if text.trim().is_empty() || text.chars().count() > 512 { return Err("Speech segment must contain 1 to 512 characters.".into()); }
    #[cfg(target_os = "android")]
    {
        let result = app.state::<AndroidSpeech>().0.run_mobile_plugin_async::<AndroidAudio>("synthesize", serde_json::json!({"text":text, "voice":voice.unwrap_or_else(|| "default".into()), "generation":generation})).await.map_err(|e| e.to_string())?;
        return Ok(result.audio);
    }
    #[cfg(not(target_os = "android"))]
    {
    let voice = voice.as_deref().unwrap_or("default");
    if !["default", "voice-a", "voice-b", "kathleen", "kristin", "john", "bryce"].contains(&voice) { return Err("Unknown voice selection.".into()); }
    let mut runtime = state.runtime.lock().await;
    if let Some(r) = runtime.as_mut() { if r.process.try_wait().map_err(|e| e.to_string())?.is_some() { *runtime = None; } }
    if runtime.is_none() { *runtime = Some(prepare(&app, &state).await?); }
    state.progress("ready", "Preparing audio", 0, 0);
    let port = runtime.as_ref().ok_or("Speech runtime unavailable")?.port;
    drop(runtime);
    if *cancelled.borrow() > generation { return Err("Speech request cancelled".into()); }
    let synthesis = async {
    let client = reqwest::Client::builder().timeout(Duration::from_secs(600)).no_proxy().build().map_err(|e| e.to_string())?;
    let endpoint = format!("http://127.0.0.1:{port}/v1/audio/speech");
    let builtin: Option<&[u8]> = match voice {
        "kathleen" => Some(include_bytes!("../../ui/voices/kathleen.wav")),
        "kristin" => Some(include_bytes!("../../ui/voices/kristin.wav")),
        "john" => Some(include_bytes!("../../ui/voices/john.wav")),
        "bryce" => Some(include_bytes!("../../ui/voices/bryce.wav")),
        _ => None,
    };
    let speaker_ref_b64 = if voice == "default" { None } else if let Some(sample) = builtin {
        Some(STANDARD.encode(sample))
    } else {
        let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("speech");
        let path = dir.join(format!("{voice}-reference.wav"));
        if !path.is_file() {
            let sample = SpeechRequest { input: "Hello, this is my voice for reading the amateur radio study guide.", response_format: "wav", speaker_ref_b64: None, seed: Some(if voice == "voice-a" { 42 } else { 9182 }) };
            let response = client.post(&endpoint).json(&sample).send().await.map_err(|e| format!("Voice setup failed: {e}"))?.error_for_status().map_err(|e| format!("Voice setup failed: {e}"))?;
            let bytes = response.bytes().await.map_err(|e| e.to_string())?;
            if bytes.len() < 44 || bytes.len() > 16 * 1024 * 1024 || !bytes.starts_with(b"RIFF") { return Err("Voice setup did not return valid WAV audio.".into()); }
            let temp = path.with_extension("tmp");
            fs::write(&temp, &bytes).map_err(|e| e.to_string())?;
            fs::rename(temp, &path).map_err(|e| e.to_string())?;
        }
        Some(STANDARD.encode(fs::read(path).map_err(|e| format!("Could not load voice reference: {e}"))?))
    };
    let response = client.post(endpoint)
        .json(&SpeechRequest { input: &text, response_format: "wav", speaker_ref_b64, seed: None }).send().await.map_err(|e| format!("Speech request failed: {e}"))?;
    let status = response.status();
    if !status.is_success() { let message = response.text().await.unwrap_or_default(); return Err(format!("Speech runtime returned {status}: {}", message.chars().take(500).collect::<String>())); }
    let audio = response.bytes().await.map_err(|e| e.to_string())?;
    if audio.len() > 16 * 1024 * 1024 { return Err("Speech response is too large.".into()); }
    Ok(STANDARD.encode(audio))
    };
    tokio::select! {
        result = synthesis => result,
        _ = async {
            loop {
                if *cancelled.borrow() > generation { break; }
                if cancelled.changed().await.is_err() { break; }
            }
        } => Err("Speech request cancelled".into()),
    }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "android")]
    let builder = builder.plugin(tauri::plugin::Builder::<tauri::Wry, ()>::new("android-speech").setup(|app, api| {
        app.manage(AndroidSpeech(api.register_android_plugin("ca.hamstudy.desktop", "SpeechPlugin")?));
        Ok(())
    }).build());
    builder.manage(SpeechRuntime::default())
        .invoke_handler(tauri::generate_handler![app_version, synthesize_word, speech_progress, speech_cancel, speech_supported, speech_platform, speech_voices])
        .run(tauri::generate_context!()).expect("failed to run Ham Study Desktop");
}
