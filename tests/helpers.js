"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");

function createContext() {
  const preferences = new Map();
  let httpRequest = async function () {
    throw new Error("unexpected network request");
  };

  const context = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
    TextEncoder,
    TextDecoder,
    Buffer,
    Zotero: {
      Promise: {
        delay: async function () {}
      },
      debug: function () {},
      logError: function () {},
      HTTP: {
        request: function () {
          return httpRequest.apply(null, arguments);
        }
      },
      Items: {},
      DBConnection: null,
      DataDirectory: null
    },
    Services: {
      prefs: {
        getBoolPref: function (name, fallback) {
          return preferences.has(name) ? preferences.get(name) : fallback;
        },
        setBoolPref: function (name, value) {
          preferences.set(name, value);
        },
        getCharPref: function (name, fallback) {
          return preferences.has(name) ? preferences.get(name) : fallback;
        },
        setCharPref: function (name, value) {
          preferences.set(name, value);
        }
      },
      logins: {
        searchLoginsAsync: async function () {
          return [];
        },
        addLoginAsync: async function () {},
        removeLoginAsync: async function () {}
      }
    },
    Components: {
      Constructor: function () {
        return function LoginInfo(origin, formActionOrigin, httpRealm, username, password) {
          this.origin = origin;
          this.formActionOrigin = formActionOrigin;
          this.httpRealm = httpRealm;
          this.username = username;
          this.password = password;
        };
      },
      interfaces: {
        nsILoginInfo: {}
      }
    },
    PathUtils: {
      join: function () {
        return Array.from(arguments).join("/");
      }
    }
  };

  context.globalThis = context;
  vm.createContext(context);
  context.setHTTP = function (handler) {
    httpRequest = handler;
  };
  context.getPreferences = function () {
    return preferences;
  };
  return context;
}

function loadModule(context, fileName) {
  const filePath = path.join(ROOT, "plugin", fileName);
  const source = fs.readFileSync(filePath, "utf8");
  vm.runInContext(source, context, { filename: fileName });
}

function loadModules(fileNames) {
  const context = createContext();
  fileNames.forEach(function (fileName) {
    loadModule(context, fileName);
  });
  return context;
}

function loadTextContext() {
  return loadModules([
    "core.js",
    "page-text-index.js",
    "selection-block.js",
    "front-matter-extractor.js",
    "reader-target-locator.js",
    "content-segments.js"
  ]);
}

function loadTranslationContext() {
  return loadModules([
    "core.js",
    "content-segments.js",
    "translation-service.js",
    "provider-runtime-patches.js"
  ]);
}

function loadSelectionTranslationContext() {
  return loadModules([
    "core.js",
    "page-text-index.js",
    "selection-block.js",
    "content-segments.js",
    "translation-service.js",
    "provider-runtime-patches.js"
  ]);
}

function makeViewport(rotation, scale) {
  const actualScale = scale || 1;
  const matrices = {
    0: [actualScale, 0, 0, -actualScale, 0, 800 * actualScale],
    90: [0, actualScale, actualScale, 0, 0, 0],
    180: [-actualScale, 0, 0, actualScale, 600 * actualScale, 0],
    270: [0, -actualScale, -actualScale, 0, 800 * actualScale, 600 * actualScale]
  };
  const transform = matrices[rotation].slice();
  const inverse = invertMatrix(transform);
  const horizontalRotation = rotation === 90 || rotation === 270;

  return {
    transform,
    scale: actualScale,
    rotation,
    viewBox: [0, 0, 600, 800],
    width: (horizontalRotation ? 800 : 600) * actualScale,
    height: (horizontalRotation ? 600 : 800) * actualScale,
    convertToViewportPoint: function (x, y) {
      return applyMatrix(transform, x, y);
    },
    convertToPdfPoint: function (x, y) {
      return applyMatrix(inverse, x, y);
    }
  };
}

function makeReaderView(viewport, pageTop) {
  const top = pageTop || 0;
  const width = Number(viewport?.width || 0);
  const height = Number(viewport?.height || 0);
  const pageDiv = {
    getBoundingClientRect: function () {
      return {
        left: 0,
        top,
        width,
        height,
        right: width,
        bottom: top + height
      };
    }
  };
  return {
    _iframeWindow: {
      PDFViewerApplication: {
        pdfDocument: {
          numPages: 1
        },
        pdfViewer: {
          pagesCount: 1,
          _pages: [
            {
              viewport,
              div: pageDiv
            }
          ]
        }
      }
    },
    _iframe: {
      getBoundingClientRect: function () {
        return {
          left: 0,
          top: 0,
          width,
          height
        };
      }
    }
  };
}

