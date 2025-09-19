const $ = (sel) => document.querySelector(sel);

const state = {
  settings: null,
  currentPath: "",
  chatHistory: [{ role: "system", content: "You are a helpful local coding assistant." }],
  streaming: false,
  streamCancel: null,
  autoScrollChat: true,
  chatStartTime: null,
  chatTimerId: null,
  modelCache: {},
};

const numbers = {
  sanitize(value, fallback) {
    return Number.isFinite(value) ? value : fallback;
  },
};

function formatBackendName(backend) {
  if (backend === 'ollama') return 'Ollama';
  if (backend === 'lmstudio') return 'LM Studio';
  return backend || 'Custom backend';
}

function formatModelLabel(backend, model) {
  const backendName = formatBackendName(backend);
  if (model) {
    return `${model} • ${backendName}`;
  }
  return `No model selected • ${backendName}`;
}

function setTopStatus(message, tone = 'idle', { allowDuringStream = false } = {}) {
  if (!allowDuringStream && state.streaming && tone !== 'busy') {
    return;
  }
  const pill = $('#statusPill');
  if (!pill) return;
  pill.dataset.tone = tone;
  const textEl = $('#statusText');
  if (textEl) {
    textEl.textContent = message;
  }
}

function setChatStatus(tone, message) {
  const el = $('#chatStatus');
  if (!el) return;
  el.dataset.tone = tone;
  el.textContent = message;
}

function updateChatMeta(backend, model) {
  const labelEl = $('#chatModelLabel');
  if (!labelEl) return;
  const label = formatModelLabel(backend, model);
  labelEl.textContent = label;
  updateChatMetaDivider();
}

function getModelInputValue() {
  const main = $('#modelInput')?.value?.trim();
  const quick = $('#quickModelInput')?.value?.trim();
  return main || quick || '';
}

function setModelInputValue(value) {
  const modelField = $('#modelInput');
  const quickField = $('#quickModelInput');
  if (modelField && modelField.value !== value) {
    modelField.value = value || '';
  }
  if (quickField && quickField.value !== value) {
    quickField.value = value || '';
  }
  const backend = $('#backendSelect')?.value || state.settings?.backend;
  if (backend) {
    updateChatMeta(backend, value);
  }
}

function syncQuickControls() {
  const quickBackend = $('#quickBackendSelect');
  if (quickBackend) {
    const backendValue = $('#backendSelect')?.value || state.settings?.backend || 'ollama';
    quickBackend.value = backendValue;
  }
  setModelInputValue(getModelInputValue());
}

function updateChatMetaDivider() {
  const divider = document.querySelector('.chatMetaDivider');
  if (!divider) return;
  const label = $('#chatModelLabel')?.textContent?.trim();
  const timer = $('#chatTimerLabel')?.textContent?.trim();
  const shouldShow = Boolean(label) && Boolean(timer);
  divider.classList.toggle('isHidden', !shouldShow);
}

function clearChatTimer() {
  if (state.chatTimerId) {
    clearInterval(state.chatTimerId);
    state.chatTimerId = null;
  }
}

function setChatTimer(message, { animate = false } = {}) {
  const label = $('#chatTimerLabel');
  if (!label) return;
  clearChatTimer();
  label.textContent = message || '';
  if (animate) {
    if (!state.chatStartTime) {
      state.chatStartTime = performance.now();
    }
    state.chatTimerId = window.setInterval(() => {
      if (!state.chatStartTime) return;
      const elapsed = ((performance.now() - state.chatStartTime) / 1000).toFixed(1);
      label.textContent = `${message} • ${elapsed}s`;
      updateChatMetaDivider();
    }, 200);
  } else {
    updateChatMetaDivider();
  }
}

function finishChatTimer(prefix) {
  const label = $('#chatTimerLabel');
  if (!label) return;
  clearChatTimer();
  if (state.chatStartTime) {
    const total = ((performance.now() - state.chatStartTime) / 1000).toFixed(1);
    label.textContent = prefix ? `${prefix} (${total}s)` : `${total}s`;
  } else {
    label.textContent = prefix || '';
  }
  state.chatStartTime = null;
  updateChatMetaDivider();
}

function isChatNearBottom() {
  const log = $('#chatLog');
  if (!log) return true;
  const distance = log.scrollHeight - log.scrollTop - log.clientHeight;
  return distance < 60;
}

