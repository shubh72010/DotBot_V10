// App front-end logic: model upload, chat UI, simple local "inference" stub, IndexedDB storage for chats
(function(){
  const modelFileInput = document.getElementById('modelFile');
  const dropZone = document.getElementById('dropZone');
  const modelInfo = document.getElementById('modelInfo');
  const chatLog = document.getElementById('chatLog');
  const promptForm = document.getElementById('promptForm');
  const promptInput = document.getElementById('prompt');
  const clearBtn = document.getElementById('clearSession');
  const stopBtn = document.getElementById('stopBtn');

  let currentModel = null;
  let running = false;

  // Minimal IndexedDB wrapper for chat history and model metadata
  const DB = (function(){
    const name = 'dotbot-store';
    const version = 1;
    let db = null;
    function open(){
      return new Promise((res,rej)=>{
        const r = indexedDB.open(name, version);
        r.onupgradeneeded = e => {
          const d = e.target.result;
          if(!d.objectStoreNames.contains('chats')) d.createObjectStore('chats', {keyPath:'id', autoIncrement:true});
          if(!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', {keyPath:'k'});
        };
        r.onsuccess = e=>{ db = e.target.result; res(db); };
        r.onerror = e=> rej(e.target.error);
      });
    }
    async function put(store, val){
      db = db || await open();
      return new Promise((res,rej)=>{
        const tx = db.transaction(store, 'readwrite');
        const st = tx.objectStore(store);
        const req = st.put(val);
        req.onsuccess = ()=>res(req.result);
        req.onerror = ()=>rej(req.error);
      });
    }
    async function getAll(store){
      db = db || await open();
      return new Promise((res,rej)=>{
        const tx = db.transaction(store, 'readonly');
        const st = tx.objectStore(store);
        const req = st.getAll();
        req.onsuccess = ()=>res(req.result);
        req.onerror = ()=>rej(req.error);
      });
    }
    async function clear(store){
      db = db || await open();
      return new Promise((res,rej)=>{
        const tx = db.transaction(store, 'readwrite');
        const st = tx.objectStore(store);
        const req = st.clear();
        req.onsuccess = ()=>res(); req.onerror = ()=>rej(req.error);
      });
    }
    return {open,put,getAll,clear};
  })();

  function addMessage(role, text){
    const el = document.createElement('div');
    el.className = 'message ' + (role==='user'?'user':'bot');
    const b = document.createElement('div'); b.className='bubble';
    b.textContent = text;
    el.appendChild(b);
    chatLog.appendChild(el);
    chatLog.scrollTop = chatLog.scrollHeight;
    // persist
    DB.put('chats', {role, text, ts: Date.now()}).catch(console.warn);
  }

  // Drag & drop
  dropZone.addEventListener('dragover', e=>{e.preventDefault(); dropZone.classList.add('drag');});
  dropZone.addEventListener('dragleave', e=>{dropZone.classList.remove('drag')});
  dropZone.addEventListener('drop', e=>{e.preventDefault(); dropZone.classList.remove('drag'); const f = e.dataTransfer.files[0]; handleFile(f);});

  modelFileInput.addEventListener('change', e=>{const f = e.target.files[0]; if(f) handleFile(f);});

  function humanFileSize(bytes){
    const thresh = 1024; if(Math.abs(bytes) < thresh) return bytes + ' B';
    const units = ['KB','MB','GB','TB']; let u=-1; do{bytes /= thresh; ++u}while(Math.abs(bytes) >= thresh && u < units.length-1);
    return bytes.toFixed(1)+' '+units[u];
  }

  async function handleFile(file){
    if(!file) return;
    currentModel = {name: file.name, size: file.size, uploadedAt: Date.now()};
    modelInfo.innerHTML = `<strong>${file.name}</strong><div>Size: ${humanFileSize(file.size)}</div><div>Path: (local file)</div>`;
    // show progress UI
    const progressWrap = document.getElementById('loadProgress');
    const progressBar = document.getElementById('loadProgressBar');
    const memoryWarn = document.getElementById('memoryWarn');
    progressWrap.setAttribute('aria-hidden', 'false'); progressBar.style.width = '0%'; memoryWarn.textContent = '';
    // store meta (but not content) — we intentionally do not persist model bytes
    await DB.put('meta', {k: 'model', name: file.name, size: file.size, at: Date.now()});
    // load into wasm runtime (stub)
    try{
      await WASMLoader.loadFromFile(file, {
        onProgress: (loaded, total) => {
          const pct = total ? Math.round((loaded/total)*100) : 0;
          progressBar.style.width = pct + '%';
        },
        useWebGPU: !!document.getElementById('useWebGPU').checked
      });
      progressBar.style.width = '100%';
      // memory heuristic: warn if model > 2GB (heuristic, adjust as needed)
      if(file.size > 2 * 1024 * 1024 * 1024){ memoryWarn.textContent = 'Warning: model is very large and may exceed browser memory limits.'; }
      addMessage('bot', `Model \"${file.name}\" loaded.`);
    }catch(err){
      console.error(err); addMessage('bot', 'Failed to load model: '+err.message);
    }
  }

  // Prompt form
  promptForm.addEventListener('submit', async e=>{
    e.preventDefault(); const text = promptInput.value.trim(); if(!text) return; promptInput.value=''; addMessage('user', text);
    if(!WASMLoader.isLoaded()){
      addMessage('bot','No model loaded. Please upload a .gguf model first.');
      return;
    }
    running = true; stopBtn.disabled = false;
    // Run inference via WASMLoader (stubbed) — we simulate streaming
    try{
      // token-level streaming: create a bot message and append small token spans
      addMessage('bot', '');
      let botEl = chatLog.lastElementChild;
      const bubble = botEl.querySelector('.bubble');
      for await (const token of WASMLoader.generate(text, {
        maxTokens: Number(document.getElementById('maxTokens').value||128),
        temperature: Number(document.getElementById('temperature').value||0.7)
      })){
        if(!running) break;
        const span = document.createElement('span'); span.className='token'; span.textContent = token;
        bubble.appendChild(span);
        chatLog.scrollTop = chatLog.scrollHeight;
      }
    }catch(err){ console.error(err); addMessage('bot','Error during generation: '+err.message); }
    running = false; stopBtn.disabled = true;
  });

  stopBtn.addEventListener('click', ()=>{ running = false; WASMLoader.stop(); stopBtn.disabled = true; addMessage('bot','Generation stopped.'); });

  clearBtn.addEventListener('click', async ()=>{ await DB.clear('chats'); chatLog.innerHTML=''; addMessage('bot','Session cleared.'); });

  // load stored chat history + meta on startup
  (async function init(){
    try{
      const meta = (await DB.getAll('meta')).find(m=>m.k==='model');
      if(meta){ modelInfo.innerHTML = `<strong>${meta.name}</strong><div>Size: ${humanFileSize(meta.size)}</div><div>Previously loaded (local file required to actually use)</div>`; }
      const chats = await DB.getAll('chats');
      chats.sort((a,b)=>a.ts - b.ts).forEach(c=> addMessage(c.role, c.text));
      // basic feature detection
      if(!navigator.gpu) console.log('WebGPU not available');
    }catch(err){ console.warn('DB init failed', err); }
  })();

})();
