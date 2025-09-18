const $ = (q) => document.querySelector(q);
const api = (path, opts={}) => fetch(path, opts);

let state = {
  currentPath: null,
  fsCache: {},
  settings: null,
  streaming: false,
};

async function init(){
  const s = await (await api('/api/settings')).json();
  state.settings = s;
  $('#backendSelect').value = s.backend;
  $('#temp').value = s.temperature;
  $('#topP').value = s.top_p;
  $('#maxToks').value = s.max_tokens;
  await refreshModels();

  bindUI();
  await refreshTree("");
  openFile("welcome.txt", "# Welcome!\n\nThis is **Local Cursor**.\n- Choose backend (Ollama or LM Studio)\n- Pick a model\n- Type on the right to chat\n- Save files in the center editor\n\nHappy hacking!\n");
}

async function refreshModels(){
  const backendSelect = $('#backendSelect');
  const res = await (await api('/api/models')).json().catch(()=>({models:[]}));
  const modelSel = $('#modelSelect');
  modelSel.innerHTML = "";
  for(const m of (res.models||[])){
    const opt = document.createElement('option');
    opt.value = m; opt.textContent = m;
    modelSel.appendChild(opt);
  }
  // preserve selection or fallback to settings.model
  let want = state.settings.model;
  if (![...modelSel.options].some(o=>o.value===want) && modelSel.options.length>0){
    want = modelSel.options[0].value;
  }
  modelSel.value = want || "";
}

function bindUI(){
  $('#btnTheme').onclick = ()=> document.body.classList.toggle('light');
  $('#btnSettings').onclick = saveSettings;
  $('#backendSelect').onchange = async ()=>{
    state.settings.backend = $('#backendSelect').value;
    await saveSettings();
    await refreshModels();
  };
  $('#modelSelect').onchange = ()=> state.settings.model = $('#modelSelect').value;

  $('#btnNewFile').onclick = async ()=>{
    const name = prompt("New file name (relative to workspace):","newfile.txt");
    if(!name) return;
    await api('/api/fs/new', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({path:name, is_dir:false})});
    await refreshTree("");
    await loadFile(name);
  };
  $('#btnNewFolder').onclick = async ()=>{
    const name = prompt("New folder name:","folder");
    if(!name) return;
    await api('/api/fs/new', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({path:name, is_dir:true})});
    await refreshTree("");
  };
  $('#btnDelete').onclick = async ()=>{
    if(!state.currentPath) return;
    if(!confirm(`Delete ${state.currentPath}?`)) return;
    await api('/api/fs/delete', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({path: state.currentPath})});
    state.currentPath = null;
    $('#editor').value = "";
    $('#currentPath').textContent = "untitled.txt";
    await refreshTree("");
  };

  $('#btnRename').onclick = async ()=>{
    if(!state.currentPath) return;
    const newName = prompt("Rename to:", state.currentPath);
    if(!newName || newName===state.currentPath) return;
    await api('/api/fs/rename', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({src: state.currentPath, dst: newName})});
    state.currentPath = newName;
    $('#currentPath').textContent = state.currentPath;
    await refreshTree("");
  };

  $('#btnSave').onclick = saveFile;
  document.addEventListener('keydown', (e)=>{
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase()==='s'){
      e.preventDefault();
      saveFile();
    }
    if (e.key.toLowerCase()==='n' && (e.ctrlKey||e.metaKey)===false){
      if (document.activeElement.id !== 'chatBox'){
        e.preventDefault();
        $('#btnNewFile').click();
      }
    }
    if (e.key === 'Enter' && document.activeElement.id === 'searchBox'){
      doSearch();
    }
  });

  $('#searchBox').addEventListener('keydown', (e)=>{
    if(e.key==='Enter') doSearch();
  });

  $('#btnAsk').onclick = askModel;
}

async function saveSettings(){
  const payload = {
    backend: $('#backendSelect').value,
    model: $('#modelSelect').value,
    temperature: parseFloat($('#temp').value),
    top_p: parseFloat($('#topP').value),
    max_tokens: parseInt($('#maxToks').value,10)
  };
  const res = await (await api('/api/settings', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload)})).json();
  state.settings = res.settings;
}

async function refreshTree(path){
  const res = await (await api(`/api/fs/list?path=${encodeURIComponent(path)}`)).json();
  const container = $('#fileTree');
  container.innerHTML = "";
  // Up root button
  if (path){
    const up = document.createElement('div');
    up.className = 'item';
    up.textContent = '⬆ ..';
    up.onclick = ()=> refreshTree(path.split('/').slice(0,-1).join('/'));
    container.appendChild(up);
  }
  for(const it of res.items){
    const el = document.createElement('div');
    el.className = 'item';
    el.innerHTML = it.is_dir ? `📁 ${it.name}` : `📄 ${it.name} <span class="badge">(${it.size}b)</span>`;
    el.onclick = ()=>{
      if(it.is_dir){
        refreshTree(it.path);
      }else{
        loadFile(it.path);
      }
    };
    if (it.path === state.currentPath) el.classList.add('active');
    container.appendChild(el);
  }
}