function scrollChatToBottom({ behavior = 'auto' } = {}) {
  const log = $('#chatLog');
  if (!log) return;
  log.scrollTo({ top: log.scrollHeight, behavior });
  state.autoScrollChat = true;
  $('#btnScrollToBottom')?.classList.add('isHidden');
}

function maybeAutoScrollChat() {
  if (state.autoScrollChat) {
    scrollChatToBottom();
  }
}

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || res.statusText);
  }
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return res.json();
  }
  return res.text();
}

async function init() {
  bindUI();
  setTopStatus('Loading settings…', 'pending');
  await loadSettings();
  applySettingsToUI();
  await refreshModels();
  await refreshTree("");
  openFile(
    "welcome.txt",
    `# Welcome to Local Cursor\n\n- Configure your backend in Settings.\n- Manage files from the workspace panel.\n- Ask questions on the right to interact with the selected model.\n- Use the find/replace toolbar under the editor title.\n\nEnjoy fully offline coding assistance!\n`
  );
  restoreTheme();
  updateChatMeta(state.settings?.backend, getModelInputValue());
  setChatStatus('idle', 'Idle');
  setChatTimer('');
  const currentTone = $('#statusPill')?.dataset?.tone;
  if (currentTone !== 'error') {
    setTopStatus('Ready', 'idle');
  }
}

function bindUI() {
  $('#btnSettings').addEventListener('click', showSettingsPanel);
  $('#btnCloseSettings').addEventListener('click', hideSettingsPanel);
  $('#settingsPanel').addEventListener('click', (ev) => {
    if (ev.target === $('#settingsPanel')) hideSettingsPanel();
  });
  $('#btnSaveSettings').addEventListener('click', async () => {
    try {
      await persistSettingsSilently();
      setSettingsStatus('Settings saved.', false);
      hideSettingsPanel();
      await refreshModels(true);
    } catch (err) {
      setSettingsStatus(`Failed to save: ${err.message}`, true);
    }
  });
  $('#btnRefreshModels').addEventListener('click', async () => {
    await refreshModels(true);
  });
  $('#backendSelect').addEventListener('change', async () => {
    const backend = $('#backendSelect').value;
    if (state.settings) {
      state.settings.backend = backend;
    }
    syncQuickControls();
    await refreshModels(true);
    await persistSettingsSilently();
  });

  $('#quickBackendSelect').addEventListener('change', async (ev) => {
    const backend = ev.target.value;
    $('#backendSelect').value = backend;
    if (state.settings) {
      state.settings.backend = backend;
    }
    await refreshModels(true);
    await persistSettingsSilently();
  });

  $('#btnQuickRefresh').addEventListener('click', async () => {
    await refreshModels(true);
  });

  ['#modelInput', '#quickModelInput'].forEach((selector) => {
    const input = $(selector);
    if (!input) return;
    input.addEventListener('input', () => {
      const other = selector === '#modelInput' ? $('#quickModelInput') : $('#modelInput');
      if (other && other.value !== input.value) {
        other.value = input.value;
      }
    });
    const commit = async () => {
      const value = getModelInputValue();
      if (!state.settings || value === state.settings.model) return;
      state.settings.model = value;
      updateChatMeta(state.settings.backend, value);
      await persistSettingsSilently();
    };
    input.addEventListener('change', commit);
    input.addEventListener('blur', commit);
  });

  $('#btnTheme').addEventListener('click', toggleTheme);
  $('#btnClearChat').addEventListener('click', clearChat);
  $('#btnStop').addEventListener('click', stopStreaming);

  const chatLog = $('#chatLog');
  if (chatLog) {
    chatLog.addEventListener('scroll', () => {
      const atBottom = isChatNearBottom();
      state.autoScrollChat = atBottom;
      $('#btnScrollToBottom')?.classList.toggle('isHidden', atBottom);
    });
  }
  $('#btnScrollToBottom').addEventListener('click', () => {
    scrollChatToBottom({ behavior: 'smooth' });
  });

  $('#btnNewFile').addEventListener('click', async () => {
    const name = prompt('New file path (relative to workspace/):', 'untitled.txt');
    if (!name) return;
    await api('/fs/new', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: name, is_dir: false }),
    });
    await refreshTree("");
    await loadFile(name);
  });

  $('#btnNewFolder').addEventListener('click', async () => {
    const name = prompt('New folder name:', 'folder');
    if (!name) return;
    await api('/fs/new', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: name, is_dir: true }),
    });
    await refreshTree("");
  });

  $('#btnDelete').addEventListener('click', async () => {
    if (!state.currentPath) return;
    if (!confirm(`Delete ${state.currentPath}?`)) return;
    await api('/fs/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: state.currentPath }),
    });
    state.currentPath = "";
    $('#editor').value = "";
    $('#currentPath').textContent = 'No file selected';
    await refreshTree("");
  });

  $('#btnRename').addEventListener('click', async () => {
    if (!state.currentPath) return;
    const newName = prompt('Rename to:', state.currentPath);
    if (!newName || newName === state.currentPath) return;
    await api('/fs/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ src: state.currentPath, dst: newName }),
    });
    state.currentPath = newName;
    $('#currentPath').textContent = newName;
    await refreshTree("");
  });

  $('#btnSave').addEventListener('click', saveFile);
  document.addEventListener('keydown', (ev) => {
    const activeId = document.activeElement?.id;
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 's') {
      ev.preventDefault();
      saveFile();
    }
    if (ev.key === 'Enter' && activeId === 'searchBox') {
      ev.preventDefault();
      globalSearch();
    }
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'f') {
      ev.preventDefault();
      $('#findInput').focus();
    }
    if ((ev.metaKey || ev.ctrlKey) && ev.shiftKey && ev.key.toLowerCase() === 'f') {
      ev.preventDefault();
      $('#replaceInput').focus();
    }
  });

  $('#btnFindNext').addEventListener('click', () => findNext(false));
  $('#btnReplace').addEventListener('click', replaceSelection);
  $('#btnReplaceAll').addEventListener('click', replaceAll);

  $('#searchBox').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      globalSearch();
    }
  });

  $('#btnAsk').addEventListener('click', askModel);
  $('#chatBox').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
      ev.preventDefault();
      askModel();
    }
  });

  syncQuickControls();
}

