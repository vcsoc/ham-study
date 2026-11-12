package ca.hamstudy.desktop

import android.app.Activity
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Base64
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONArray
import java.io.File
import java.util.Locale
import java.util.UUID

@InvokeArg
class SynthesisArgs {
    lateinit var text: String
    var voice: String = "default"
    var generation: Long = 0
}

@InvokeArg
class CancelArgs { var generation: Long = 0 }

@TauriPlugin
class SpeechPlugin(private val activity: Activity) : Plugin(activity) {
    private var engine: TextToSpeech? = null
    private var ready = false
    private var failed = false
    private var generation: Long = 0
    private val waiting = mutableListOf<Pair<Invoke, () -> Unit>>()
    private val pending = mutableMapOf<String, Pair<Invoke, File>>()

    init {
        activity.runOnUiThread {
            engine = TextToSpeech(activity) { status ->
                if (status == TextToSpeech.SUCCESS) {
                    ready = true
                    engine?.language = Locale.US
                    engine?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                        override fun onStart(id: String) {}
                        override fun onDone(id: String) {
                            val item = synchronized(pending) { pending.remove(id) } ?: return
                            try {
                                val result = JSObject()
                                result.put("audio", Base64.encodeToString(item.second.readBytes(), Base64.NO_WRAP))
                                item.first.resolve(result)
                            } catch (e: Exception) { item.first.reject("Could not read speech audio: ${e.message}") }
                            finally { item.second.delete() }
                        }
                        @Deprecated("Deprecated in Android")
                        override fun onError(id: String) { finishError(id, "Android speech synthesis failed") }
                        override fun onError(id: String, errorCode: Int) { finishError(id, "Android speech synthesis failed ($errorCode)") }
                        override fun onStop(id: String, interrupted: Boolean) { finishError(id, "Speech request cancelled") }
                    })
                    val tasks = waiting.toList(); waiting.clear(); tasks.forEach { it.second() }
                } else {
                    failed = true
                    val tasks = waiting.toList(); waiting.clear(); tasks.forEach { it.first.reject("Android text-to-speech could not be initialized. Install or enable a speech engine in Android settings.") }
                }
            }
        }
    }

    private fun finishError(id: String, message: String) {
        val item = synchronized(pending) { pending.remove(id) } ?: return
        item.second.delete(); item.first.reject(message)
    }

    private fun whenReady(invoke: Invoke, action: () -> Unit) {
        activity.runOnUiThread {
            if (failed) invoke.reject("Android text-to-speech is unavailable. Install or enable a speech engine in Android settings.")
            else if (ready) action()
            else waiting.add(Pair(invoke, action))
        }
    }

    @Command
    fun voices(invoke: Invoke) = whenReady(invoke) {
        val result = JSObject()
        val list = JSONArray()
        engine?.voices?.filter { it.locale.language == "en" && !it.isNetworkConnectionRequired }
            ?.sortedBy { it.name }?.forEach { list.put(it.name) }
        result.put("voices", list); invoke.resolve(result)
    }

    @Command
    fun cancel(invoke: Invoke) {
        val args = invoke.parseArgs(CancelArgs::class.java)
        activity.runOnUiThread {
            if (args.generation > generation) {
                generation = args.generation
                engine?.stop()
                val items = synchronized(pending) { val copy = pending.values.toList(); pending.clear(); copy }
                items.forEach { it.second.delete(); it.first.reject("Speech request cancelled") }
            }
            invoke.resolve()
        }
    }

    @Command
    fun synthesize(invoke: Invoke) {
        val args = invoke.parseArgs(SynthesisArgs::class.java)
        whenReady(invoke) {
            if (args.generation < generation) { invoke.reject("Speech request cancelled"); return@whenReady }
            generation = args.generation
            val tts = engine ?: run { invoke.reject("Android text-to-speech is unavailable"); return@whenReady }
            if (args.voice != "default") {
                val selected = tts.voices?.find { it.name == args.voice && !it.isNetworkConnectionRequired }
                if (selected == null) { invoke.reject("Selected Android voice is unavailable"); return@whenReady }
                tts.voice = selected
            } else { tts.language = Locale.US }
            val id = UUID.randomUUID().toString()
            val file = File(activity.cacheDir, "speech-$id.wav")
            synchronized(pending) { pending[id] = Pair(invoke, file) }
            val result = tts.synthesizeToFile(args.text, Bundle(), file, id)
            if (result != TextToSpeech.SUCCESS) finishError(id, "Android speech synthesis could not start")
        }
    }

    override fun onDestroy() {
        engine?.stop(); engine?.shutdown(); engine = null
        super.onDestroy()
    }
}
