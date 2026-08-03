// GuideGen — the narrator's voice, fetched once and kept (window.FSVoice)
//
// Narration used to mean an 89MB extension, 77MB of which was two files: the voice
// model and espeak-ng's pronunciation dictionary. Everyone paid that download — on
// install, before knowing whether they wanted a narrated video at all — and a 68MB
// ZIP is also the single biggest obstacle to a tester ever trying the product.
//
// So those two files are no longer in the package. They are fetched the first time
// someone exports a narrated video, verified, stored on the machine, and never
// fetched again. Everything else is unchanged: the *synthesis* still happens locally,
// so the text of someone's internal processes still never leaves their computer.
// We download a voice to the machine; we never upload words off it.
//
// Four rules govern this file:
//
// 1. **Only data is ever fetched — never code.** Chrome's remote-code rule is not a
//    guideline, it is grounds for removal. `ort-wasm-simd.wasm`, `piper_phonemize.wasm`
//    and both loader scripts stay inside the package, where a reviewer can read them.
//    What comes over the wire is a tensor file and a pronunciation dictionary, which
//    are data in exactly the way a font or a photograph is.
// 2. **Every download is checked against a known SHA-256 before it is used or
//    stored.** A truncated file would otherwise reach onnxruntime as a corrupt model
//    and fail somewhere unrecognisable, and a substituted one would be a voice we
//    never shipped. The hashes below were taken from the files this build was
//    developed against.
// 3. **A bundled copy always wins.** If the files are present in `lib/` — a developer
//    checkout, or a full build made for an offline install — they are used directly and
//    nothing is fetched. That keeps local work and any air-gapped build identical to
//    how they behaved before this file existed.
// 4. **Failure degrades, never breaks.** If the fetch fails, `exporters.js` already
//    falls back to a silent captioned video, which is the behaviour when the voice
//    files are missing today. Losing narration on a flaky connection beats losing
//    the export.
(function () {
  var DB = "gg_voice";
  var STORE = "assets";
  var RELEASE = "https://github.com/heygauravsingh/GuideGen/releases/download/voice-v1/";

  /* The two files, their expected size and hash, and where each one lives.
     `local` is the in-package path — checked first, and absent from the store build. */
  var ASSETS = {
    voice: {
      name: "en_US-hfc_female-medium.onnx",
      local: "lib/voices/en_US-hfc_female-medium.onnx",
      bytes: 63201294,
      sha256: "914c473788fc1fa8b63ace1cdcdb44588f4ae523d3ab37df1536616835a140b7",
      label: "voice",
    },
    piperData: {
      name: "piper_phonemize.data",
      local: "lib/piper/piper_phonemize.data",
      bytes: 18077249,
      sha256: "29f1025eb23a5b5c192cd14a6efbce4509402ff265405072ee6f7d1a09b78f8c",
      label: "pronunciation dictionary",
    },
  };

  function extUrl(p) {
    return typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL
      ? chrome.runtime.getURL(p)
      : p;
  }

  // ---------------------------------------------------------------- the store
  //
  // IndexedDB rather than chrome.storage.local: these are 60MB binaries, and
  // chrome.storage stringifies what it holds. IndexedDB takes an ArrayBuffer as an
  // ArrayBuffer.
  function openDb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB, 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error("Could not open the voice store")); };
    });
  }

  function idbGet(key) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, "readonly");
        var req = tx.objectStore(STORE).get(key);
        req.onsuccess = function () { resolve(req.result || null); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function idbPut(key, value) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(value, key);
        tx.oncomplete = function () { resolve(true); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  // The hash is part of the key, so a future build that ships a different voice
  // simply misses the old entry rather than having to know how to evict it.
  function keyOf(a) { return a.name + "@" + a.sha256; }

  // ---------------------------------------------------------------- integrity

  function sha256Hex(buf) {
    return crypto.subtle.digest("SHA-256", buf).then(function (digest) {
      var out = "";
      var bytes = new Uint8Array(digest);
      for (var i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
      return out;
    });
  }

  function verify(a, buf) {
    if (buf.byteLength !== a.bytes) {
      return Promise.reject(new Error(
        "The " + a.label + " downloaded incompletely (" + buf.byteLength +
        " of " + a.bytes + " bytes). Check the connection and try again."));
    }
    return sha256Hex(buf).then(function (hex) {
      if (hex !== a.sha256) {
        throw new Error("The " + a.label + " didn't match its checksum, so it wasn't used.");
      }
      return buf;
    });
  }

  // ---------------------------------------------------------------- fetching

  /* Streamed rather than a plain arrayBuffer() so there is a real progress number to
     show. A 60MB download with no indication of progress reads as a hang, and this one
     happens the first time someone presses a button they were excited about. */
  function download(a, onProgress) {
    return fetch(RELEASE + a.name, { cache: "no-store" }).then(function (res) {
      if (!res.ok) throw new Error("Couldn't download the " + a.label + " (" + res.status + ").");
      var total = Number(res.headers.get("content-length")) || a.bytes;
      if (!res.body || !res.body.getReader) return res.arrayBuffer();

      var reader = res.body.getReader();
      var chunks = [];
      var got = 0;
      return (function pump() {
        return reader.read().then(function (r) {
          if (r.done) {
            var out = new Uint8Array(got);
            var at = 0;
            for (var i = 0; i < chunks.length; i++) { out.set(chunks[i], at); at += chunks[i].length; }
            return out.buffer;
          }
          chunks.push(r.value);
          got += r.value.length;
          if (onProgress) onProgress(got / total, got, total);
          return pump();
        });
      })();
    });
  }

  // ---------------------------------------------------------------- the one entry point

  var inFlight = {};

  /* Returns an ArrayBuffer for one asset. Concurrent callers share a single fetch —
     `init()` in tts.js asks for both, and a second export pressed while the first is
     still downloading must not start the download again. */
  function get(which, onProgress) {
    var a = ASSETS[which];
    if (!a) return Promise.reject(new Error("Unknown voice asset: " + which));
    if (inFlight[which]) return inFlight[which];

    var job = (function () {
      // 1. Already on this machine?
      return idbGet(keyOf(a)).then(function (hit) {
        if (hit && hit.byteLength === a.bytes) return hit;

        // 2. Bundled in the package? A developer checkout or a full offline build.
        return fetch(extUrl(a.local)).then(function (res) {
          if (!res.ok) throw new Error("not bundled");
          return res.arrayBuffer();
        }).catch(function () {
          // 3. Fetch it, check it, keep it.
          if (onProgress) onProgress(0, 0, a.bytes);
          return download(a, onProgress)
            .then(function (buf) { return verify(a, buf); })
            .then(function (buf) {
              // A cache write that fails is not a reason to fail the export — the
              // download already succeeded and the bytes are in hand. Next time it
              // downloads again, which is annoying rather than broken.
              return idbPut(keyOf(a), buf).catch(function () { return true; }).then(function () { return buf; });
            });
        });
      });
    })();

    inFlight[which] = job;
    job.catch(function () {}).then(function () { delete inFlight[which]; });
    return job;
  }

  /* Is everything already on the machine — so a narrated export starts instantly? The
     dialog uses this to say whether the first one will pay a download. */
  function cached() {
    var names = Object.keys(ASSETS);
    return Promise.all(names.map(function (n) {
      var a = ASSETS[n];
      return idbGet(keyOf(a))
        .then(function (hit) { return !!(hit && hit.byteLength === a.bytes); })
        .catch(function () { return false; });
    })).then(function (all) {
      return all.every(Boolean);
    });
  }

  function totalBytes() {
    return Object.keys(ASSETS).reduce(function (n, k) { return n + ASSETS[k].bytes; }, 0);
  }

  window.FSVoice = { get: get, cached: cached, totalBytes: totalBytes, ASSETS: ASSETS };
})();
