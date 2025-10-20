// WASM loader helper with backend registration.
// Purpose: provide a small, well-documented bridge where a real WASM runtime (ggml.js, llama.cpp wasm)
// can be plugged in. This module handles file reading with progress and defines a simple backend API.
const WASMLoader = (function(){
  let backend = null;
  let backendInstance = null;
  let stopRequested = false;

  // Utility: read a File/Blob with progress using Streams API
  async function readFileWithProgress(file, onProgress){
    if(!file.stream) {
      // Fallback for older browsers: use arrayBuffer and report once
      const buf = await file.arrayBuffer();
      onProgress?.(buf.byteLength, file.size);
      return buf;
    }
    const reader = file.stream().getReader();
    const chunks = [];
    let loaded = 0;
    while(true){
      const {done, value} = await reader.read();
      if(done) break;
      chunks.push(value);
      loaded += value.byteLength || value.length || 0;
      onProgress?.(loaded, file.size);
    }
    // concat
    const total = loaded;
    const out = new Uint8Array(total);
    let offset = 0;
    for(const c of chunks){ out.set(c, offset); offset += c.byteLength || c.length || 0; }
    return out.buffer;
  }

  // Register an external backend.
  // Backend shape: { name, load: async (arrayBuffer, {onProgress}) => instance, generate: async function*(instance, prompt, opts) => yields strings, stop: (instance) => void }
  function registerBackend(b){
    backend = b; console.log('WASMLoader backend registered:', b?.name || 'unnamed');
  }

  async function loadFromFile(file, opts = {}){
    // opts: { onProgress }
    if(!file) throw new Error('No file provided');
    if(!backend || typeof backend.load !== 'function'){
      // if no backend, just simulate load (keeps prior behavior) but still report progress
      const buf = await readFileWithProgress(file, opts.onProgress);
      await new Promise(r=>setTimeout(r, 300));
      backendInstance = {__simulated: true, name: file.name, size: file.size};
      return backendInstance;
    }
    const arrayBuffer = await readFileWithProgress(file, opts.onProgress);
    backendInstance = await backend.load(arrayBuffer, {onProgress: opts.onProgress});
    return backendInstance;
  }

  function isLoaded(){ return !!backendInstance; }

  async function* generate(prompt, opts={}){
    if(!backendInstance) throw new Error('No model loaded');
    stopRequested = false;
    if(backend && typeof backend.generate === 'function'){
      for await (const chunk of backend.generate(backendInstance, prompt, opts)){
        if(stopRequested) break;
        yield chunk;
      }
      return;
    }
    // fallback simulated behavior
    const response = `Echoing prompt: ${prompt}\n\n[This is a simulated response. Register a backend with WASMLoader.registerBackend to run real models.]`;
    const parts = response.match(/.{1,60}/g) || [response];
    for(const p of parts){ if(stopRequested) break; await new Promise(r=>setTimeout(r, 120)); yield p; }
  }

  function stop(){ stopRequested = true; try{ backend?.stop?.(backendInstance); }catch(e){console.warn('backend stop failed', e);} }

  return {registerBackend, loadFromFile, isLoaded, generate, stop};
})();

// --- ggml.js adapter (example) -------------------------------------------------
// This adapter attempts to use a global `GGML` runtime object. Replace or adapt
// based on the specific ggml.js build you download.
const GGMLAdapter = (function(){
  async function load(arrayBuffer, {onProgress, useWebGPU=true}={}){
    // Detect common global runtime objects
    const win = (typeof window !== 'undefined') ? window : globalThis;
    const candidates = ['GGML','GGMLModule','LlamaWasm','Llama','LLAMA'];
    let runtime = null;
    for(const name of candidates){ if(name in win){ runtime = win[name]; break; } }
    if(!runtime) throw new Error('No ggml/llama wasm runtime detected. Please add a ggml.js/llama wasm build as described in README.');

    const opts = { useWebGPU: !!useWebGPU };

    // Common API 1: runtime.loadModelFromBuffer(arrayBuffer, opts)
    if(typeof runtime.loadModelFromBuffer === 'function'){
      return await runtime.loadModelFromBuffer(arrayBuffer, opts);
    }

    // Common API 2: runtime.loadModel(arrayBuffer, opts) or runtime.load(arrayBuffer)
    if(typeof runtime.loadModel === 'function'){
      return await runtime.loadModel(arrayBuffer, opts);
    }
    if(typeof runtime.load === 'function'){
      return await runtime.load(arrayBuffer, opts);
    }

    // Common API 3: some builds expose a factory: runtime.createModel(arrayBuffer, opts)
    if(typeof runtime.createModel === 'function'){
      return await runtime.createModel(arrayBuffer, opts);
    }

    // If runtime is actually a function that expects Module-style initialization
    if(typeof runtime === 'function'){
      // try calling it with options; many Emscripten modules accept an object
      const inst = await runtime({ locateFile: (f)=>f });
      if(typeof inst.loadModelFromBuffer === 'function'){
        return await inst.loadModelFromBuffer(arrayBuffer, opts);
      }
    }

    throw new Error('Detected runtime but could not find a compatible load API. See README for supported builds.');
  }

  async function* generate(instance, prompt, opts={}){
    // Try common streaming/generation APIs
    if(!instance) throw new Error('No instance provided');

    // 1) instance.generateStream -> async iterator yielding tokens
    if(typeof instance.generateStream === 'function'){
      for await (const token of instance.generateStream(prompt, opts)) yield token;
      return;
    }

    // 2) instance.stream or instance.streamGenerate
    if(typeof instance.stream === 'function'){
      for await (const token of instance.stream(prompt, opts)) yield token;
      return;
    }

    // 3) instance.generate returns a string/result
    if(typeof instance.generate === 'function'){
      const out = await instance.generate(prompt, opts);
      const s = String(out);
      const parts = s.match(/.{1,60}/g) || [s];
      for(const p of parts){ await new Promise(r=>setTimeout(r,10)); yield p; }
      return;
    }

    // 4) fallback: if instance.run exists and returns text
    if(typeof instance.run === 'function'){
      const out = await instance.run(prompt, opts);
      const s = String(out);
      const parts = s.match(/.{1,60}/g) || [s];
      for(const p of parts){ await new Promise(r=>setTimeout(r,10)); yield p; }
      return;
    }

    throw new Error('Instance does not expose a known generate API');
  }

  function stop(instance){ try{ instance.stop?.(); instance.requestStop?.(); }catch(e){ console.warn('ggml adapter stop failed', e); } }

  return { name: 'ggml.js-adaptive', load, generate, stop };
})();

// Auto-register if a likely runtime global exists
try{
  const w = (typeof window !== 'undefined') ? window : globalThis;
  if('GGML' in w || 'GGMLModule' in w || 'LlamaWasm' in w || 'Llama' in w){ WASMLoader.registerBackend(GGMLAdapter); }
}catch(e){/* ignore in odd environments */}