function applyMatrix(matrix, x, y) {
  return [
    matrix[0] * x + matrix[2] * y + matrix[4],
    matrix[1] * x + matrix[3] * y + matrix[5]
  ];
}

function invertMatrix(matrix) {
  const determinant = matrix[0] * matrix[3] - matrix[1] * matrix[2];
  return [
    matrix[3] / determinant,
    -matrix[1] / determinant,
    -matrix[2] / determinant,
    matrix[0] / determinant,
    (matrix[2] * matrix[5] - matrix[3] * matrix[4]) / determinant,
    (matrix[1] * matrix[4] - matrix[0] * matrix[5]) / determinant
  ];
}

function makeLayoutPage(pageIndex, lines, options) {
  const config = options || {};
  const viewBox = config.viewBox || [0, 0, 600, 800];
  const chars = [];
  const pageLines = [];

  lines.forEach(function (line, lineIndex) {
    const text = String(line.text || "");
    const height = Number(line.height || 10);
    const top = Number(line.top || 0);
    let x = Number(line.x || 40);
    const lineChars = [];

    Array.from(text).forEach(function (character) {
      const characterWidth = character === " "
        ? Number(line.spaceWidth || 3)
        : Number(line.charWidth || 5);
      const rect = [x, viewBox[3] - top - height, x + characterWidth, viewBox[3] - top];
      const charRecord = {
        id: String(pageIndex) + ":char:" + String(chars.length),
        offset: chars.length,
        pageIndex,
        c: character,
        char: character,
        rect,
        viewportRect: [x, top, x + characterWidth, top + height],
        fontName: String(line.fontName || "TestFont"),
        spaceAfter: character === " ",
        lineIndex,
        lineBreakAfter: false,
        paragraphBreakAfter: false
      };
      chars.push(charRecord);
      lineChars.push(charRecord);
      x += characterWidth;
    });

    if (lineChars.length) {
      lineChars[lineChars.length - 1].lineBreakAfter = line.lineBreakAfter !== false;
      lineChars[lineChars.length - 1].paragraphBreakAfter = Boolean(line.paragraphBreakAfter);
    }

    pageLines.push({
      text,
      chars: lineChars,
      rect: lineChars.length
        ? [
            lineChars[0].rect[0],
            Math.min.apply(null, lineChars.map(function (item) { return item.rect[1]; })),
            lineChars[lineChars.length - 1].rect[2],
            Math.max.apply(null, lineChars.map(function (item) { return item.rect[3]; }))
          ]
        : null,
      top,
      bottom: top + height,
      x: lineChars.length ? lineChars[0].rect[0] : Number(line.x || 40),
      width: lineChars.length ? x - Number(line.x || 40) : 0,
      columnIndex: line.columnIndex == null ? 0 : line.columnIndex,
      lineIndex
    });
  });

  return {
    pageIndex,
    viewBox,
    metric: {
      width: viewBox[2],
      height: viewBox[3],
      unit: "pt"
    },
    chars,
    lines: pageLines
  };
}

function makePosition(pageIndex, rects) {
  const copiedRects = (rects || [[40, 100, 280, 112]]).map(function (rect) {
    return rect.slice();
  });
  return {
    version: 2,
    coordinateSpace: "pdf",
    pageIndex,
    rects: copiedRects,
    fragments: [
      {
        pageIndex,
        rects: copiedRects.map(function (rect) { return rect.slice(); })
      }
    ]
  };
}

function makeSelectionPosition(pageIndex, rects, options) {
  const config = options || {};
  const position = makePosition(pageIndex, rects);
  const fragment = position.fragments[0];
  if (config.flowID !== null && config.flowID !== false) {
    fragment.flowID = config.flowID || "flow-0";
  }
  if (config.lineIDs !== null && config.lineIDs !== false) {
    fragment.lineIDs = (config.lineIDs || fragment.rects.map(function (_, index) {
      return String(pageIndex) + ":line:" + String(index);
    })).map(String);
  }
  return position;
}

function makeSegment(kind, sourceText, extra) {
  const additional = extra || {};
  return Object.assign({
    id: additional.id || kind + "-segment",
    kind,
    sourceText,
    sourceLanguage: "en",
    position: makePosition(0, [[40, 100, 280, 112]]),
    pageIndexes: [0],
    confidence: "high",
    metadata: {}
  }, additional);
}

module.exports = {
  ROOT,
  createContext,
  loadModule,
  loadModules,
  loadTextContext,
  loadTranslationContext,
  loadSelectionTranslationContext,
  makeViewport,
  makeReaderView,
  makeLayoutPage,
  makePosition,
  makeSelectionPosition,
  makeSegment
};
