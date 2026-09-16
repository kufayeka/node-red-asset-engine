// Bundle entry point — esbuild's `globalName: "KufayekaCM6"` assigns these
// exports onto window.KufayekaCM6, since asset-function.html/asset-plugin.html
// are plain <script> blocks (not ES modules) that need a global to call into.
export { createCM6Editor, openFullscreenCM6Editor } from "./cm6-code-editor.js";
export { assetPathCompletionSource } from "./asset-completions.js";
