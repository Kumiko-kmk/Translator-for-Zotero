"use strict";

if (process.env.TRANSLATION_LIVE_TEST !== "1") {
  console.log("translation live smoke test skipped; set TRANSLATION_LIVE_TEST=1 to run");
  process.exit(0);
}

const assert = require("assert");
const dns = require("dns");
const fs = require("fs");
const https = require("https");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
const context = {
  console, setTimeout, clearTimeout, Date,
  Zotero: { Promise: { delay: milliseconds => new Promise(resolve =>
    setTimeout(resolve, milliseconds)) }, logError() {} },
  Services: { prefs: { getCharPref(_name, fallback) { return fallback; } } },
  Components: { Constructor() {}, interfaces: {} },
  PathUtils: { join: (...parts) => parts.join("/") }
};
context.globalThis = context;
vm.createContext(context);
for (const name of ["content-segments.js", "translation-service.js"]) {
  vm.runInContext(fs.readFileSync(path.join(root, "plugin", name), "utf8"),
    context, { filename: name });
}

context.Zotero.HTTP = {
  async request(method, endpoint, options = {}) {
    const timeout = Number(options.timeout) > 0 ? Number(options.timeout) : 10000;
    const target = new URL(endpoint);
    return new Promise((resolve, reject) => {
      const request = https.request({
        method,
        hostname: target.hostname,
        port: 443,
        path: `${target.pathname}${target.search}`,
        headers: options.headers,
        lookup(hostname, lookupOptions, callback) {
          dns.lookup(hostname, { family: 4, all: Boolean(lookupOptions?.all) },
            (error, address, family) => {
              if (lookupOptions?.all) {
                callback(error, error ? undefined : address);
              }
              else callback(error, address, family || 4);
            });
        }
      }, response => {
        const chunks = [];
        response.on("data", chunk => chunks.push(chunk));
        response.on("end", () => {
          const responseText = Buffer.concat(chunks).toString("utf8");
          let parsed = responseText;
          try { parsed = JSON.parse(responseText); }
          catch (_) { /* Preserve non-JSON responses for the Provider parser. */ }
          resolve({ status: response.statusCode, response: parsed, responseText });
        });
      });
      request.setTimeout(timeout, () => request.destroy(new Error("HTTP request timeout")));
      request.on("error", reject);
      if (options.body) request.write(options.body);
      request.end();
    });
  }
};

const segment = {
  id: "live-smoke",
  kind: "custom",
  sourceText: "This is a public translation smoke test for Zotero.",
  sourceLanguage: "en",
  confidence: "high",
  position: { pageIndex: 0, rects: [[0, 0, 100, 20]] }
};

const clients = [
  ["gemini", context.GeminiTranslationClient, process.env.GEMINI_API_KEY || ""],
  ["bing", context.BingTranslationClient, ""],
  ["transmart", context.TransmartTranslationClient, ""],
  ["cnki", context.CNKITranslationClient, ""]
];

(async () => {
  let failures = 0;
  for (const [providerID, client, apiKey] of clients) {
    if (providerID === "gemini" && !apiKey) {
      console.log("gemini\tSKIP\tmissing GEMINI_API_KEY");
      continue;
    }
    const started = Date.now();
    try {
      const options = { ...context.TranslationProviderRegistry[providerID].requestOptions(),
        retryDelays: [] };
      const result = await client.translate(apiKey, [segment], { cancelled: false }, options);
      const text = String(result.get(segment.id) || "").trim();
      assert.ok(text, `${providerID} returned an empty translation`);
      console.log(`${providerID}\tOK\t${Date.now() - started}ms`);
    }
    catch (error) {
      failures++;
      const status = error?.status ? ` HTTP ${error.status}` : "";
      console.error(`${providerID}\tFAIL${status}\t${error?.code || "error"}: ${error?.message || error}`);
    }
  }
  if (failures) process.exitCode = 1;
  else console.log("translation live smoke tests passed");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