async function loadSettings() {
  state.settings = await api('/settings');
}

function applySettingsToUI() {
  const s = state.settings;
  $('#backendSelect').value = s.backend;
  $('#ollamaUrl').value = s.ollama_base_url;
  $('#lmstudioUrl').value = s.lmstudio_base_url;
  $('#temp').value = s.temperature;
  $('#topP').value = s.top_p;
  $('#maxToks').value = s.max_tokens;
  setModelInputValue(s.model || '');
  syncQuickControls();
}

async function persistSettingsSilently() {
  const payload = collectSettingsFromUI();
  const res = await api('/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  state.settings = res.settings;
  applySettingsToUI();
  return res;
}

function collectSettingsFromUI() {
  const fallback = state.settings || {};
  const temperature = parseFloat($('#temp').value);
  const topP = parseFloat($('#topP').value);
  const maxTokens = parseInt($('#maxToks').value, 10);
  return {
    backend: $('#backendSelect').value,
    ollama_base_url: $('#ollamaUrl').value.trim(),
    lmstudio_base_url: $('#lmstudioUrl').value.trim(),
    model: getModelInputValue(),
    temperature: numbers.sanitize(temperature, fallback.temperature ?? 0.2),
    top_p: numbers.sanitize(topP, fallback.top_p ?? 0.9),
    max_tokens: numbers.sanitize(maxTokens, fallback.max_tokens ?? 2048),
  };
}

async function refreshModels(force = false) {
  const backend = $('#backendSelect').value;
  const cached = state.modelCache[backend];
  if (cached && !force) {
    populateModelOptions(backend, cached);
    return;
  }

  const baseUrl = backend === 'ollama' ? $('#ollamaUrl').value : $('#lmstudioUrl').value;
  let hadError = false;
  try {
    setTopStatus(`Refreshing ${formatBackendName(backend)} models…`, 'pending');
    const url = new URL(window.location.origin + '/models');
    url.searchParams.set('backend', backend);
    if (baseUrl) url.searchParams.set('base_url', baseUrl);
    const res = await api(url.pathname + url.search);
    const models = res.models || [];
    state.modelCache[backend] = models;
    populateModelOptions(backend, models);
    if (res.error) {
      setSettingsStatus(`Model refresh error: ${res.error}`, true);
      setTopStatus('Model refresh error', 'error', { allowDuringStream: true });
      hadError = true;
    } else if (force) {
      setSettingsStatus('Models refreshed.', false);
    }
  } catch (err) {
    setSettingsStatus(`Failed to load models: ${err.message}`, true);
    setTopStatus('Model refresh failed', 'error', { allowDuringStream: true });
    hadError = true;
  } finally {
    if (!hadError && !state.streaming) {
      setTopStatus('Ready', 'idle');
    }
  }
}

function populateModelOptions(backend, models) {
  const datalist = $('#modelOptions');
  if (datalist) {
    datalist.innerHTML = '';
    models.forEach((model) => {
      const option = document.createElement('option');
      option.value = model;
      datalist.appendChild(option);
    });
  }
  const manual = getModelInputValue();
  let resolved = manual || state.settings?.model || '';
  if (!resolved && models.length) {
    resolved = models[0];
  }
  setModelInputValue(resolved);
  if (state.settings) {
    state.settings.model = resolved;
  }
  updateChatMeta(backend, resolved);
}

function showSettingsPanel() {
  $('#settingsPanel').classList.remove('hidden');
  $('#settingsPanel').setAttribute('aria-hidden', 'false');
}

function hideSettingsPanel() {
  $('#settingsPanel').classList.add('hidden');
  $('#settingsPanel').setAttribute('aria-hidden', 'true');
}

function setSettingsStatus(message, isError) {
  const el = $('#settingsStatus');
  el.textContent = message;
  el.style.color = isError ? 'var(--danger)' : 'var(--muted)';
}

function restoreTheme() {
  const stored = localStorage.getItem('lc-theme');
  if (stored === 'light') {
    document.body.classList.add('light');
  }
}

function toggleTheme() {
  document.body.classList.toggle('light');
  const mode = document.body.classList.contains('light') ? 'light' : 'dark';
  localStorage.setItem('lc-theme', mode);
}

async function refreshTree(path) {
  const res = await api(`/fs/list?path=${encodeURIComponent(path)}`);
  const container = $('#fileTree');
  container.innerHTML = '';
  if (path) {
    const up = document.createElement('div');
    up.className = 'item';
    up.textContent = '⬆ ..';
    up.addEventListener('click', () => {
      const parent = path.split('/').slice(0, -1).join('/');
      refreshTree(parent);
    });
    container.appendChild(up);
  }
  (res.items || []).forEach((item) => {
    const div = document.createElement('div');
    div.className = 'item';
    div.textContent = item.is_dir ? '📁 ' : '📄 ';
    const nameSpan = document.createElement('span');
    nameSpan.textContent = item.name;
    div.appendChild(nameSpan);
    if (!item.is_dir) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = `${item.size}b`;
      badge.style.marginLeft = 'auto';
      div.appendChild(badge);
    }
    if (!item.is_dir) {
      div.addEventListener('click', () => loadFile(item.path));
    } else {
      div.addEventListener('click', () => refreshTree(item.path));
    }
    if (item.path === state.currentPath) {
      div.classList.add('active');
    }
    container.appendChild(div);
  });
}

