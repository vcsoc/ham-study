(() => {
  const status = document.getElementById('reader-status');
  const play = document.getElementById('reader-play');
  const pause = document.getElementById('reader-pause');
  const stop = document.getElementById('reader-stop');
  const progress = document.getElementById('reader-progress');
  const progressGroup = document.getElementById('reader-progress-group');
  const percentText = document.getElementById('reader-percent');
  const infoButton = document.getElementById('reader-info');
  const volume = document.getElementById('reader-volume');
  const speed = document.getElementById('reader-speed');
  const volumeValue = document.getElementById('volume-value');
  const speedValue = document.getElementById('speed-value');
  const questionAnswerDelay = document.getElementById('question-answer-delay');
  const nextQuestionDelay = document.getElementById('next-question-delay');
  const questionAnswerDelayValue = document.getElementById('question-answer-delay-value');
  const nextQuestionDelayValue = document.getElementById('next-question-delay-value');
  const settingsInfo = document.getElementById('reader-settings-info');
  const settingsHelp = document.getElementById('voice-help');
  const helpWrap = settingsInfo.closest('.settings-help-wrap');
  const settingsPanel = settingsHelp.closest('.settings-panel');
  const settingsDetails = settingsPanel.closest('.reader-settings');
  const questionVoice = document.getElementById('question-voice');
  const answerVoice = document.getElementById('answer-voice');
  const engineControl = document.getElementById('speech-engine');
  const engineInfo = document.getElementById('engine-info');
  const retrySpeech = document.getElementById('speech-retry');
  const refreshSpeech = document.getElementById('speech-refresh');
  let generation = Date.now(), paused = false, audio = null, activeWord = null, originals = [], progressTimer = null, speechInfo = null;
  let voicePreferences = {};
  let currentPassage = null;
  const cache = new Map();
  const preparedPlayers = new Set();
  const lookahead = 4;
  const preparingRows = new Map();
  const invoke = window.__TAURI__?.core?.invoke;
  let speechSupported = Boolean(invoke);
  play.disabled = true;

  function clearPreparation(row, entry) {
    if (preparingRows.get(row) !== entry) return;
    clearInterval(entry.timer);
    entry.element.remove();
    row.classList.remove('is-preparing');
    preparingRows.delete(row);
  }
  function showPreparation(passage) {
    const row = passage.row;
    const previous = preparingRows.get(row);
    if (previous) clearPreparation(row, previous);
    const element = document.createElement('div');
    element.className = 'question-preparation';
    element.setAttribute('role', 'status');
    const bar = document.createElement('progress');
    bar.setAttribute('aria-label', 'Generating ' + passage.kind + ' audio; progress unavailable');
    const label = document.createElement('span');
    element.append(bar, label);
    row.prepend(element);
    row.classList.add('is-preparing');
    const started = performance.now();
    function update() {
      const elapsed = Math.floor((performance.now() - started) / 1000);
      label.textContent = 'Preparing ' + passage.kind + ' audio · ' + elapsed + 's elapsed';
    }
    update();
    const entry = {element, timer: setInterval(update, 1000)};
    preparingRows.set(row, entry);
    return entry;
  }

  let helpPinned = false, helpHideTimer = null;
  function showSettingsHelp(show) {
    clearTimeout(helpHideTimer);
    settingsHelp.hidden = !show;
    settingsInfo.setAttribute('aria-expanded', String(show));
    if (show) {
      const bottom = Math.min(settingsPanel.getBoundingClientRect().bottom, innerHeight - 12);
      settingsHelp.style.maxHeight = Math.max(60, bottom - settingsHelp.getBoundingClientRect().top - 16) + 'px';
    }
  }
  function dismissSettingsHelp() { helpPinned = false; showSettingsHelp(false); }
  helpWrap.addEventListener('pointerenter', () => showSettingsHelp(true));
  helpWrap.addEventListener('pointerleave', () => {
    if (!helpPinned && document.activeElement !== settingsInfo) helpHideTimer = setTimeout(() => showSettingsHelp(false), 150);
  });
  settingsInfo.addEventListener('focus', () => showSettingsHelp(true));
  settingsInfo.addEventListener('blur', () => {
    if (!helpPinned && !helpWrap.matches(':hover')) showSettingsHelp(false);
  });
  settingsInfo.addEventListener('click', () => { helpPinned = !helpPinned; showSettingsHelp(helpPinned); });
  document.addEventListener('click', event => { if (!helpWrap.contains(event.target)) dismissSettingsHelp(); });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !settingsHelp.hidden) { event.preventDefault(); event.stopImmediatePropagation(); dismissSettingsHelp(); }
  }, true);
  function fitSettingsPanel() {
    if (!settingsDetails.open) return;
    settingsPanel.style.transform = '';
    const bounds = settingsPanel.getBoundingClientRect();
    const shift = bounds.left < 12 ? 12 - bounds.left : Math.min(0, innerWidth - 12 - bounds.right);
    settingsPanel.style.transform = 'translateX(' + shift + 'px)';
    settingsPanel.style.maxHeight = Math.max(100, innerHeight - bounds.top - 12) + 'px';
    if (!settingsHelp.hidden) showSettingsHelp(true);
  }
  settingsDetails.addEventListener('toggle', () => {
    if (settingsDetails.open) fitSettingsPanel(); else dismissSettingsHelp();
  });
  window.addEventListener('resize', fitSettingsPanel);
  window.addEventListener('scroll', fitSettingsPanel, {passive: true});

  function formatDelay(milliseconds) {
    return milliseconds < 1000 ? milliseconds + ' ms' : Number((milliseconds / 1000).toFixed(4)) + ' s';
  }
  function updateSettings(persist = true) {
    volumeValue.textContent = Math.round(Number(volume.value) * 100) + '%';
    speedValue.textContent = Number(speed.value).toFixed(2).replace(/0$/, '') + 'x';
    for (const [control, output] of [[questionAnswerDelay, questionAnswerDelayValue], [nextQuestionDelay, nextQuestionDelayValue]]) {
      output.textContent = formatDelay(Number(control.value));
      control.setAttribute('aria-valuetext', output.textContent);
    }
    if (audio) { audio.volume = Number(volume.value); audio.playbackRate = Number(speed.value); }
    if (speechInfo && !questionVoice.disabled && !answerVoice.disabled) voicePreferences[speechInfo.engine] = {questionVoice: questionVoice.value, answerVoice: answerVoice.value};
    if (persist) try { localStorage.setItem('ham-reader-settings', JSON.stringify({volume: volume.value, speed: speed.value, questionAnswerDelayMs: questionAnswerDelay.value, nextQuestionDelayMs: nextQuestionDelay.value, engine: engineControl.value, voices: voicePreferences})); } catch (_) {}
  }
  try {
    const saved = JSON.parse(localStorage.getItem('ham-reader-settings') || '{}');
    if (Number.isFinite(Number(saved.volume)) && saved.volume !== undefined) volume.value = Math.max(0, Math.min(1, Number(saved.volume)));
    if (Number.isFinite(Number(saved.speed)) && saved.speed !== undefined) speed.value = Math.max(.5, Math.min(2, Number(saved.speed)));
    for (const [control, value] of [[questionAnswerDelay, saved.questionAnswerDelayMs], [nextQuestionDelay, saved.nextQuestionDelayMs]]) {
      if (value !== undefined && value !== null && Number.isFinite(Number(value))) control.value = Math.max(250, Math.min(15000, Math.round(Number(value) / 250) * 250));
    }
    if (['off', 'auto', 'kokoro', 'piper'].includes(saved.engine)) engineControl.value = saved.engine;
    if (saved.voices && typeof saved.voices === 'object' && !Array.isArray(saved.voices)) voicePreferences = saved.voices;
    // v0.19 used numeric speaker IDs; keep the same named voices after upgrading.
    const oldKokoro = ['af_heart', 'af_bella', 'af_nicole', 'af_sarah', 'af_sky', 'am_adam', 'am_michael', 'bf_emma', 'bf_isabella', 'bm_george', 'bm_lewis'];
    for (const field of ['questionVoice', 'answerVoice']) {
      const match = /^kokoro-(\d+)$/.exec(voicePreferences.kokoro?.[field] || '');
      if (match && oldKokoro[Number(match[1])]) voicePreferences.kokoro[field] = 'kokoro-' + oldKokoro[Number(match[1])];
    }
    const legacy = {default: 'piper-0', 'voice-a': 'piper-1', 'voice-b': 'piper-2', kathleen: 'piper-1', kristin: 'piper-3', john: 'piper-2', bryce: 'piper-4'};
    if (!voicePreferences.piper && (saved.questionVoice || saved.answerVoice)) voicePreferences.piper = {
      questionVoice: legacy[saved.questionVoice] || saved.questionVoice,
      answerVoice: legacy[saved.answerVoice] || saved.answerVoice
    };
  } catch (_) {}
  [volume, speed, questionAnswerDelay, nextQuestionDelay].forEach(control => {
    control.addEventListener('input', () => updateSettings());
    control.addEventListener('dblclick', () => { control.value = control.defaultValue; updateSettings(); });
  });
  [questionVoice, answerVoice].forEach(control => control.addEventListener('change', () => {
    updateSettings();
    if (!stop.disabled) startReading(study.querySelector('.selected-question'));
  }));
  engineControl.addEventListener('change', () => {
    if (!speechSupported) return;
    window.HamStudyWelcome.remember(engineControl.value);
    if (engineControl.value === 'off') disableSpeech();
    else configureEngine();
  });
  retrySpeech.addEventListener('click', () => configureEngine());
  refreshSpeech.addEventListener('click', () => configureEngine(true));
  updateSettings(false);
  window.addEventListener('pagehide', () => updateSettings());

  function setEngineOptions(engines) {
    const selected = engineControl.value;
    engineControl.replaceChildren(new Option('Off (no sound)', 'off'), ...engines.map(engine => new Option(
      engine.name + (engine.id !== 'auto' ? engine.downloaded ? ' (downloaded)' : ' (download on first use)' : ''), engine.id
    )));
    engineControl.value = selected === 'off' || engines.some(engine => engine.id === selected) ? selected : 'piper';
  }

  function disableSpeech() {
    stopReading('Read-aloud is off. Enable it in Reader Settings.');
    speechInfo = null;
    cache.clear();
    engineControl.value = 'off';
    play.disabled = true;
    retrySpeech.hidden = true;
    refreshSpeech.disabled = true;
    refreshSpeech.removeAttribute('aria-busy');
    engineInfo.textContent = status.textContent;
    [questionVoice, answerVoice].forEach(control => {
      control.disabled = true;
      control.replaceChildren(new Option('Read-aloud is off', ''));
    });
    updateSettings();
  }

  async function configureEngine(refresh = false) {
    if (!speechSupported || engineControl.value === 'off') return;
    updateSettings();
    const keep = refresh && speechInfo ? {engine: speechInfo.engine, voices: [questionVoice.value, answerVoice.value]} : null;
    stopReading('Preparing ' + engineControl.value + ' speech...');
    speechInfo = null;
    retrySpeech.hidden = true;
    for (const key of cache.keys()) {
      const [engine, voice] = JSON.parse(key);
      if (!keep || engine !== keep.engine || !keep.voices.includes(voice)) cache.delete(key);
    }
    play.disabled = true;
    const id = generation;
    refreshSpeech.disabled = true;
    refreshSpeech.setAttribute('aria-busy', 'true');
    engineInfo.textContent = keep ? 'Clearing unused voice caches; preserving the active engine and both selected voices...' : 'Checking downloaded speech models and voices...';
    status.textContent = engineInfo.textContent;
    [questionVoice, answerVoice].forEach(control => {
      control.disabled = true;
      control.replaceChildren(new Option('Loading voices...', ''));
    });
    let polling = false;
    progressTimer = setInterval(async () => {
      if (polling || id !== generation) return;
      polling = true;
      try {
        const info = await invoke('speech_progress');
        if (id !== generation) return;
        if (info.phase === 'download' && info.total > 0) {
          const percent = Math.min(100, Math.floor(info.downloaded / info.total * 100));
          progress.value = percent;
          percentText.textContent = percent + '%';
          progressGroup.hidden = false;
          status.textContent = 'Downloading ' + info.label + ': ' + percent + '%';
        } else if (info.phase === 'starting') {
          progressGroup.hidden = true;
          status.textContent = info.label + '...';
        }
        engineInfo.textContent = status.textContent;
      } catch (_) { /* Configuration errors are reported by speech_configure. */ }
      finally { polling = false; }
    }, 300);
    try {
      if (keep) {
        await invoke('speech_prune_cache', {engine: keep.engine, voices: keep.voices, generation: id});
        if (id !== generation) return;
      }
      const engines = await invoke('speech_engines');
      if (id !== generation) return;
      if (!Array.isArray(engines) || !engines.length) throw new Error('No supported speech engines are available.');
      setEngineOptions(engines);
      updateSettings();
      // Refresh must not let Auto switch engines and immediately re-download a pruned pack.
      const info = await invoke('speech_configure', {engine: keep?.engine || engineControl.value, generation: id, refresh});
      if (id !== generation) return;
      if (!['kokoro', 'piper'].includes(info.engine) || !info.voices?.length) throw new Error('No voices available for this engine.');
      speechInfo = info;
      setEngineOptions(engines.map(engine => ({...engine, downloaded: engine.downloaded || engine.id === info.engine})));
      const saved = voicePreferences[info.engine] || {};
      [questionVoice, answerVoice].forEach((control, index) => {
        control.replaceChildren(...info.voices.map(voice => new Option(voice.name, voice.id)));
        const selected = index === 0 ? saved.questionVoice : saved.answerVoice;
        if (info.voices.some(voice => voice.id === selected)) control.value = selected;
        control.disabled = false;
      });
      engineInfo.textContent = (keep ? 'Unused caches cleared; active shared voice pack retained. ' : '') + info.reason + ' ' + info.voices.length + ' voices available.';
      status.textContent = engineInfo.textContent + ' Select a question, then choose Read.';
      play.disabled = !speechSupported;
      updateSettings();
    } catch (error) {
      if (id !== generation) return;
      engineInfo.textContent = 'Speech setup failed: ' + String(error) + ' Choose another engine or retry.';
      retrySpeech.hidden = false;
      status.textContent = engineInfo.textContent;
      [questionVoice, answerVoice].forEach(control => control.replaceChildren(new Option('Voices unavailable', '')));
    } finally {
      if (id === generation) {
        clearInterval(progressTimer);
        progressTimer = null;
        progressGroup.hidden = true;
        refreshSpeech.disabled = !speechSupported;
        refreshSpeech.removeAttribute('aria-busy');
      }
    }
  }

  const study = document.getElementById('study-page');
  function selectQuestion(row) {
    if (!row || !study.contains(row)) return;
    study.querySelector('.selected-question')?.classList.remove('selected-question');
    row.classList.add('selected-question');
  }
  study.addEventListener('click', event => {
    if (!event.target.closest('.explanation-content')) selectQuestion(event.target.closest('ol.study-questions > li'));
  });
  document.addEventListener('ham-select-question', event => selectQuestion(event.detail));
  const updateInfo = () => { infoButton.title = status.textContent; infoButton.setAttribute('aria-label', 'Reader information: ' + status.textContent); };
  new MutationObserver(updateInfo).observe(status, {childList:true, characterData:true, subtree:true});
  updateInfo();
  const topbar = document.querySelector('.topbar');
  function updateTopbarHeight() { document.documentElement.style.setProperty('--topbar-height', topbar.offsetHeight + 'px'); }
  if (window.ResizeObserver) new ResizeObserver(updateTopbarHeight).observe(topbar);
  window.addEventListener('resize', updateTopbarHeight);
  updateTopbarHeight();

  function resetHighlights() {
    if (activeWord) activeWord.classList.remove('reading-word');
    activeWord = null;
    originals.forEach(({element, html}) => { element.innerHTML = html; });
    originals = [];
  }
  function stopReading(message = 'Stopped.') {
    generation++;
    if (invoke) invoke('speech_cancel', {generation}).catch(() => {});
    if (progressTimer !== null) { clearInterval(progressTimer); progressTimer = null; }
    for (const [row, entry] of preparingRows) clearPreparation(row, entry);
    progressGroup.hidden = true;
    paused = false;
    currentPassage = null;
    for (const player of preparedPlayers) { player.pause(); player.removeAttribute('src'); player.load(); }
    preparedPlayers.clear();
    audio = null;
    resetHighlights();
    play.disabled = !speechSupported || !speechInfo; pause.disabled = true; pause.textContent = 'Pause'; stop.disabled = true;
    status.textContent = message;
  }
  function makePassages(section, startRow, startKind) {
    const passages = [];
    const rows = Array.from(section.querySelectorAll('ol.study-questions > li'));
    const start = startRow ? rows.indexOf(startRow) : 0;
    rows.slice(Math.max(0, start)).forEach((row, rowIndex) => {
      [row.querySelector('.question'), row.querySelector('.answer strong')].forEach((element, index) => {
        if (!element || (rowIndex === 0 && startKind === 'answer' && index === 0)) return;
        const words = [];
        originals.push({element, html: element.innerHTML});
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        const nodes = [];
        while (walker.nextNode()) nodes.push(walker.currentNode);
        nodes.forEach(node => {
          const fragment = document.createDocumentFragment();
          node.textContent.split(/(\s+)/).forEach(part => {
            if (!part) return;
            if (/^\s+$/.test(part)) fragment.append(document.createTextNode(part));
            else { const span = document.createElement('span'); span.textContent = part; fragment.append(span); words.push(span); }
          });
          node.replaceWith(fragment);
        });
        if (words.length) passages.push({row, words, text: words.map(word => word.textContent).join(' '), kind: index === 0 ? 'question' : 'answer'});
      });
    });
    return passages;
  }
  async function waitWhilePaused(id) {
    while (paused && id === generation) await new Promise(resolve => setTimeout(resolve, 100));
  }
  async function waitForTransition(control, id) {
    let elapsed = 0, lastTick = performance.now(), wasPaused = paused;
    while (id === generation) {
      const now = performance.now();
      if (!wasPaused) elapsed += now - lastTick;
      lastTick = now;
      wasPaused = paused;
      const remaining = Number(control.value) - elapsed;
      if (!paused && remaining <= 0) return;
      await new Promise(resolve => setTimeout(resolve, paused ? 25 : Math.min(25, Math.max(0, remaining))));
    }
  }
  function requestPassage(passage, id) {
    const voice = passage.kind === 'question' ? questionVoice.value : answerVoice.value;
    const engine = speechInfo.engine;
    const key = JSON.stringify([engine, voice, passage.text]);
    const prepare = data => {
      if (id !== generation) return {};
      const player = new Audio('data:audio/wav;base64,' + data);
      player.preload = 'auto';
      preparedPlayers.add(player);
      player.load();
      return {player};
    };
    if (cache.has(key)) return Promise.resolve(prepare(cache.get(key)));
    const entry = showPreparation(passage);
    return invoke('synthesize_word', {text: passage.text, voice, engine, generation: id}).then(data => {
      if (id === generation) {
        if (cache.size >= 100) cache.delete(cache.keys().next().value);
        cache.set(key, data);
      }
      return prepare(data);
    }, error => ({error})).finally(() => clearPreparation(passage.row, entry));
  }
  async function playPassage(passage, player, id) {
    await waitWhilePaused(id);
    if (id !== generation) return;
    player.volume = Number(volume.value); player.playbackRate = Number(speed.value);
    audio = player;
    const weights = passage.words.map(word => Math.max(1, word.textContent.replace(/[^\p{L}\p{N}]/gu, '').length));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    function updateWord() {
      if (!weights.length) return;
      if (!Number.isFinite(player.duration) || player.duration <= 0 || player.paused) return;
      const target = Math.min(1, player.currentTime / player.duration) * total;
      let sum = 0, index = weights.length - 1;
      for (let i = 0; i < weights.length; i++) { sum += weights[i]; if (target < sum) { index = i; break; } }
      const word = passage.words[index];
      if (word !== activeWord) {
        if (activeWord) activeWord.classList.remove('reading-word');
        activeWord = word; word.classList.add('reading-word');
        selectQuestion(word.closest('ol > li'));
        word.scrollIntoView({behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center'});
      }
    }
    await new Promise((resolve, reject) => {
      const timer = setInterval(() => { if (id !== generation) { clearInterval(timer); resolve(); } else updateWord(); }, 80);
      player.onended = () => { clearInterval(timer); resolve(); };
      player.onerror = () => { clearInterval(timer); reject(new Error('The generated audio could not be played.')); };
      player.play().catch(err => { clearInterval(timer); reject(err); });
    });
    if (audio === player) audio = null;
    preparedPlayers.delete(player);
    player.removeAttribute('src');
    player.load();
  }
  async function startReading(startRow = null, startKind = 'question', startPaused = false) {
    if (!speechInfo) return;
    stopReading(startRow ? 'Starting selected question...' : 'Preparing ' + speechInfo.engine + ' speech...');
    startRow = startRow || study.querySelector('.selected-question') || study.querySelector('.study-category[open] .study-section[open] ol.study-questions > li') || study.querySelector('.study-category[open] ol.study-questions > li') || study.querySelector('ol.study-questions > li');
    const section = startRow && startRow.closest('section');
    if (!section) return;
    selectQuestion(startRow);
    const id = generation;
    progressGroup.hidden = true;
    progress.value = 0;
    percentText.textContent = '0%';
    const passages = makePassages(section, startRow, startKind);
    play.disabled = true; pause.disabled = false; stop.disabled = false;
    if (startPaused) pause.click();
    try {
      // Keep several passages generated and preloaded, not just one slow request ahead.
      const pending = new Map();
      function fillQueue(index) {
        for (let j = index; j < Math.min(passages.length, index + lookahead); j++) {
          if (!pending.has(j)) pending.set(j, requestPassage(passages[j], id));
        }
      }
      fillQueue(0);
      for (let i = 0; i < passages.length; i++) {
        currentPassage = passages[i];
        const result = await pending.get(i);
        pending.delete(i);
        if (id !== generation) return;
        if (result.error) throw result.error;
        await waitWhilePaused(id);
        if (id !== generation) return;
        if (i === 0) {
          if (location.hash !== '#' + section.id) location.hash = '#' + section.id;
        }
        window.HamStudyGroups.reveal(passages[i].row);
        fillQueue(i + 1);
        status.textContent = 'Reading ' + section.querySelector('h2').textContent.trim() + ' (word highlighting is approximate)';
        await playPassage(passages[i], result.player, id);
        if (id !== generation) return;
        await window.HamStudyReaderOptions.readExplanation(passages[i], () => id === generation, async (passage, expanded) => {
          await waitWhilePaused(id);
          if (!expanded()) return;
          status.textContent = 'Reading expanded explanation...';
          const explanation = await requestPassage(passage, id);
          if (!expanded()) {
            if (explanation.player) {
              preparedPlayers.delete(explanation.player);
              explanation.player.removeAttribute('src');
              explanation.player.load();
            }
            return;
          }
          if (explanation.error) throw explanation.error;
          await playPassage(passage, explanation.player, id);
        });
        if (id !== generation) return;
        if (i + 1 < passages.length) {
          const delay = passages[i + 1].kind === 'answer' ? questionAnswerDelay : nextQuestionDelay;
          if (Number(delay.value) > 50) status.textContent = 'Waiting before the next ' + passages[i + 1].kind + '...';
          // Generation continues during this pause; do not add the delay after waiting for audio.
          await waitForTransition(delay, id);
          if (id !== generation) return;
        }
      }
      if (id === generation) stopReading('Finished reading this category.');
    } catch (error) {
      if (id === generation) stopReading('Speech unavailable: ' + String(error));
    }
  }
  play.addEventListener('click', () => startReading());
  study.addEventListener('dblclick', event => {
    if (!speechInfo) return;
    if (event.target.closest('.explanation-content')) return;
    const row = event.target.closest('ol.study-questions > li');
    const section = row && row.closest('#study-page section');
    if (!section) return;
    event.preventDefault();
    const kind = event.target.closest('.answer') ? 'answer' : 'question';
    if (!stop.disabled && currentPassage?.row === row && currentPassage.kind === kind) {
      pause.click();
      return;
    }
    selectQuestion(row);
    row.scrollIntoView({behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center'});
    startReading(row, kind);
  });
  pause.addEventListener('click', () => {
    paused = !paused;
    pause.textContent = paused ? 'Resume' : 'Pause';
    if (audio) { if (paused) audio.pause(); else audio.play().catch(error => stopReading('Playback failed: ' + error)); }
    status.textContent = paused ? 'Paused.' : 'Reading...';
  });
  stop.addEventListener('click', () => stopReading());
  window.HamStudyReaderOptions.shortcuts({
    active: () => !pause.disabled,
    togglePause: () => pause.click(),
    stop: () => stop.click(),
    skip(offset) {
      const row = window.HamStudyReaderOptions.adjacent(currentPassage?.row || study.querySelector('.selected-question'), offset);
      if (row) startReading(row, 'question', paused);
    }
  });
  window.addEventListener('hashchange', () => {
    if (speechInfo && !/^#category-\d+$/.test(location.hash)) stopReading('Reader is available in the question bank.');
  });
  if (invoke) invoke('speech_supported').then(async supported => {
    speechSupported = supported;
    engineControl.disabled = true;
    const selection = await window.HamStudyWelcome.choose(supported, engineControl.value);
    if (supported) {
      engineControl.disabled = false;
      engineControl.value = selection;
      return selection === 'off' ? disableSpeech() : configureEngine();
    }
    engineControl.disabled = true;
    status.textContent = 'Offline speech is available on Linux x86-64 and Android.';
    engineInfo.textContent = status.textContent;
  }).catch(error => {
    status.textContent = 'Could not initialize speech: ' + String(error);
    engineInfo.textContent = status.textContent;
  });
  else {
    engineControl.disabled = true;
    status.textContent = 'Speech is available in the installed application.';
    engineInfo.textContent = status.textContent;
  }
})();
