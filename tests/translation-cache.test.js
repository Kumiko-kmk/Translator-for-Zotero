"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  loadSelectionTranslationContext,
  loadTranslationContext,
  makePosition,
  makeSelectionPosition,
  makeSegment
} = require("./helpers");

class MockCacheDB {
  constructor() {
    this.states = new Map();
    this.records = new Map();
    this.meta = new Map();
  }

  stateKey(libraryID, attachmentKey) {
    return `${Number(libraryID)}|${String(attachmentKey)}`;
  }

  async queryAsync(sql, params = []) {
    const query = String(sql).replace(/\s+/gu, " ").trim().toLowerCase();
    if (query.startsWith("select file_fingerprint")) {
      const row = this.states.get(this.stateKey(params[0], params[1]));
      return row ? [{ file_fingerprint: row.file_fingerprint,
        is_trashed: row.is_trashed, first_seen_at: row.first_seen_at }] : [];
    }
    if (query.startsWith("insert or replace into attachment_states")) {
      const [libraryID, attachmentKey, attachmentItemID, parentItemID,
        fileFingerprint, isTrashed, firstSeenAt, lastSeenAt, lastCheckedAt] = params;
      this.states.set(this.stateKey(libraryID, attachmentKey), {
        library_id: Number(libraryID),
        attachment_key: String(attachmentKey),
        attachment_item_id: attachmentItemID,
        parent_item_id: parentItemID,
        file_fingerprint: String(fileFingerprint),
        is_trashed: Number(isTrashed || 0),
        first_seen_at: Number(firstSeenAt),
        last_seen_at: Number(lastSeenAt),
        last_checked_at: Number(lastCheckedAt)
      });
      return [];
    }
    if (query.startsWith("select created_at from translation_records")) {
      const row = this.records.get(String(params[0]));
      return row ? [{ created_at: row.created_at }] : [];
    }
    if (query.startsWith("select * from translation_records where record_id")) {
      const row = this.records.get(String(params[0]));
      return row ? [{ ...row }] : [];
    }
    if (query.startsWith("select * from translation_records")) {
      return [...this.records.values()].filter(row =>
        Number(row.library_id) === Number(params[0])
        && String(row.attachment_key) === String(params[1])
        && String(row.file_fingerprint) === String(params[2])
        && String(row.target_language) === String(params[3])
        && [String(params[4]), String(params[5])].includes(String(row.segment_kind))
      ).map(row => ({ ...row }));
    }
    if (query.startsWith("update translation_records set last_used_at")) {
      const row = this.records.get(String(params[1]));
      if (row) row.last_used_at = Number(params[0]);
      return [];
    }
    if (query.startsWith("delete from translation_records where record_id")) {
      this.records.delete(String(params[0]));
      return [];
    }
    if (query.startsWith("delete from translation_records where library_id")) {
      if (params.length === 2) {
        for (const [key, row] of this.records) {
          if (Number(row.library_id) === Number(params[0])
            && String(row.attachment_key) === String(params[1])) this.records.delete(key);
        }
      }
      else {
        for (const [key, row] of this.records) {
          if (Number(row.library_id) === Number(params[0])
            && String(row.attachment_key) === String(params[1])
            && String(row.file_fingerprint) === String(params[2])
            && String(row.segment_kind) === String(params[3])
            && String(row.source_language) === String(params[4])
            && String(row.target_language) === String(params[5])
            && String(row.record_id) !== String(params[6])) this.records.delete(key);
        }
      }
      return [];
    }
    if (query.startsWith("insert or replace into translation_records")) {
      const names = [
        "record_id", "library_id", "attachment_key", "attachment_item_id",
        "parent_item_id", "file_fingerprint", "segment_kind", "segment_id",
        "source_text", "source_hash", "source_units_json", "position_json",
        "position_signature", "source_language", "target_language", "prompt_version",
        "translated_text", "translated_units_json", "provider", "model", "created_at",
        "updated_at", "last_used_at"
      ];
      this.records.set(String(params[0]), Object.fromEntries(
        names.map((name, index) => [name, params[index]])
      ));
      return [];
    }
    if (query.startsWith("update attachment_states set is_trashed")) {
      const trashed = Number(params[0]);
      const ids = params.slice(2).map(value => Number(value));
      for (const row of this.states.values()) {
        if (ids.includes(Number(row.attachment_item_id))
          || ids.includes(Number(row.parent_item_id))) row.is_trashed = trashed;
      }
      return [];
    }
    if (query.startsWith("delete from attachment_states where attachment_item_id")) {
      const ids = params.map(value => Number(value));
      for (const [key, row] of this.states) {
        if (ids.includes(Number(row.attachment_item_id))
          || ids.includes(Number(row.parent_item_id))) this.states.delete(key);
      }
      return [];
    }
    if (query.startsWith("delete from translation_records where attachment_item_id")) {
      const ids = params.map(value => Number(value));
      for (const [key, row] of this.records) {
        if (ids.includes(Number(row.attachment_item_id))
          || ids.includes(Number(row.parent_item_id))) this.records.delete(key);
      }
      return [];
    }
    if (query.startsWith("select value from translation_cache_meta")) {
      const value = this.meta.get(String(params[0]));
      return value === undefined ? [] : [{ value }];
    }
    if (query.startsWith("insert or replace into translation_cache_meta")) {
      this.meta.set(String(params[0]), String(params[1]));
      return [];
    }
    return [];
  }