async function loadFile(path){
  const res = await (await api(`/api/fs/read?path=${encodeURIComponent(path)}`)).json();
  state.currentPath = res.path;
  $('#currentPath').textContent = res.path;
  $('#editor').value = res.content;
  highlightLineNumbers();
}

function openFile(path, content){
  state.currentPath = path;
  $('#currentPath').textContent = path;
  $('#editor').value = content || "";
  highlightLineNumbers();
}

async function saveFile(){
  if(!state.currentPath){
    const name = prompt("Save as (relative path):","untitled.txt");
    if(!name) return;
    state.currentPath = name;
    $('#currentPath').textContent = name;
  }
  const body = {path: state.currentPath, content: $('#editor').value};
  await api('/api/fs/write', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)});
  await refreshTree("");
}

async function doSearch(){
  const q = $('#searchBox').value.trim();
  if(!q) return;
  const res = await (await api('/api/fs/search', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({query:q})})).json();
  const results = res.matches || [];
  if(results.length===0){
    alert("No matches.");
    return;
  }
  const first = results[0];
  if(first.path){
    await loadFile(first.path);
    // naive highlight by selecting content around line
    setTimeout(()=>{
      const lines = $('#editor').value.split('\n');
      let pos=0;
      for(let i=0;i<lines.length && i<first.line-1;i++) pos += lines[i].length+1;
      $('#editor').focus();
      $('#editor').setSelectionRange(pos, pos + (first.context||"").length);
    },50);
  }
}

function addChatMessage(text, who='assistant'){
  const div = document.createElement('div');
  div.className = 'chatMsg '+(who==='user'?'user':'');
  div.textContent = text;
  $('#chatLog').appendChild(div);
  $('#chatLog').scrollTop = $('#chatLog').scrollHeight;
}

async function askModel(){
  if(state.streaming) return;
  const q = $('#chatBox').value.trim();
  if(!q) return;
  $('#chatBox').value = "";
  addChatMessage(q, 'user');

  const body = {
    messages: [
      {role:'system', content:'You are a helpful coding assistant.'},
      {role:'user', content:q}
    ],
    model: $('#modelSelect').value,
    temperature: parseFloat($('#temp').value),
    top_p: parseFloat($('#topP').value),
    max_tokens: parseInt($('#maxToks').value,10)
  };

  const msg = document.createElement('div');
  msg.className = 'chatMsg';
  msg.textContent = "";
  $('#chatLog').appendChild(msg);
  $('#chatLog').scrollTop = $('#chatLog').scrollHeight;

  state.streaming = true;
  const es = new EventSourcePolyfill('/api/chat/stream', { payload: body });
  let combined = "";
  es.onmessage = (ev)=>{
    // default messages (not used)
  };
  es.addEventListener('delta', (ev)=>{
    combined += ev.data;
    msg.textContent = combined;
    $('#chatLog').scrollTop = $('#chatLog').scrollHeight;
  });
  es.addEventListener('error', (ev)=>{
    msg.textContent += "\n[error streaming]";
    state.streaming = false;
    es.close();
  });
  es.addEventListener('end', (ev)=>{
    state.streaming = false;
    es.close();
  });

  // insert into editor if checked
  const insert = $('#cbInsert').checked;
  if(insert){
    const start = $('#editor').selectionStart;
    const end = $('#editor').selectionEnd;
    const interval = setInterval(()=>{
      // every 150ms place current combined
      const before = $('#editor').value.slice(0, start);
      const after = $('#editor').value.slice(end);
      $('#editor').value = before + combined + after;
    }, 150);
    es.addEventListener('end', ()=> clearInterval(interval));
    es.addEventListener('error', ()=> clearInterval(interval));
  }
}

// SSE with POST body polyfill
class EventSourcePolyfill {
  constructor(url, options={}){
    this.url = url;
    this.payload = options.payload || null;
    this.es = null;
    this.listeners = {};
    this.init();
  }
  async init(){
    // Use fetch + ReadableStream to simulate SSE client
    const res = await fetch(this.url, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify(this.payload)
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const emit = (type, data)=>{
      (this.listeners[type]||[]).forEach(fn=>fn({data}));
    };
    while(true){
      const {done, value} = await reader.read();
      if(done) break;
      buffer += decoder.decode(value, {stream:true});
      let idx;
      while((idx = buffer.indexOf("\n\n")) !== -1){
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx+2);
        const lines = chunk.split("\n");
        let event = "message";
        let data = "";
        for(const line of lines){
          if(line.startsWith("event:")) event = line.slice(6).trim();
          else if(line.startsWith("data:")) data += line.slice(5).trim();
        }
        if(event === "delta"){
          this.dispatchEvent("delta", data);
        }else if(event === "error"){
          this.dispatchEvent("error", data);
        }else{
          this.dispatchEvent("message", data);
        }
      }
    }
    this.dispatchEvent("end","");
  }
  addEventListener(type, fn){
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }
  removeEventListener(type, fn){
    this.listeners[type] = (this.listeners[type]||[]).filter(f=>f!==fn);
  }
  dispatchEvent(type, data){
    (this.listeners[type]||[]).forEach(fn=>fn({data}));
  }
  close(){}
}

// simple line number helper (visual only)
function highlightLineNumbers(){
  // kept minimal; textarea remains simple for offline operation
}

window.addEventListener('load', init);
