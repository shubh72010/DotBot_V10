# DotBot — Local GGUF Inference (static client scaffold)

This is a minimal static scaffold that demonstrates a browser-first workflow for running GGUF-style models locally in the browser (WASM/WebGPU). The current project contains a UI, drag-and-drop upload, IndexedDB chat storage, and a stubbed WASM loader.

What you'll find
- `index.html` — static UI
- `styles.css` — styles
- `app.js` — front-end logic: upload, chat UI, IndexedDB persistence
- `wasm-loader.js` — loader stub — place to integrate ggml.js / llama.cpp WASM

How to run
1. Serve the folder as static files. For a quick test you can run a simple HTTP server. In PowerShell:

```powershell
# using Python 3.x installed on Windows
python -m http.server 8000

# then open http://localhost:8000 in your browser
```

Notes on integrating a real runtime
- Use ggml.js, llama.cpp WASM builds, or a project that exposes a JS API to load GGUF bytes in the browser.
- The scaffold includes `wasm-loader.js` which exposes a small backend registration API. Implement a backend with shape:

	- name: string
	- load(arrayBuffer, {onProgress}) => Promise<instance>
	- generate(instance, prompt, opts) => async generator yielding string chunks
	- stop(instance) => void

- Example adapter sketches (pseudocode):

	1) ggml.js-like adapter

		 const ggmlBackend = {
			 name: 'ggml.js',
			 async load(arrayBuffer, {onProgress}){
				 // instantiate runtime, create model from bytes
				 const instance = await GGMLJS.instantiate({modelBuffer: arrayBuffer});
				 return instance;
			 },
			 async *generate(instance, prompt, opts){
				 const stream = instance.createStream(prompt, opts);
				 for await (const token of stream){ yield token; }
			 },
			 stop(instance){ instance.stop(); }
		 };

	2) llama.cpp WASM adapter

		 const llamaBackend = {
			 name: 'llama.cpp-wasm',
			 async load(arrayBuffer, {onProgress}){
				 // llama.cpp wasm usually exposes a loader that accepts bytes
				 const inst = await LlamaWASM.loadModel(arrayBuffer, {useWebGPU: true});
				 return inst;
			 },
			 async *generate(inst, prompt, opts){
				 const gen = inst.startGenerate(prompt, opts);
				 for await (const chunk of gen){ yield chunk; }
			 },
			 stop(inst){ inst.requestStop(); }
		 };

- To register your backend in the UI, call `WASMLoader.registerBackend(ggmlBackend)` before calling `WASMLoader.loadFromFile`.
- Memory & performance notes
	- Browser memory is limited; prefer quantized models (4-bit/8-bit) for large architectures.
	- Use WebGPU-backed runtimes when available. WebAssembly + WebGPU can dramatically reduce inference time.
	- If you see OOM/Allocation errors while loading, try smaller/quantized models or a runtime that supports streaming/chunked loading.

	Getting ggml.js / llama.cpp WASM (recommended canonical build)

	Recommendation: use a wasm build from the `llama.cpp` community or a maintained ggml.js release that targets WebAssembly and optionally WebGPU. A commonly used source is the `llama.cpp` wasm builds (or community-packaged ggml.js distributions). Below are exact steps that work for most setups.

	1) Download runtime files

	- Example canonical place: the `llama.cpp` repo wasm builds or the community `ggml.js` releases. (Check the project's releases page for `wasm` or `web` artifacts.)
	- You should end up with at minimum:

		- `runtimes/ggml/ggml.js`  (glue script that initializes the wasm module and exposes a global)
		- `runtimes/ggml/ggml.wasm` (the WebAssembly binary)

	2) Place the files in the project

	Create the folder `runtimes/ggml/` inside the project and copy `ggml.js` and `ggml.wasm` there.

	3) Edit `index.html` to include the runtime before our loader and app scripts. Example snippet (insert into `<head>` or before our scripts):

	```html
	<!-- runtime (example paths) -->
	<script src="runtimes/ggml/ggml.js"></script>
	<!-- the scaffold scripts — ensure wasm-loader comes after the runtime -->
	<script src="wasm-loader.js"></script>
	<script src="app.js"></script>
	```

	4) Confirm global presence

	After including the runtime, open the browser console and verify a global exists (try `window.GGML` or `window.LlamaWasm` depending on the build). Our adapter tries several common global names.

	5) If your runtime has different APIs

	Modify `wasm-loader.js` adapter functions to match the runtime's API. The adapter in this scaffold attempts to detect common methods (`loadModelFromBuffer`, `loadModel`, `createModel`, `generateStream`, `generate`, `stream`) and will work with many community builds.

	WebGPU note

	The adapter will pass `useWebGPU: true` when the "Use WebGPU" option is enabled. Ensure your chosen build supports WebGPU (some builds require additional setup or specific browser flags). The browser may prompt the user for permission to use WebGPU.



Privacy & limits
- Browser memory is limited (commonly 8–12GB); large models may still not fit.
- Consider chunked loading or paging for very large models; but that requires a runtime that supports partial loading.

Next steps (suggested)
- Integrate a real WASM runtime (ggml.js or llama.cpp wasm)
- Add progress/health reporting during model load
- Add streaming UI improvements and token-level updates
- Add model quantization helper or conversion instructions