  async closeDatabase() {}
}

function useMockCache(context) {
  const cache = context.SegmentTranslationCache;
  cache.db = new MockCacheDB();
  cache.readyPromise = Promise.resolve();
  cache.attachmentIdentities.clear();
  return cache;
}

function attachment(hash = "pdf-hash-1") {
  return {
    id: 101,
    libraryID: 7,
    key: "ATTACHMENT-KEY",
    parentID: 202,
    attachmentHash: hash
  };
}

function providerRun(context, options = {}) {
  const modelSpec = options.modelSpec || context.TranslationModelRegistry.gemini;
  return context.TranslationCoordinator.translateSegments({
    attachment: options.attachment || attachment(),
    segments: [options.segment || makeSegment("title", "A stable title", {
      id: "title",
      position: makePosition(0, [[40, 100, 280, 112]])
    })],
    modelSpec,
    bypassCache: Boolean(options.bypassCache),
    credentials: options.credentials || { getKey: async () => "test-key" },
    translationClient: options.translationClient,
    requestOptions: {}
  });
}

test("cache row normalization does not enumerate Zotero database row proxies", function () {
  const context = loadTranslationContext();
  const cache = context.SegmentTranslationCache;
  const fields = {
    record_id: "translation-proxy-row",
    library_id: 7,
    attachment_key: "ATTACHMENT-KEY",
    attachment_item_id: 101,
    parent_item_id: 202,
    file_fingerprint: "hash:pdf-hash-1",
    segment_kind: "title",
    segment_id: "title",
    source_text: "A stable title",
    source_hash: "source-hash",
    source_units_json: "[]",
    position_json: JSON.stringify({ pageIndex: 0 }),
    position_signature: "position-signature",
    source_language: "en",
    target_language: "zh-CN",
    prompt_version: "front-matter-translation-v2-title-break",
    translated_text: "译文",
    translated_units_json: "[]",
    provider: "gemini",
    model: "gemini-2.5-flash",
    created_at: 1,
    updated_at: 2,
    last_used_at: 3
  };
  const row = new Proxy(fields, {
    ownKeys() {
      throw new Error("DB column 'QueryInterface' not found");
    },
    get(target, property, receiver) {
      if (property === "QueryInterface") {
        throw new Error("DB column 'QueryInterface' not found");
      }
      return Reflect.get(target, property, receiver);
    }
  });

  const normalized = cache.normalizeRow(row);
  assert.equal(normalized.recordID, "translation-proxy-row");
  assert.equal(normalized.positionJSON, fields.position_json);
  assert.equal(normalized.sourceUnitsJSON, "[]");
  assert.equal(JSON.stringify(normalized.position), JSON.stringify({ pageIndex: 0 }));
});

