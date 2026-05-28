const { EditorView, Decoration, ViewPlugin } = joplin.require('@codemirror/view');
const { RangeSetBuilder, Compartment } = joplin.require('@codemirror/state');
const { syntaxTree } = joplin.require('@codemirror/language');

const COMMAND_APPLY_SETTINGS_ID = 'sentenceRhythm__setSettings';
const SENTENCE_END_CHARS = new Set(['.', '?', '!', ':', ';', '。', '…']);
const TRAILING_CHARS = new Set(['"', "'", '`', '’', '”', '»', '」', ')', ']', '}', '*', '_', '~']);
const WORD_REGEX = /[A-Za-z0-9\u00C0-\u00FF\u0100-\u017F]+(?:['’][A-Za-z0-9\u00C0-\u00FF\u0100-\u017F]+)*|[\u4E00-\u9FFF]|[\u3040-\u309F]|[\u30A0-\u30FF]|[\uAC00-\uD7A3]|[\uF900-\uFAFF]|[\uFF66-\uFF9F]/gu;

const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  xsColor: '#fff2c8',
  smColor: '#eadbf6',
  mdColor: '#c5f2cd',
  lgColor: '#f9caca',
  xlColor: '#d1f6f4',
  textColor: '#222222',
  xsThreshold: 2,
  smThreshold: 5,
  mdThreshold: 10,
  lgThreshold: 20,
  treatLineBreakAsSentenceEnd: false,
});

const normalizeSettings = (input) => {
  const settings = Object.assign({}, DEFAULT_SETTINGS, input || {});

  for (const key of ['xsThreshold', 'smThreshold', 'mdThreshold', 'lgThreshold']) {
    const numericValue = Number(settings[key]);
    settings[key] = Number.isFinite(numericValue) ? Math.max(0, Math.floor(numericValue)) : DEFAULT_SETTINGS[key];
  }

  settings.enabled = Boolean(settings.enabled);
  settings.treatLineBreakAsSentenceEnd = Boolean(settings.treatLineBreakAsSentenceEnd);

  for (const key of ['xsColor', 'smColor', 'mdColor', 'lgColor', 'xlColor', 'textColor']) {
    settings[key] = String(settings[key] || DEFAULT_SETTINGS[key]);
  }

  return settings;
};

const mergeRanges = (ranges) => {
  if (!ranges.length) return [];

  const sorted = ranges
    .filter(range => range && Number.isFinite(range.from) && Number.isFinite(range.to) && range.to > range.from)
    .sort((a, b) => a.from - b.from);

  if (!sorted.length) return [];

  const merged = [Object.assign({}, sorted[0])];

  for (let i = 1; i < sorted.length; i += 1) {
    const current = sorted[i];
    const previous = merged[merged.length - 1];

    if (current.from <= previous.to) {
      previous.to = Math.max(previous.to, current.to);
    } else {
      merged.push({ from: current.from, to: current.to });
    }
  }

  return merged;
};

const collectHtmlTagRanges = (text) => {
  const ranges = [];
  const regex = /<!--[\s\S]*?-->|<\/?[A-Za-z][^>]*?>/g;
  let match;

  while ((match = regex.exec(text)) !== null) {
    ranges.push({ from: match.index, to: match.index + match[0].length });
  }

  return mergeRanges(ranges);
};

const maskRanges = (text, ranges) => {
  if (!ranges.length) return text;

  const chars = text.split('');
  for (const range of ranges) {
    for (let i = range.from; i < range.to && i < chars.length; i += 1) chars[i] = ' ';
  }

  return chars.join('');
};

const subtractRanges = (range, excludedRanges) => {
  const result = [];
  let cursor = range.start;

  for (const excluded of excludedRanges) {
    if (excluded.to <= cursor) continue;
    if (excluded.from >= range.end) break;

    if (excluded.from > cursor) result.push({ start: cursor, end: Math.min(excluded.from, range.end) });
    cursor = Math.max(cursor, excluded.to);
    if (cursor >= range.end) break;
  }

  if (cursor < range.end) result.push({ start: cursor, end: range.end });
  return result;
};

const trimSegment = (text, start, end) => {
  while (start < end && /\s/.test(text[start])) start += 1;
  while (end > start && /\s/.test(text[end - 1])) end -= 1;
  return end > start ? { start, end } : null;
};

const collectSkipRanges = (view) => {
  try {
    const ranges = [];

    syntaxTree(view.state).iterate({
      enter(node) {
        const nodeName = String(node.name || '').toLowerCase();
        if (
          nodeName.includes('code') ||
          nodeName.includes('comment') ||
          nodeName.includes('link') ||
          nodeName.includes('url') ||
          nodeName.includes('header') ||
          nodeName.includes('math')
        ) {
          ranges.push({ from: node.from, to: node.to });
        }
      },
    });

    return mergeRanges(ranges);
  } catch (error) {
    console.info('Sentence Rhythm: unable to collect syntax ranges.', error && error.message ? error.message : error);
    return [];
  }
};

const rangeOverlaps = (start, end, ranges) => {
  for (const range of ranges) {
    if (start < range.to && end > range.from) return true;
    if (range.from > end) break;
  }
  return false;
};

const isDecimalPoint = (text, index) => {
  if (text[index] !== '.') return false;
  const before = text[index - 1] || '';
  const after = text[index + 1] || '';
  return /\d/.test(before) && /\d/.test(after);
};

