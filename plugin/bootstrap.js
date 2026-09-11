"use strict";

const TRANSLATOR_MODULES = Object.freeze([
  "core.js",
  "page-text-index.js",
  "selection-block.js",
  "front-matter-extractor.js",
  "content-segments.js",
  "translation-service.js",
  "provider-runtime-patches.js",
  "reader-target-locator.js",
  "overlay-layout.js",
  "overlay-renderer.js",
  "reader-overlay.js",
  "provider-panel.js",
  "translation-workflows.js",
  "app-controller.js"
]);

function loadTranslatorModules(rootURI) {
  for (const script of TRANSLATOR_MODULES) {
    Services.scriptloader.loadSubScript(rootURI + script, globalThis, "UTF-8");
  }
}

async function startup({ rootURI }) {
  await Zotero.initializationPromise;
  await (Zotero.uiReadyPromise || Promise.resolve());
  const previousApp = globalThis.TranslatorForZoteroApp;
  if (previousApp?.shutdown && (previousApp.initialized
    || previousApp.readerEventHandlers?.size
    || previousApp.readerListenersRegistered?.size)) {
    try {
      // A bootstrap reload replaces the global app object. Shut down the old
      // instance first so its bound Reader handlers cannot survive the reload.
      previousApp.shutdown();
    }
    catch (error) {
      Zotero.logError?.(error);
    }
  }
  loadTranslatorModules(rootURI);
  await globalThis.TranslatorForZoteroApp.init(rootURI);
}

function onMainWindowLoad({ window }) {
  globalThis.TranslatorForZoteroApp?.onMainWindowLoad(window);
}

function shutdown(data, reason) {
  if (reason !== APP_SHUTDOWN) globalThis.TranslatorForZoteroApp?.shutdown();
}

function install() {}
function uninstall() {}
