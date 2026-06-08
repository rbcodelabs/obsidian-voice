import esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isWatch = process.argv.includes('--watch');
const outdir = path.join(__dirname, 'dist');

if (!fs.existsSync(outdir)) fs.mkdirSync(outdir, { recursive: true });

// ── Wake word ONNX / WASM assets ──────────────────────────────────────────
// These files are loaded at runtime from the plugin directory via the filesystem,
// so they must be present alongside main.js in every deployed location.
const TRAINING_OUTPUT = path.join(
  process.env.HOME,
  'projects/hey-obsidian-wakeword/output/hey_obsidian',
);
const ORT_WASM_DIR = path.join(__dirname, 'node_modules/onnxruntime-web/dist');
const OWW_RESOURCES = path.join(
  '/opt/homebrew/lib/python3.14/site-packages/livekit/wakeword/resources',
);

// Committed model files used as fallback when local training paths are absent (e.g. CI).
const MODELS_DIR = path.join(__dirname, 'models');

function resolveModel(primaryPath, modelFile) {
  if (fs.existsSync(primaryPath)) return primaryPath;
  const fallback = path.join(MODELS_DIR, modelFile);
  if (fs.existsSync(fallback)) return fallback;
  return primaryPath; // let copyWakeWordAssets warn via its existsSync check
}

const WAKE_WORD_ASSETS = [
  // Three-stage ONNX pipeline — prefer local training output, fall back to models/
  { src: resolveModel(path.join(OWW_RESOURCES, 'melspectrogram.onnx'),  'melspectrogram.onnx'),  dest: 'melspectrogram.onnx'  },
  { src: resolveModel(path.join(OWW_RESOURCES, 'embedding_model.onnx'), 'embedding_model.onnx'), dest: 'embedding_model.onnx' },
  { src: resolveModel(path.join(TRAINING_OUTPUT, 'hey_obsidian.onnx'),  'hey_obsidian.onnx'),    dest: 'hey_obsidian.onnx'    },
  // WASM runtime — both the binary and the Emscripten JS glue must be present
  // so onnxruntime-web can import them via file:// URLs (set via wasmPaths).
  { src: path.join(ORT_WASM_DIR, 'ort-wasm-simd-threaded.wasm'), dest: 'ort-wasm-simd-threaded.wasm' },
  { src: path.join(ORT_WASM_DIR, 'ort-wasm-simd-threaded.mjs'),  dest: 'ort-wasm-simd-threaded.mjs'  },
];

function copyWakeWordAssets(destDir) {
  for (const { src, dest } of WAKE_WORD_ASSETS) {
    const target = path.join(destDir, dest);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, target);
    } else {
      console.warn(`[wake-word] asset not found, skipping: ${src}`);
    }
  }
}

const ctx = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  // Force onnxruntime-web to use the WASM browser build instead of the
  // Node.js build (ort.node.min.mjs).  The Node build calls
  // createRequire(import.meta.url) at module init time; import.meta.url
  // becomes undefined when esbuild emits CJS, causing an immediate crash.
  // The WASM build has no createRequire and works fine with wasmBinary.
  alias: {
    'onnxruntime-web': path.resolve(__dirname, 'node_modules/onnxruntime-web/dist/ort.wasm.min.mjs'),
  },
  // import.meta.url is undefined in bundled CJS; provide a harmless fallback
  // so onnxruntime-web's URL-resolution helpers return undefined gracefully
  // instead of throwing. wasmBinary bypasses URL-based WASM loading anyway.
  define: {
    'import.meta.url': JSON.stringify(''),
    // Inline the Emscripten JS glue at build time so it is always available
    // inside main.js regardless of what files BRAT installs.  The content is
    // wrapped in a Blob → blob: URL by loadModels(), exactly as before, but
    // without any disk read that could fail on iCloud-evicted or missing files.
    '__ORT_MJS_CONTENT__': JSON.stringify(
      fs.existsSync(path.join(ORT_WASM_DIR, 'ort-wasm-simd-threaded.mjs'))
        ? fs.readFileSync(path.join(ORT_WASM_DIR, 'ort-wasm-simd-threaded.mjs'), 'utf8')
        : ''
    ),
  },
  external: [
    'obsidian',
    'electron',
    'codemirror',
    '@codemirror/autocomplete',
    '@codemirror/closebrackets',
    '@codemirror/commands',
    '@codemirror/fold',
    '@codemirror/gutter',
    '@codemirror/highlight',
    '@codemirror/history',
    '@codemirror/language',
    '@codemirror/lint',
    '@codemirror/matchbrackets',
    '@codemirror/panel',
    '@codemirror/rangeset',
    '@codemirror/rectangular-selection',
    '@codemirror/search',
    '@codemirror/state',
    '@codemirror/stream-parser',
    '@codemirror/text',
    '@codemirror/tooltip',
    '@codemirror/view',
  ],
  format: 'cjs',
  target: 'es2020',
  platform: 'node',
  logLevel: 'info',
  sourcemap: 'inline',
  treeShaking: true,
  outfile: 'dist/main.js',
});

// Copy static assets
fs.copyFileSync('manifest.json', 'dist/manifest.json');
if (fs.existsSync('styles.css')) fs.copyFileSync('styles.css', 'dist/styles.css');

// Copy ONNX + WASM assets to dist/ as well (for local dev inspection)
copyWakeWordAssets(outdir);

if (isWatch) {
  await ctx.watch();
  console.log('Watching for changes...');
} else {
  await ctx.rebuild();
  await ctx.dispose();
  console.log('Build complete');
}