const boundaryAt = (text, index, settings) => {
  const char = text[index];

  if (char === '\n') {
    if (!settings.treatLineBreakAsSentenceEnd) return null;
    if (index === 0 || text[index - 1] === '\n') return null;
    return { end: index + 1 };
  }

  if (!SENTENCE_END_CHARS.has(char)) return null;
  if (char === '.' && isDecimalPoint(text, index)) return null;

  let end = index + 1;
  while (end < text.length && TRAILING_CHARS.has(text[end])) end += 1;

  if (end >= text.length) return { end };
  if (/\s/.test(text[end])) return { end };

  return null;
};

const trimSentenceRange = (text, start, end) => {
  while (start < end && /[\s>*\-+]/.test(text[start])) start += 1;
  while (end > start && /\s/.test(text[end - 1])) end -= 1;
  if (end <= start) return null;
  return { start, end };
};

const findSentenceRanges = (text, settings) => {
  const sentences = [];
  let sentenceStart = 0;

  for (let index = 0; index < text.length; index += 1) {
    const boundary = boundaryAt(text, index, settings);
    if (!boundary) continue;

    const trimmed = trimSentenceRange(text, sentenceStart, boundary.end);
    if (trimmed) sentences.push(trimmed);
    sentenceStart = boundary.end;
    index = Math.max(index, boundary.end - 1);
  }

  return sentences;
};

const countWords = (sentence) => {
  const matches = sentence.match(WORD_REGEX);
  return matches ? matches.length : 0;
};

const classifySentence = (wordCount, settings) => {
  if (wordCount <= settings.xsThreshold) return 'xs';
  if (wordCount <= settings.smThreshold) return 'sm';
  if (wordCount <= settings.mdThreshold) return 'md';
  if (wordCount <= settings.lgThreshold) return 'lg';
  return 'xl';
};

const buildDecorations = (view, settings) => {
  if (!settings.enabled) return Decoration.none;

  const text = view.state.doc.toString();
  if (!text.trim()) return Decoration.none;

  const htmlTagRanges = collectHtmlTagRanges(text);
  const analysisText = maskRanges(text, htmlTagRanges);

  const builder = new RangeSetBuilder();
  const skipRanges = collectSkipRanges(view);
  const sentences = findSentenceRanges(analysisText, settings);

  for (const sentenceRange of sentences) {
    if (rangeOverlaps(sentenceRange.start, sentenceRange.end, skipRanges)) continue;

    const sentence = analysisText.slice(sentenceRange.start, sentenceRange.end).trim();
    const wordCount = countWords(sentence);
    if (!wordCount) continue;

    const category = classifySentence(wordCount, settings);
    const visibleSegments = subtractRanges(sentenceRange, htmlTagRanges);

    for (const segment of visibleSegments) {
      const trimmed = trimSegment(text, segment.start, segment.end);
      if (!trimmed) continue;

      builder.add(
        trimmed.start,
        trimmed.end,
        Decoration.mark({
          class: `sentence-rhythm-${category}`,
          attributes: {
            'data-sentence-rhythm-words': String(wordCount),
            'data-sentence-rhythm-category': category,
          },
        })
      );
    }
  }

  return builder.finish();
};

const buildSentenceRhythmExtension = (settings) => ViewPlugin.fromClass(class {
  constructor(view) {
    this.decorations = buildDecorations(view, settings);
  }

  update(update) {
    if (update.docChanged || update.viewportChanged) {
      this.decorations = buildDecorations(update.view, settings);
    }
  }
}, {
  decorations: plugin => plugin.decorations,
});

const buildTheme = (settings) => {
  const shared = {
    color: settings.textColor,
    borderRadius: '0.2em',
    padding: '0 0.08em',
    boxDecorationBreak: 'clone',
    WebkitBoxDecorationBreak: 'clone',
    transition: 'background-color 120ms ease-out, color 120ms ease-out',
  };

  return EditorView.baseTheme({
    '.sentence-rhythm-xs': Object.assign({}, shared, { backgroundColor: settings.xsColor }),
    '.sentence-rhythm-sm': Object.assign({}, shared, { backgroundColor: settings.smColor }),
    '.sentence-rhythm-md': Object.assign({}, shared, { backgroundColor: settings.mdColor }),
    '.sentence-rhythm-lg': Object.assign({}, shared, { backgroundColor: settings.lgColor }),
    '.sentence-rhythm-xl': Object.assign({}, shared, { backgroundColor: settings.xlColor }),
  });
};

module.exports = {
  default: function (context) {
    return {
      plugin: async function (codeMirrorWrapper) {
        if (!codeMirrorWrapper || !codeMirrorWrapper.cm6) return;

        let currentSettings = normalizeSettings(await context.postMessage('getSettings'));
        const highlightCompartment = new Compartment();
        const themeCompartment = new Compartment();

        const applySettings = (nextSettings) => {
          currentSettings = normalizeSettings(nextSettings);
          codeMirrorWrapper.editor.dispatch({
            effects: [
              highlightCompartment.reconfigure(buildSentenceRhythmExtension(currentSettings)),
              themeCompartment.reconfigure(buildTheme(currentSettings)),
            ],
          });
        };

        codeMirrorWrapper.addExtension([
          highlightCompartment.of(buildSentenceRhythmExtension(currentSettings)),
          themeCompartment.of(buildTheme(currentSettings)),
        ]);

        if (typeof codeMirrorWrapper.registerCommand === 'function') {
          codeMirrorWrapper.registerCommand(COMMAND_APPLY_SETTINGS_ID, applySettings);
        } else if (typeof codeMirrorWrapper.defineExtension === 'function') {
          codeMirrorWrapper.defineExtension(COMMAND_APPLY_SETTINGS_ID, applySettings);
        }
      },
    };
  },
};
