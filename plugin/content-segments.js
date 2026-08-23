"use strict";

var ContentSegments = {
  detectLanguage(text) {
    const value = String(text || "");
    const latin = (value.match(/[A-Za-z]/g) || []).length;
    const chinese = (value.match(/[\u3400-\u9fff]/g) || []).length;
    const letters = latin + chinese;
    if (letters < 4) return "unknown";
    if (latin / letters >= 0.82) return "en";
    if (chinese / letters >= 0.5) return "zh-CN";
    return "unknown";
  },

  fromTargets(targets) {
    return (targets || []).map((target, index) => ({
      id: String(target.kind || `target-${index}`),
      kind: target.kind,
      sourceText: String(target.text || "").trim(),
      sourceLanguage: this.detectLanguage(target.text),
      sourceCharIDs: [...(target.sourceCharIDs || [])].map(String),
      sourceLineIDs: [...(target.sourceLineIDs || [])].map(String),
      position: target.position,
      pageIndexes: [...(target.pageIndexes || [])].map(Number),
      confidence: target.confidence || "low",
      metadata: {
        matchMethod: target.matchMethod || null,
        metadataCoverage: Number(target.metadataCoverage || 0),
        completeness: target.completeness || null,
        sourceIndex: null,
        matchType: null
      }
    })).filter(segment => segment.sourceText && segment.position);
  },

  fromSelectionBlock(match) {
    const sourceText = String(match?.sourceText || "").trim();
    const position = match?.position || null;
    if (!sourceText || !position) return [];
    return [{
      id: "selection-block",
      kind: "custom",
      sourceText,
      sourceLanguage: this.detectLanguage(sourceText),
      sourceCharIDs: [],
      sourceLineIDs: [],
      position,
      pageIndexes: [...new Set((position.fragments || [])
        .map(fragment => Number(fragment.pageIndex || 0)))],
      confidence: "high",
      metadata: {
        matchMethod: "original-selection",
        metadataCoverage: null,
        completeness: "exact",
        sourceIndex: null,
        selectionMode: "selection-block",
        blockCount: Number(match?.blocks?.length || 0),
        selectionUnits: (match?.units || []).map(unit => ({
          id: String(unit.id || ""),
          sourceText: String(unit.sourceText || "").trim(),
          breakAfter: unit.breakAfter === "paragraph" ? "paragraph" : "none"
        })).filter(unit => unit.id && unit.sourceText),
        selectionDistribution: match?.distribution || { pageWeights: [], blockWeights: [] },
        selectedText: sourceText,
        selectedPosition: position
      }
    }];
  }
};
