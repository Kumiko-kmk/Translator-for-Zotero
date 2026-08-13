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

  fromSelection(match) {
    return (match?.paragraphs || []).map((paragraph, index) => ({
      id: `${paragraph.matchType === "unclassified" ? "u" : "p"}-${index}`,
      kind: paragraph.matchType === "unclassified" ? "unclassified" : "custom",
      sourceText: String(paragraph.selectedText || paragraph.sourceText || "").trim(),
      sourceLanguage: this.detectLanguage(paragraph.selectedText || paragraph.sourceText),
      sourceCharIDs: [...(paragraph.selectedCharIDs || [])].map(String),
      sourceLineIDs: [],
      position: paragraph.selectedPosition,
      pageIndexes: (paragraph.selectedPosition?.fragments || [])
        .map(fragment => Number(fragment.pageIndex || 0)),
      confidence: paragraph.confidence || "low",
      metadata: {
        matchMethod: null,
        metadataCoverage: null,
        completeness: null,
        sourceIndex: paragraph.sourceIndex ?? null,
        matchType: paragraph.matchType || null,
        selectionParagraphIndex: index
      }
    })).filter(segment => segment.position && segment.sourceText);
  }
};
