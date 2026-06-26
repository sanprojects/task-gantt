import esbuild from "esbuild";
import process from "process";
import { builtinModules as builtins } from "node:module";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { watch as watchFile } from "node:fs";
import { join } from "node:path";

const prod = process.argv[2] === "production";

// 開発時、ビルド成果物を稼働中の Obsidian プラグインフォルダへ同期する
// In dev, mirror build artifacts into a running Obsidian plugin folder so changes show up live.
// Enable by exporting VAULT_PLUGIN_DIR (see scripts/dev.sh).
const vaultDir = process.env.VAULT_PLUGIN_DIR;

// copyFile uses clonefile on APFS and can leave a stale destination; read+write truncates reliably.
async function copyOne(f) {
  try {
    await writeFile(join(vaultDir, f), await readFile(f));
  } catch (e) {
    console.warn(`[sync-to-vault] ${f}: ${e.message}`);
  }
}

const syncToVault = {
  name: "sync-to-vault",
  setup(build) {
    if (prod || !vaultDir) return;
    build.onEnd(async (result) => {
      if (result.errors.length) return;
      await mkdir(vaultDir, { recursive: true });
      for (const f of ["main.js", "manifest.json", "styles.css"]) await copyOne(f);
      console.log(`[sync-to-vault] synced -> ${vaultDir}`);
    });
  },
};

// Obsidian が提供する依存と Node 標準モジュールは external にする
// Mark Obsidian-provided deps and Node built-ins as external
const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtins,
  ],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: prod,
  plugins: [syncToVault],
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
  // styles.css / manifest.json aren't part of the JS dependency graph, so esbuild's
  // watcher never re-runs for them. Watch them directly and mirror to the vault on change.
  if (vaultDir) {
    for (const f of ["styles.css", "manifest.json"]) {
      let t = null;
      watchFile(f, () => {
        clearTimeout(t); // debounce editor multi-event saves
        t = setTimeout(async () => {
          await copyOne(f);
          console.log(`[sync-to-vault] ${f} -> vault`);
        }, 50);
      });
    }
  }
}
