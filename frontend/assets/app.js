const $ = (sel) => document.querySelector(sel);

const state = {
  settings: null,
  currentPath: "",
  chatHistory: [{ role: "system", content: "You are a helpful local coding assistant." }],
  streaming: false,
  streamCancel: null,
};

const numbers = {
  sanitize(value, fallback) {
    return Number.isFinite(value) ? value : fallback;
  },
};

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
  await loadSettings();
  applySettingsToUI();
  await refreshModels();
  await refreshTree("");
  openFile("welcome.txt", `# Welcome to Local Cursor\n\n- Configure your backend in Settings.\n- Manage files from the workspace panel.\n- Ask questions on the right to interact with the selected model.\n- Use the find/replace toolbar under the editor title.\n\nEnjoy fully offline coding assistance!\n`);
  restoreTheme();
}

function bindUI() {
  $('#btnSettings').addEventListener('click', showSettingsPanel);
  $('#btnCloseSettings').addEventListener('click', hideSettingsPanel);
  $('#settingsPanel').addEventListener('click', (ev) => {
    if (ev.target === $('#settingsPanel')) hideSettingsPanel();
  });
  $('#btnSaveSettings').addEventListener('click', async () => {
    try {
      await saveSettings();
      setSettingsStatus('Settings saved.', false);
      hideSettingsPanel();
    } catch (err) {
      setSettingsStatus(`Failed to save: ${err.message}`, true);
    }
  });
  $('#btnRefreshModels').addEventListener('click', async () => {
    await refreshModels(true);
  });
  $('#backendSelect').addEventListener('change', async () => {
    await refreshModels(true);
  });

  $('#btnTheme').addEventListener('click', toggleTheme);
  $('#btnClearChat').addEventListener('click', clearChat);
  $('#btnStop').addEventListener('click', stopStreaming);

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
}

async function saveSettings() {
  const payload = collectSettingsFromUI();
  const res = await api('/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  state.settings = res.settings;
  applySettingsToUI();
  await refreshModels();
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
    model: $('#modelSelect').value,
    temperature: numbers.sanitize(temperature, fallback.temperature ?? 0.2),
    top_p: numbers.sanitize(topP, fallback.top_p ?? 0.9),
    max_tokens: numbers.sanitize(maxTokens, fallback.max_tokens ?? 2048),
  };
}

async function refreshModels(force = false) {
  const backend = $('#backendSelect').value;
  const baseUrl = backend === 'ollama' ? $('#ollamaUrl').value : $('#lmstudioUrl').value;
  try {
    const url = new URL(window.location.origin + '/models');
    url.searchParams.set('backend', backend);
    if (baseUrl) url.searchParams.set('base_url', baseUrl);
    const res = await api(url.pathname + url.search);
    const select = $('#modelSelect');
    select.innerHTML = '';
    (res.models || []).forEach((model) => {
      const opt = document.createElement('option');
      opt.value = model;
      opt.textContent = model;
      select.appendChild(opt);
    });
    const desired = $('#modelSelect').value || state.settings?.model;
    if (desired && [...select.options].some((o) => o.value === desired)) {
      select.value = desired;
    } else if (select.options.length) {
      select.value = select.options[0].value;
    }
    if (select.value) {
      state.settings.model = select.value;
    }
    if (res.error) {
      setSettingsStatus(`Model refresh error: ${res.error}`, true);
    } else if (force) {
      setSettingsStatus('Models refreshed.', false);
    }
  } catch (err) {
    setSettingsStatus(`Failed to load models: ${err.message}`, true);
  }
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
  $('#chatLog').appendChild(div);
  $('#chatLog').scrollTop = $('#chatLog').scrollHeight;
  return div;
}

function clearChat() {
  state.chatHistory = [{ role: 'system', content: 'You are a helpful local coding assistant.' }];
  $('#chatLog').innerHTML = '';
}

function stopStreaming() {
  if (state.streamCancel) {
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
    assistantBubble.textContent = 'Select a model in settings first.';
    return;
  }

  try {
    state.streaming = true;
    const insertToEditor = $('#cbInsert').checked;
    const editor = $('#editor');
    const selectionStart = editor.selectionStart;
    const selectionEnd = editor.selectionEnd;
    let latest = '';

    const stream = await streamChat(payload, {
      delta: (token) => {
        assistantEntry.content += token;
        latest = assistantEntry.content;
        assistantBubble.textContent = assistantEntry.content;
        $('#chatLog').scrollTop = $('#chatLog').scrollHeight;
        if (insertToEditor) {
          const before = editor.value.slice(0, selectionStart);
          const after = editor.value.slice(selectionEnd);
          editor.value = before + latest + after;
        }
      },
      error: (message) => {
        assistantBubble.classList.add('error');
        assistantBubble.textContent = `Error: ${message}`;
      },
      end: async () => {
        state.streaming = false;
        state.streamCancel = null;
        if (!assistantEntry.content) {
          const fallback = await fallbackChat(payload);
          assistantEntry.content = fallback;
          assistantBubble.textContent = fallback;
        }
      },
    });
    state.streamCancel = stream.cancel;
  } catch (err) {
    state.streaming = false;
    state.streamCancel = null;
    assistantBubble.classList.add('error');
    assistantBubble.textContent = `Stream failed: ${err.message}`;
    const fallback = await fallbackChat(payload);
    if (fallback) {
      assistantEntry.content = fallback;
      assistantBubble.classList.remove('error');
      assistantBubble.textContent = fallback;
    }
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