test("cache lookup can return a cached row from a Zotero-style proxy", async function () {
  const context = loadTranslationContext();
  const cache = context.SegmentTranslationCache;
  const attachmentValue = attachment();
  const segment = makeSegment("title", "A stable title", {
    id: "title",
    position: makePosition(0, [[40, 100, 280, 112]])
  });
  const identity = {
    libraryID: 7,
    attachmentKey: "ATTACHMENT-KEY",
    attachmentItemID: 101,
    parentItemID: 202,
    fileFingerprint: "hash:pdf-hash-1",
    usable: true
  };
  const key = cache.key(attachmentValue, segment, "zh-CN", null, identity);
  const fields = {
    record_id: key.recordID,
    library_id: key.libraryID,
    attachment_key: key.attachmentKey,
    attachment_item_id: key.attachmentItemID,
    parent_item_id: key.parentItemID,
    file_fingerprint: key.fileFingerprint,
    segment_kind: key.segmentKind,
    segment_id: key.segmentID,
    source_text: key.sourceText,
    source_hash: key.sourceHash,
    source_units_json: key.sourceUnitsJSON,
    position_json: key.positionJSON,
    position_signature: key.positionSignature,
    source_language: key.sourceLanguage,
    target_language: key.targetLanguage,
    prompt_version: key.promptVersion,
    translated_text: "缓存译文",
    translated_units_json: "[]",
    provider: "gemini",
    model: "gemini-2.5-flash",
    created_at: 1,
    updated_at: 2,
    last_used_at: 3
  };
  const row = new Proxy(fields, {
    ownKeys() {
      throw new Error("DB column 'QueryInterface' not found");
    }
  });
  cache.db = {
    queryAsync: async sql => String(sql).toLowerCase().startsWith("select *")
      ? [row] : []
  };
  cache.readyPromise = Promise.resolve();

  const result = await cache.get(attachmentValue, segment, "zh-CN", null, { identity });
  assert.equal(result.recordID, key.recordID);
  assert.equal(result.translatedText, "缓存译文");
});

test("one malformed cache row does not hide other persisted rows", async function () {
  const context = loadSelectionTranslationContext();
  const cache = context.SegmentTranslationCache;
  const attachmentValue = attachment();
  const identity = {
    libraryID: 7,
    attachmentKey: "ATTACHMENT-KEY",
    attachmentItemID: 101,
    parentItemID: 202,
    fileFingerprint: "hash:pdf-hash-1",
    usable: true
  };
  const segment = makeSegment("custom", "A selected paragraph", {
    id: "selection-block",
    metadata: {
      selectionUnits: [{ id: "unit-0", sourceText: "A selected paragraph", breakAfter: "none" }]
    }
  });
  const key = cache.key(attachmentValue, segment, "zh-CN", null, identity);
  const validRow = {
    record_id: key.recordID,
    library_id: key.libraryID,
    attachment_key: key.attachmentKey,
    attachment_item_id: key.attachmentItemID,
    parent_item_id: key.parentItemID,
    file_fingerprint: key.fileFingerprint,
    segment_kind: key.segmentKind,
    segment_id: key.segmentID,
    source_text: key.sourceText,
    source_hash: key.sourceHash,
    source_units_json: key.sourceUnitsJSON,
    position_json: key.positionJSON,
    position_signature: key.positionSignature,
    source_language: key.sourceLanguage,
    target_language: key.targetLanguage,
    prompt_version: key.promptVersion,
    translated_text: "有效译文",
    translated_units_json: "[]",
    provider: "gemini",
    model: "gemini-2.5-flash",
    created_at: 1,
    updated_at: 2,
    last_used_at: 3
  };
  const malformedRow = { ...validRow,
    record_id: "translation-malformed",
    position_json: "{broken-json" };
  cache.db = {
    queryAsync: async sql => String(sql).toLowerCase().startsWith("select *")
      ? [validRow, malformedRow] : []
  };
  cache.readyPromise = Promise.resolve();

  const rows = await cache.listForAttachment(attachmentValue, "zh-CN", { identity });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].recordID, key.recordID);
});

