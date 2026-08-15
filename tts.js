// GuideGen — offline neural narration (window.FSTTS)
//
// Piper (VITS) running entirely in-page: espeak-ng compiled to wasm turns text
// into phoneme ids, onnxruntime-web runs the voice model over them, and we get
// raw PCM back. No accounts, and the synthesis itself never touches the network.
//
// The engine — onnxruntime's wasm, piper's wasm, both loader scripts — is bundled. The
// two *data* files it needs (the 60MB voice model and espeak-ng's 18MB pronunciation
// dictionary) are fetched once on first use and kept on the machine; see voicecache.js
// for why, and for the rules that keeps this the right side of Chrome's remote-code
// policy. A developer checkout with `lib/` intact fetches nothing.
//
// Why not speechSynthesis: the Web Speech API gives you no audio stream, and on
// macOS its voices are rendered by the OS outside the tab's audio graph, so the
// narration can never be recorded into an export. Piper hands us samples we own,
// which is what the video exporter needs to mix into MediaRecorder.
(function () {
  const PATHS = {
    ort: "lib/ort/",
    ortScript: "lib/ort/ort.wasm.min.js",
    piperScript: "lib/piper/piper_phonemize.js",
    piperWasm: "lib/piper/piper_phonemize.wasm",
    piperData: "lib/piper/piper_phonemize.data",
    voice: "lib/voices/en_US-hfc_female-medium.onnx",
    voiceConfig: "lib/voices/en_US-hfc_female-medium.onnx.json",
  };

  // Absolute extension URL when we're inside the extension, plain relative path
  // when a scratch/test page loads this file over http.
  function url(p) {
    return typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL
      ? chrome.runtime.getURL(p)
      : p;
  }

  /* **Only ever a file inside this extension, and now it is enforced rather than assumed.**
     The speech engine is two large bundled files that most sessions never need, so they are
     attached on demand instead of costing every offscreen document 260KB of parse time. The shape
     of that — build a <script>, set .src, append it — is also the shape of loading code off the
     internet, which is banned outright in a Manifest V3 extension and is what v1.2.7 was rejected
     for (the actual offender was a CDN URL inside the vendored jsPDF; see the note at the top of
     that file). The path is checked against this extension's own origin before anything is
     appended, so this function cannot become that even by mistake. */
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const abs = url(src);
      const base = typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL
        ? chrome.runtime.getURL("")
        : null;
      if (base && abs.indexOf(base) !== 0) {
        return reject(new Error("Refusing to load a script from outside the extension: " + abs));
      }
      if (document.querySelector('script[data-fstts="' + src + '"]')) return resolve();
      const s = document.createElement("script");
      s.src = abs;
      s.dataset.fstts = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("Could not load " + src));
      document.head.appendChild(s);
    });
  }

  let readyPromise = null;
  // A blob: URL for the pronunciation dictionary, handed to Emscripten's locateFile.
  // Lives as long as this document does, which for the offscreen renderer is one export.
  let dataUrl = null;
  let ort = null;
  let session = null;
  let cfg = null;

  // Loads the runtime + voice model once; concurrent callers share the promise.
  function init(onProgress) {
    if (readyPromise) return readyPromise;
    const prog = (m) => onProgress && onProgress(m);
    readyPromise = (async () => {
      prog("Loading speech engine…");
      await loadScript(PATHS.ortScript);
      await loadScript(PATHS.piperScript);
      if (!window.ort) throw new Error("onnxruntime-web did not load");
      if (!window.createPiperPhonemize) throw new Error("piper phonemizer did not load");

      ort = window.ort;
      // Single-threaded on purpose: wasm threads need SharedArrayBuffer, which
      // needs COOP/COEP headers we can't set on an extension page.
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.proxy = false;
      ort.env.wasm.wasmPaths = url(PATHS.ort);
      ort.env.logLevel = "error";

      // Tiny and always bundled: it names the espeak voice and the sample rate, and
      // there is no sense fetching 5KB.
      const cfgRes = await fetch(url(PATHS.voiceConfig));
      if (!cfgRes.ok) throw new Error("Missing voice config");
      cfg = await cfgRes.json();

      if (!window.FSVoice) throw new Error("voicecache.js did not load");

      /* Both data files, with a real progress number. `FSVoice.get` returns instantly
         when they are already on the machine or bundled in the package, so the wording
         below only ever appears on someone's first narrated export. */
      const say = (label) => (frac, got, total) => {
        if (!total) return prog("Fetching the " + label + "…");
        const mb = (n) => (n / 1048576).toFixed(0);
        prog("Downloading the " + label + " — " + mb(got) + " of " + mb(total) +
             " MB (one time only)");
      };

      prog("Loading voice…");
      const model = await window.FSVoice.get("voice", say("voice"));
      // Fetched here rather than lazily inside phonemize(): Emscripten's locateFile has
      // to answer synchronously, so the bytes must already be in hand by then.
      const dict = await window.FSVoice.get("piperData", say("pronunciation dictionary"));
      dataUrl = URL.createObjectURL(new Blob([dict], { type: "application/octet-stream" }));

      prog("Warming up voice…");
      session = await ort.InferenceSession.create(model, {
        executionProviders: ["wasm"],
        graphOptimizationLevel: "all",
      });
    })().catch((e) => {
      readyPromise = null; // let a later attempt retry from scratch
      throw e;
    });
    return readyPromise;
  }

  // espeak-ng prints one JSON line per sentence it finds, so a multi-sentence
  // note comes back as several phoneme sequences — we keep all of them.
  function phonemize(text) {
    return new Promise((resolve, reject) => {
      const seqs = [];
      let failed = null;
      window
        .createPiperPhonemize({
          print: (line) => {
            try {
              const j = JSON.parse(line);
              if (j && j.phoneme_ids && j.phoneme_ids.length) seqs.push(j.phoneme_ids);
            } catch (e) {
              /* non-JSON chatter from the tool — ignore */
            }
          },
          printErr: (m) => { if (!failed) failed = new Error("phonemizer: " + m); },
          locateFile: (p) => {
            // The wasm is bundled — it is code, and code is never fetched. The .data is
            // the dictionary, already downloaded and verified by voicecache.js.
            if (p.endsWith(".wasm")) return url(PATHS.piperWasm);
            if (p.endsWith(".data")) return dataUrl || url(PATHS.piperData);
            return p;
          },
        })
        .then((mod) => {
          try {
            // print() fires synchronously while main runs, so seqs is filled
            // by the time callMain returns.
            mod.callMain([
              "-l", cfg.espeak.voice,
              "--input", JSON.stringify([{ text: String(text || "").trim() }]),
              "--espeak_data", "/espeak-ng-data",
            ]);
          } catch (e) {
            return reject(failed || e);
          }
          if (seqs.length) return resolve(seqs);
          reject(failed || new Error("nothing to speak"));
        }, reject);
    });
  }

  async function infer(ids, lengthScale) {
    const len = ids.length;
    const feeds = {
      input: new ort.Tensor("int64", BigInt64Array.from(ids, (v) => BigInt(v)), [1, len]),
      input_lengths: new ort.Tensor("int64", BigInt64Array.from([BigInt(len)]), [1]),
      scales: new ort.Tensor(
        "float32",
        Float32Array.from([cfg.inference.noise_scale, lengthScale, cfg.inference.noise_w]),
        [3]
      ),
    };
    if (cfg.speaker_id_map && Object.keys(cfg.speaker_id_map).length) {
      feeds.sid = new ort.Tensor("int64", BigInt64Array.from([BigInt(0)]), [1]);
    }
    const out = await session.run(feeds);
    const first = out.output || out[session.outputNames[0]];
    return first.data; // Float32Array, mono, cfg.audio.sample_rate
  }

  function join(parts, sampleRate, gapSecs) {
    const gap = Math.round(sampleRate * gapSecs);
    let total = 0;
    parts.forEach((p, i) => (total += p.length + (i ? gap : 0)));
    const out = new Float32Array(total);
    let at = 0;
    parts.forEach((p, i) => {
      if (i) at += gap;
      out.set(p, at);
      at += p.length;
    });
    return out;
  }

  // Synthesize `text` to mono PCM. `rate` > 1 speaks faster (it scales Piper's
  // length_scale inversely, which changes tempo without shifting pitch).
  async function synth(text, opts) {
    opts = opts || {};
    await init(opts.onProgress);
    const clean = String(text || "").trim();
    if (!clean) return { pcm: new Float32Array(0), sampleRate: cfg.audio.sample_rate, duration: 0 };
    const lengthScale = (cfg.inference.length_scale || 1) / (opts.rate || 1);
    const seqs = await phonemize(clean);
    const parts = [];
    for (const ids of seqs) parts.push(await infer(ids, lengthScale));
    const pcm = join(parts, cfg.audio.sample_rate, 0.16);
    return {
      pcm,
      sampleRate: cfg.audio.sample_rate,
      duration: pcm.length / cfg.audio.sample_rate,
    };
  }

  // True when the vendored assets are actually present, so callers can degrade
  // to a silent captioned video instead of throwing mid-export.
  async function available() {
    try {
      const r = await fetch(url(PATHS.voiceConfig), { method: "HEAD" });
      return r.ok;
    } catch (e) {
      return false;
    }
  }

  window.FSTTS = { init, synth, available, PATHS };
})();