async function loadFile(path) {
  const res = await api(`/fs/read?path=${encodeURIComponent(path)}`);
  state.currentPath = res.path;
  $('#currentPath').textContent = res.path;
  $('#editor').value = res.content;
  $('#editor').focus();
}

function openFile(path, content) {
  state.currentPath = path;
  $('#currentPath').textContent = path;
  $('#editor').value = content || '';
}

async function saveFile() {
  if (!state.currentPath) {
    const path = prompt('Save as (relative to workspace/):', 'untitled.txt');
    if (!path) return;
    state.currentPath = path;
  }
  const body = {
    path: state.currentPath,
    content: $('#editor').value,
  };
  await api('/fs/write', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  $('#currentPath').textContent = state.currentPath;
  await refreshTree("");
}

async function globalSearch() {
  const query = $('#searchBox').value.trim();
  if (!query) return;
  const res = await api('/fs/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const matches = res.matches || [];
  if (!matches.length) {
    alert('No matches found.');
    return;
  }
  const first = matches[0];
  if (first.path) {
    await loadFile(first.path);
    highlightLine(first.line, first.context);
  }
}

function highlightLine(lineNumber, context) {
  if (!lineNumber || lineNumber < 1) return;
  const editor = $('#editor');
  const lines = editor.value.split('\n');
  let start = 0;
  for (let i = 0; i < lines.length && i < lineNumber - 1; i++) {
    start += lines[i].length + 1;
  }
  const len = context ? context.length : (lines[lineNumber - 1] || '').length;
  editor.focus();
  editor.setSelectionRange(start, start + len);
}

function findNext(loop = true) {
  const editor = $('#editor');
  const query = $('#findInput').value;
  if (!query) return;
  const text = editor.value;
  let idx = text.indexOf(query, editor.selectionEnd);
  if (idx === -1 && loop) {
    idx = text.indexOf(query, 0);
  }
  if (idx !== -1) {
    editor.focus();
    editor.setSelectionRange(idx, idx + query.length);
  }
}

function replaceSelection() {
  const editor = $('#editor');
  const query = $('#findInput').value;
  if (!query) return;
  const replacement = $('#replaceInput').value;
  const selected = editor.value.substring(editor.selectionStart, editor.selectionEnd);
  if (selected === query) {
    const before = editor.value.substring(0, editor.selectionStart);
    const after = editor.value.substring(editor.selectionEnd);
    const cursor = editor.selectionStart + replacement.length;
    editor.value = before + replacement + after;
    editor.setSelectionRange(cursor, cursor);
  }
  findNext();
}

function replaceAll() {
  const editor = $('#editor');
  const query = $('#findInput').value;
  if (!query) return;
  const replacement = $('#replaceInput').value;
  const regex = new RegExp(escapeRegExp(query), 'g');
  editor.value = editor.value.replace(regex, replacement);
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function addChatMessage(role, content) {
  const div = document.createElement('div');
  div.className = `chatMsg ${role === 'user' ? 'user' : role === 'error' ? 'error' : ''}`;
  div.textContent = content;
  const log = $('#chatLog');
  if (log) {
    const shouldStick = state.autoScrollChat || isChatNearBottom();
    log.appendChild(div);
    if (shouldStick) {
      scrollChatToBottom();
    } else {
      state.autoScrollChat = false;
      $('#btnScrollToBottom')?.classList.remove('isHidden');
    }
  }
  return div;
}

function clearChat() {
  state.chatHistory = [{ role: 'system', content: 'You are a helpful local coding assistant.' }];
  $('#chatLog').innerHTML = '';
  state.autoScrollChat = true;
  setChatStatus('idle', 'Idle');
  setChatTimer('');
  updateChatMeta(state.settings?.backend, getModelInputValue());
  if (!state.streaming) {
    setTopStatus('Ready', 'idle');
  }
  $('#btnScrollToBottom')?.classList.add('isHidden');
}

function stopStreaming() {
  if (state.streamCancel) {
    setChatStatus('pending', 'Stopping…');
    setChatTimer('Cancelling…');
    setTopStatus('Cancelling request…', 'pending', { allowDuringStream: true });
    state.streamCancel();
  }
}

async function askModel() {
  if (state.streaming) return;
  const prompt = $('#chatBox').value.trim();
  if (!prompt) return;
  $('#chatBox').value = '';

  state.chatHistory.push({ role: 'user', content: prompt });
  addChatMessage('user', prompt);
  const assistantEntry = { role: 'assistant', content: '' };
  state.chatHistory.push(assistantEntry);
  const assistantBubble = addChatMessage('assistant', '');

  const payload = {
    ...collectSettingsFromUI(),
    messages: state.chatHistory,
  };

  if (!payload.model) {
    const warning = 'Select a model in settings first.';
    assistantEntry.content = warning;
    assistantBubble.textContent = warning;
    assistantBubble.classList.add('error');
    setChatStatus('error', 'No model selected');
    return;
  }

  try {
    state.streaming = true;
    state.autoScrollChat = true;
    const backendName = formatBackendName(payload.backend);
    const modelLabel = `${payload.model} @ ${backendName}`;
    updateChatMeta(payload.backend, payload.model);
    setChatStatus('pending', 'Connecting…');
    setTopStatus(`Connecting to ${modelLabel}`, 'pending', { allowDuringStream: true });
    state.chatStartTime = performance.now();
    setChatTimer('Waiting for response…');

    const insertToEditor = $('#cbInsert').checked;
    const editor = $('#editor');
    const selectionStart = editor.selectionStart;
    const selectionEnd = editor.selectionEnd;

    const stream = await streamChat(payload, {
      status: (raw) => handleStreamStatus(raw, payload),
      delta: (token) => {
        assistantEntry.content += token;
        assistantBubble.classList.remove('error');
        assistantBubble.textContent = assistantEntry.content;
        maybeAutoScrollChat();
        if (insertToEditor) {
          const before = editor.value.slice(0, selectionStart);
          const after = editor.value.slice(selectionEnd);
          editor.value = before + assistantEntry.content + after;
        }
      },
      error: (message) => {
        assistantBubble.classList.add('error');
        assistantBubble.textContent = `Error: ${message}`;
        setChatStatus('error', message || 'Error');
        setTopStatus('Needs attention', 'error', { allowDuringStream: true });
        finishChatTimer('Error');
      },
      end: async () => {
        state.streaming = false;
        state.streamCancel = null;
        if (!assistantEntry.content) {
          const fallbackStart = performance.now();
          state.chatStartTime = fallbackStart;
          setChatStatus('pending', 'Requesting fallback…');
          setTopStatus('Retrying with fallback…', 'pending', { allowDuringStream: true });
          setChatTimer('Fallback in progress…', { animate: true });
          const fallback = await fallbackChat(payload);
          assistantEntry.content = fallback;
          assistantBubble.classList.remove('error');
          assistantBubble.textContent = fallback;
          if (insertToEditor) {
            const before = editor.value.slice(0, selectionStart);
            const after = editor.value.slice(selectionEnd);
            editor.value = before + fallback + after;
          }
          finishChatTimer('Fallback completed');
          setChatStatus('success', 'Completed (fallback)');
        } else {
          finishChatTimer('Completed');
          setChatStatus('success', 'Completed');
        }
        setTopStatus('Ready', 'idle', { allowDuringStream: true });
        maybeAutoScrollChat();
      },
    });
    state.streamCancel = stream.cancel;
  } catch (err) {
    state.streaming = false;
    state.streamCancel = null;
    assistantBubble.classList.add('error');
    assistantBubble.textContent = `Stream failed: ${err.message}`;
    setChatStatus('error', 'Stream failed');
    setTopStatus('Stream failed', 'error', { allowDuringStream: true });
    finishChatTimer('Failed');
    const fallbackStart = performance.now();
    state.chatStartTime = fallbackStart;
    setChatTimer('Fallback in progress…', { animate: true });
    const fallback = await fallbackChat(payload);
    assistantEntry.content = fallback;
    assistantBubble.classList.remove('error');
    assistantBubble.textContent = fallback;
    if (insertToEditor) {
      const editor = $('#editor');
      const before = editor.value.slice(0, selectionStart);
      const after = editor.value.slice(selectionEnd);
      editor.value = before + fallback + after;
    }
    finishChatTimer('Fallback completed');
    setChatStatus('success', 'Completed (fallback)');
    setTopStatus('Ready', 'idle', { allowDuringStream: true });
    maybeAutoScrollChat();
  }
}

function handleStreamStatus(raw, payload) {
  let info;
  try {
    info = JSON.parse(raw);
  } catch (err) {
    info = { stage: raw };
  }
  const stage = info?.stage;
  const backendName = formatBackendName(payload.backend);
  if (stage === 'connecting') {
    setChatStatus('pending', `Connecting to ${backendName}…`);
    setChatTimer('Waiting for response…');
  } else if (stage === 'connected') {
    setChatStatus('pending', 'Connected. Awaiting response…');
    setChatTimer('Connected. Waiting for response…');
  } else if (stage === 'streaming') {
    setChatStatus('streaming', 'Streaming response…');
    setTopStatus(`Streaming from ${payload.model}`, 'busy', { allowDuringStream: true });
    setChatTimer('Streaming response', { animate: true });
  } else if (stage === 'completed') {
    // handled once the stream closes
  } else if (stage === 'error') {
    const message = info?.message || 'Error from backend';
    setChatStatus('error', message);
    setTopStatus(message, 'error', { allowDuringStream: true });
    finishChatTimer('Error');
  }
}

async function streamChat(payload, handlers) {
  const controller = new AbortController();
  const response = await fetch('/chat_stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: controller.signal,
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let ended = false;
  const safeEnd = () => {
    if (ended) return;
    ended = true;
    handlers.end?.();
  };
  (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index;
        while ((index = buffer.indexOf('\n\n')) !== -1) {
          const chunk = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          processSseChunk(chunk, handlers, safeEnd);
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        handlers.error?.(err.message);
      }
    } finally {
      safeEnd();
    }
  })();
  return {
    cancel: () => controller.abort(),
  };
}

function processSseChunk(chunk, handlers, safeEnd) {
  const lines = chunk.split('\n');
  let event = 'message';
  let data = '';
  for (const line of lines) {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      data += line.slice(5).trim();
    }
  }
  if (event === 'delta') {
    handlers.delta?.(data);
  } else if (event === 'error') {
    handlers.error?.(data || 'Unknown error');
  } else if (event === 'status') {
    handlers.status?.(data);
  } else if (event === 'end') {
    safeEnd();
  }
}

async function fallbackChat(payload) {
  try {
    const res = await api('/chat_once', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return res.response || '';
  } catch (err) {
    return `Failed to get response: ${err.message}`;
  }
}

window.addEventListener('load', init);