test("cache initialization failure falls back to network translation", async function () {
  const context = loadTranslationContext();
  const cache = useMockCache(context);
  cache.init = async () => {
    throw new Error("simulated cache initialization failure");
  };
  let calls = 0;
  const result = await providerRun(context, {
    translationClient: {
      translate: async () => {
        calls++;
        return new Map([["title", "初始化失败后的译文"]]);
      }
    }
  });
  assert.equal(result.results.get("title").status, "translated");
  assert.equal(calls, 1);
});

test("cache read and write failures fall back to network translation", async function () {
  const context = loadTranslationContext();
  const cache = useMockCache(context);
  const identity = {
    libraryID: 7,
    attachmentKey: "ATTACHMENT-KEY",
    attachmentItemID: 101,
    parentItemID: 202,
    fileFingerprint: "hash:pdf-hash-1",
    usable: true
  };
  cache.ensureAttachment = async () => identity;
  cache.get = async () => {
    throw new Error("simulated cache read failure");
  };
  cache.put = async () => {
    throw new Error("simulated cache write failure");
  };
  let calls = 0;
  const result = await providerRun(context, {
    translationClient: {
      translate: async () => {
        calls++;
        return new Map([["title", "网络译文"]]);
      }
    }
  });
  assert.equal(result.results.get("title").status, "translated");
  assert.equal(result.results.get("title").translatedText, "网络译文");
  assert.equal(calls, 1);
});

test("persistent cache is shared across providers and avoids a second network call", async function () {
  const context = loadTranslationContext();
  const cache = useMockCache(context);
  let calls = 0;
  const first = await providerRun(context, {
    modelSpec: context.TranslationModelRegistry.gemini,
    translationClient: {
      translate: async () => {
        calls++;
        return new Map([["title", "首次译文"]]);
      }
    }
  });
  assert.equal(first.results.get("title").status, "translated");
  assert.equal(calls, 1);
  assert.equal(cache.db.records.size, 1);

  const second = await providerRun(context, {
    modelSpec: context.TranslationModelRegistry.qwenMTPlus,
    credentials: { getKey: async () => { throw new Error("cache hit must not read key"); } },
    translationClient: {
      translate: async () => {
        calls++;
        throw new Error("cache hit must not call network");
      }
    }
  });
  assert.equal(second.results.get("title").status, "cached");
  assert.equal(second.results.get("title").translatedText, "首次译文");
  assert.equal(calls, 1);
  assert.equal(cache.db.records.size, 1);
});

test("forced retry overwrites the model-independent record and fingerprint changes invalidate it", async function () {
  const context = loadTranslationContext();
  const cache = useMockCache(context);
  let calls = 0;
  const translated = async () => {
    calls++;
    return new Map([["title", calls === 1 ? "旧译文" : "新译文"]]);
  };
  await providerRun(context, { translationClient: { translate: translated } });
  const retry = await providerRun(context, {
    modelSpec: context.TranslationModelRegistry.qwenMTPlus,
    bypassCache: true,
    translationClient: { translate: translated }
  });
  assert.equal(retry.results.get("title").status, "translated");
  assert.equal(retry.results.get("title").translatedText, "新译文");
  assert.equal(cache.db.records.size, 1);

  const changedFile = await providerRun(context, {
    attachment: attachment("pdf-hash-2"),
    modelSpec: context.TranslationModelRegistry.qwenMTPlus,
    translationClient: { translate: translated }
  });
  assert.equal(changedFile.results.get("title").status, "translated");
  assert.equal(calls, 3);
  assert.equal(cache.db.records.size, 1);
});

