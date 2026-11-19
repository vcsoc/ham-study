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
  const questionVoice = document.getElementById('question-voice');
  const answerVoice = document.getElementById('answer-voice');
  let generation = Date.now(), paused = false, audio = null, activeWord = null, originals = [], progressTimer = null, setupReady = false, androidSpeech = false;
  const cache = new Map();
  const preparingRows = new Map();
  const invoke = window.__TAURI__?.core?.invoke;
  let speechSupported = Boolean(invoke);
  if (invoke) invoke('speech_supported').then(supported => {
    speechSupported = supported;
    if (!supported) {
      play.disabled = true;
      status.textContent = 'Speech is not available on this platform yet. The study guide and simulator remain available.';
      const notice = document.createElement('div');
      notice.className = 'mobile-speech-notice';
      notice.textContent = 'Read-aloud is not available on this platform yet. Study and practice tests remain available.';
      document.querySelector('main .content').before(notice);
    }
  }).catch(() => {});

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

  function updateSettings(persist = true) {
    volumeValue.textContent = Math.round(Number(volume.value) * 100) + '%';
    speedValue.textContent = Number(speed.value).toFixed(2).replace(/0$/, '') + 'x';
    if (audio) { audio.volume = Number(volume.value); audio.playbackRate = Number(speed.value); }
    if (persist) try { localStorage.setItem('ham-reader-settings', JSON.stringify({volume: volume.value, speed: speed.value, questionVoice: questionVoice.value, answerVoice: answerVoice.value})); } catch (_) {}
  }
  try {
    const saved = JSON.parse(localStorage.getItem('ham-reader-settings') || '{}');
    if (Number.isFinite(Number(saved.volume)) && saved.volume !== undefined) volume.value = Math.max(0, Math.min(1, Number(saved.volume)));
    if (Number.isFinite(Number(saved.speed)) && saved.speed !== undefined) speed.value = Math.max(.5, Math.min(2, Number(saved.speed)));
    const availableVoices = ['default', 'voice-a', 'voice-b', 'kathleen', 'kristin', 'john', 'bryce'];
    if (availableVoices.includes(saved.questionVoice)) questionVoice.value = saved.questionVoice;
    if (availableVoices.includes(saved.answerVoice)) answerVoice.value = saved.answerVoice;
  } catch (_) {}
  [volume, speed].forEach(control => {
    control.addEventListener('input', () => updateSettings());
    control.addEventListener('dblclick', () => { control.value = control.defaultValue; updateSettings(); });
  });
  [questionVoice, answerVoice].forEach(control => control.addEventListener('change', () => updateSettings()));
  updateSettings(false);
  if (invoke) invoke('speech_platform').then(async platform => {
    if (platform !== 'android') return;
    androidSpeech = true;
    setupReady = true;
    status.textContent = 'Using Android text-to-speech. Select a question, then choose Read.';
    const note = document.getElementById('voice-help');
    if (note) note.textContent = 'These voices come from your phone’s installed offline Android speech engine. Availability depends on your device settings.';
    let voices = [];
    try { voices = await invoke('speech_voices'); } catch (_) {}
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('ham-reader-settings') || '{}'); } catch (_) {}
    [questionVoice, answerVoice].forEach((control, index) => {
      control.replaceChildren(new Option('Android default', 'default'));
      voices.forEach(name => control.add(new Option(name, name)));
      const selected = index === 0 ? saved.questionVoice : saved.answerVoice;
      if (voices.includes(selected)) control.value = selected;
    });
  }).catch(() => {});

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
    if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load(); audio = null; }
    resetHighlights();
    play.disabled = !speechSupported; pause.disabled = true; pause.textContent = 'Pause'; stop.disabled = true;
    status.textContent = message;
  }
  function makePassages(section, startRow) {
    const passages = [];
    const rows = Array.from(section.querySelectorAll('ol.study-questions > li'));
    const start = startRow ? rows.indexOf(startRow) : 0;
    rows.slice(Math.max(0, start)).forEach(row => {
      [row.querySelector('.question'), row.querySelector('.answer strong')].forEach((element, index) => {
        if (!element) return;
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
  function requestPassage(passage, id) {
    const voice = passage.kind === 'question' ? questionVoice.value : answerVoice.value;
    const key = JSON.stringify([voice, passage.text]);
    if (cache.has(key)) return Promise.resolve({data: cache.get(key)});
    const entry = showPreparation(passage);
    return invoke('synthesize_word', {text: passage.text, voice, generation: id}).then(data => {
      if (id === generation) {
        if (cache.size >= 100) cache.delete(cache.keys().next().value);
        cache.set(key, data);
      }
      return {data};
    }, error => ({error})).finally(() => clearPreparation(passage.row, entry));
  }
  async function playPassage(passage, encoded, id) {
    await waitWhilePaused(id);
    if (id !== generation) return;
    const player = new Audio('data:audio/wav;base64,' + encoded);
    player.volume = Number(volume.value); player.playbackRate = Number(speed.value);
    audio = player;
    const weights = passage.words.map(word => Math.max(1, word.textContent.replace(/[^\p{L}\p{N}]/gu, '').length));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    function updateWord() {
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
  }
  async function startReading(startRow = null) {
    stopReading(startRow ? 'Starting selected question...' : androidSpeech ? 'Preparing Android speech...' : 'Preparing speech; first use downloads approximately 1.5 GB and may take several minutes...');
    startRow = startRow || study.querySelector('.selected-question') || study.querySelector('.study-category[open] .study-section[open] ol.study-questions > li') || study.querySelector('.study-category[open] ol.study-questions > li') || study.querySelector('ol.study-questions > li');
    const section = startRow && startRow.closest('section');
    if (!section) return;
    selectQuestion(startRow);
    const id = generation;
    progressGroup.hidden = true;
    progress.value = 0;
    percentText.textContent = '0%';
    let polling = false, preparing = true;
    if (!setupReady) progressTimer = setInterval(async () => {
      if (polling || !preparing || id !== generation) return;
      polling = true;
      try {
        const info = await invoke('speech_progress');
        if (id !== generation || !preparing) return;
        if (info.phase === 'download' && info.total > 0) {
          const percent = Math.min(100, Math.floor(info.downloaded / info.total * 100));
          progress.value = percent;
          percentText.textContent = percent + '%';
          progressGroup.hidden = false;
          status.textContent = 'Downloading ' + info.label + ': ' + percent + '%';
        } else if (info.phase === 'checking' || info.phase === 'starting') {
          progressGroup.hidden = true;
          status.textContent = (info.phase === 'checking' ? 'Checking ' : '') + info.label + '...';
        } else if (info.phase === 'ready') {
          progressGroup.hidden = true;
          status.textContent = 'Preparing the first spoken passage...';
        }
      } catch (_) { /* Reading can still proceed if progress is unavailable. */ }
      finally { polling = false; }
    }, 300);
    const passages = makePassages(section, startRow);
    play.disabled = true; pause.disabled = false; stop.disabled = false;
    try {
      let pending = passages.length ? requestPassage(passages[0], id) : null;
      for (let i = 0; i < passages.length; i++) {
        const result = await pending;
        if (id !== generation) return;
        if (result.error) throw result.error;
        await waitWhilePaused(id);
        if (id !== generation) return;
        if (i === 0) {
          preparing = false;
          setupReady = true;
          if (progressTimer !== null) { clearInterval(progressTimer); progressTimer = null; }
          progressGroup.hidden = true;
          if (location.hash !== '#' + section.id) location.hash = '#' + section.id;
        }
        pending = i + 1 < passages.length ? requestPassage(passages[i + 1], id) : null;
        window.HamStudyGroups.reveal(passages[i].row);
        status.textContent = 'Reading ' + section.querySelector('h2').textContent.trim() + ' (word highlighting is approximate)';
        await playPassage(passages[i], result.data, id);
      }
      if (id === generation) stopReading('Finished reading this category.');
    } catch (error) {
      if (id === generation) stopReading('Speech unavailable: ' + String(error));
    }
  }
  play.addEventListener('click', () => startReading());
  study.addEventListener('dblclick', event => {
    if (stop.disabled) return;
    if (event.target.closest('.explanation-content')) return;
    const row = event.target.closest('ol.study-questions > li');
    const section = row && row.closest('#study-page section');
    if (!section) return;
    selectQuestion(row);
    row.scrollIntoView({behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center'});
    startReading(row);
  });
  pause.addEventListener('click', () => {
    paused = !paused;
    pause.textContent = paused ? 'Resume' : 'Pause';
    if (audio) { if (paused) audio.pause(); else audio.play().catch(error => stopReading('Playback failed: ' + error)); }
    status.textContent = paused ? 'Paused.' : 'Reading...';
  });
  stop.addEventListener('click', () => stopReading());
  document.addEventListener('keydown', event => {
    if (event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.target.closest('input, textarea, select, summary, [contenteditable="true"]')) return;
    const button = event.target.closest('button');
    if (event.code === 'Space' && !pause.disabled && (!button || button.matches('#reader-play, #reader-pause, #reader-stop'))) { event.preventDefault(); pause.click(); }
    else if (event.key === 'Escape' && !stop.disabled) { event.preventDefault(); stop.click(); }
  });
  window.addEventListener('hashchange', () => {
    if (!/^#category-\d+$/.test(location.hash)) stopReading('Reader is available in the question bank.');
  });
  if (!invoke) { play.disabled = true; status.textContent = 'Speech is available in the desktop application.'; }
})();
