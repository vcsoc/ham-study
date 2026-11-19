mod speech;
#[cfg(target_os = "linux")]
mod window_size;

use speech::{EngineOption, PruneResult, SpeechInfo, SpeechRuntime, SetupProgress};
use tauri::Manager;

#[tauri::command]
fn app_version(app: tauri::AppHandle) -> String { app.package_info().version.to_string() }
#[tauri::command]
fn speech_supported() -> bool { cfg!(target_os = "android") || cfg!(all(target_os = "linux", target_arch = "x86_64")) }
#[tauri::command]
fn speech_platform() -> &'static str { if cfg!(target_os = "android") { "android" } else { "desktop" } }
#[tauri::command]
fn speech_cancel(state: tauri::State<'_, SpeechRuntime>, generation: u64) { state.advance(generation); }
#[tauri::command]
fn speech_progress(state: tauri::State<'_, SpeechRuntime>) -> SetupProgress { state.progress() }
#[tauri::command]
fn speech_engines(app: tauri::AppHandle) -> Result<Vec<EngineOption>, String> {
    if !speech_supported() { return Ok(Vec::new()); }
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("speech-neural-v1");
    Ok(speech::engines(&dir))
}
#[tauri::command]
async fn speech_configure(app: tauri::AppHandle, state: tauri::State<'_, SpeechRuntime>, engine: String, generation: u64, refresh: Option<bool>) -> Result<SpeechInfo, String> {
    if !speech_supported() { return Err("Offline speech is not supported on this platform.".into()); }
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("speech-neural-v1");
    speech::configure(&state, dir, &engine, generation, refresh.unwrap_or(false)).await
}
#[tauri::command]
async fn speech_prune_cache(app: tauri::AppHandle, state: tauri::State<'_, SpeechRuntime>, engine: String, voices: Vec<String>, generation: u64) -> Result<PruneResult, String> {
    let dir = app.path().app_data_dir().map_err(|error| error.to_string())?;
    speech::prune_cache(&state, dir, engine, voices, generation).await
}
#[tauri::command]
async fn synthesize_word(state: tauri::State<'_, SpeechRuntime>, text: String, voice: String, engine: String, generation: u64) -> Result<String, String> {
    speech::synthesize(&state, text, voice, engine, generation).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "linux")]
    let builder = builder.setup(|app| {
        use gtk::prelude::*;

        let window = app.get_webview_window("main").ok_or("missing main window")?;
        let gtk_window = window.gtk_window()?;
        // A client-side title bar stays draggable even when the compositor draws no title bar.
        let titlebar = gtk::HeaderBar::new();
        titlebar.set_title(gtk_window.title().as_deref());
        titlebar.set_show_close_button(true);
        gtk_window.set_titlebar(Some(&titlebar));
        titlebar.show();
        if let Ok(config_dir) = app.path().app_config_dir() {
            window_size::install(&gtk_window, config_dir);
        }
        window.show()?;
        Ok(())
    });
    builder.manage(SpeechRuntime::default())
        .invoke_handler(tauri::generate_handler![app_version, synthesize_word, speech_configure, speech_engines, speech_prune_cache, speech_progress, speech_cancel, speech_supported, speech_platform])
        .run(tauri::generate_context!()).expect("failed to run Ham Study Desktop");
}