test("viewport changes, collection moves, sorting, and parent adjustments keep the same cache identity", async function () {
  const context = loadTranslationContext();
  const cache = useMockCache(context);
  let calls = 0;
  await providerRun(context, {
    translationClient: { translate: async () => {
      calls++;
      return new Map([["title", "稳定译文"]]);
    } }
  });
  const moved = await providerRun(context, {
    attachment: { ...attachment(), parentID: 909, collectionIDs: [99, 100] },
    modelSpec: context.TranslationModelRegistry.qwenMTPlus,
    credentials: { getKey: async () => { throw new Error("cache hit must not read key"); } },
    translationClient: { translate: async () => {
      calls++;
      throw new Error("cache hit must not call network");
    } }
  });
  assert.equal(moved.results.get("title").status, "cached");
  assert.equal(calls, 1);
  assert.equal(cache.db.records.size, 1);
});

test("trash keeps records while permanent deletion removes records by attachment or parent id", async function () {
  const context = loadTranslationContext();
  const cache = useMockCache(context);
  await providerRun(context, {
    translationClient: { translate: async () => new Map([["title", "保留译文"]]) }
  });
  assert.equal(cache.db.records.size, 1);
  await cache.handleNotifier("trash", "item", [101]);
  assert.equal(cache.db.records.size, 1);
  assert.equal([...cache.db.states.values()][0].is_trashed, 1);
  await cache.handleNotifier("delete", "item", [202]);
  assert.equal(cache.db.records.size, 0);
  assert.equal(cache.db.states.size, 0);
});

test("selection cache stores units and safely skips a corrupt payload", async function () {
  const context = loadSelectionTranslationContext();
  const cache = useMockCache(context);
  const match = context.ReaderSelectionBlock.create({
    view: null,
    position: makeSelectionPosition(0, [
      [20, 100, 180, 112],
      [20, 130, 180, 142]
    ], { flowID: "flow-1", lineIDs: ["line-1", "line-2"] }),
    sourceText: "First selected unit.\n\nSecond selected unit."
  });
  const selection = context.ContentSegments.fromSelectionBlock(match)[0];
  let calls = 0;
  const first = await providerRun(context, {
    segment: selection,
    translationClient: {
      translate: async () => {
        calls++;
        return new Map([[selection.id, {
          translatedText: "第一段译文\n\n第二段译文",
          translatedUnits: selection.metadata.selectionUnits.map((unit, index) => ({
            id: unit.id,
            translatedText: index === 0 ? "第一段译文" : "第二段译文",
            breakAfter: unit.breakAfter
          }))
        }]]);
      }
    }
  });
  assert.equal(first.results.get(selection.id).status, "translated");
  const rows = await cache.listForAttachment(attachment(), "zh-CN", {
    identity: await cache.ensureAttachment(attachment())
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sourceUnits.length, 2);
  assert.equal(rows[0].translatedUnits.length, 2);

  const repeated = await providerRun(context, {
    segment: selection,
    modelSpec: context.TranslationModelRegistry.qwenMTPlus,
    credentials: { getKey: async () => { throw new Error("selection cache hit must not read key"); } },
    translationClient: { translate: async () => {
      calls++;
      throw new Error("selection cache hit must not call network");
    } }
  });
  assert.equal(repeated.results.get(selection.id).status, "cached");
  assert.equal(calls, 1);
  assert.equal(cache.db.records.size, 1);

  const row = cache.db.records.get(rows[0].recordID);
  row.translated_text = "{broken-json";
  const second = await providerRun(context, {
    segment: selection,
    translationClient: {
      translate: async () => {
        calls++;
        return new Map([[selection.id, "重新翻译"]]);
      }
    }
  });
  assert.equal(second.results.get(selection.id).status, "translated");
  assert.equal(calls, 2);
});

test("unknown attachment fingerprint remains session-only", async function () {
  const context = loadTranslationContext();
  const cache = useMockCache(context);
  let calls = 0;
  const unknown = { id: 303, libraryID: 7, key: "UNKNOWN-KEY", parentID: 404 };
  const run = () => providerRun(context, {
    attachment: unknown,
    translationClient: { translate: async () => {
      calls++;
      return new Map([["title", "临时译文"]]);
    } }
  });
  await run();
  await run();
  assert.equal(calls, 2);
  assert.equal(cache.db.records.size, 0);
});
