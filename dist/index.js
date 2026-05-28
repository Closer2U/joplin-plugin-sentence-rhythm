const ContentScriptType = {
  CodeMirrorPlugin: 'codeMirrorPlugin',
};

const SettingItemType = {
  Int: 1,
  String: 2,
  Bool: 3,
};

const ToolbarButtonLocation = {
  NoteToolbar: 'noteToolbar',
  EditorToolbar: 'editorToolbar',
};

const MenuItemLocation = {
  EditorContextMenu: 'editorContextMenu',
};

const CONTENT_SCRIPT_ID = 'sentence-rhythm-editor';
const SECTION_ID = 'sentence-rhythm';
const COMMAND_TOGGLE_ID = 'sentenceRhythmToggle';
const COMMAND_SHOW_OVERVIEW_ID = 'sentenceRhythmShowOverview';
const COMMAND_APPLY_SETTINGS_ID = 'sentenceRhythm__setSettings';
const OVERVIEW_DIALOG_ID = 'sentenceRhythmOverviewDialog';

const CATEGORY_ORDER = ['xs', 'sm', 'md', 'lg', 'xl'];
const CATEGORY_LABELS = {
  xs: 'Extra short',
  sm: 'Short',
  md: 'Medium',
  lg: 'Long',
  xl: 'Extra long',
};

const WORD_REGEX = /[A-Za-z0-9\u00C0-\u00FF\u0100-\u017F]+(?:['’][A-Za-z0-9\u00C0-\u00FF\u0100-\u017F]+)*|[\u4E00-\u9FFF]|[\u3040-\u309F]|[\u30A0-\u30FF]|[\uAC00-\uD7A3]|[\uF900-\uFAFF]|[\uFF66-\uFF9F]/gu;
const SENTENCE_END_CHARS = new Set(['.', '?', '!', ':', ';', '。', '…']);
const TRAILING_CHARS = new Set(['"', "'", '`', '’', '”', '»', '」', ')', ']', '}', '*', '_', '~']);

let sessionManualEnabledOverride = null;

const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  autoEnableTagName: 'wip',
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

const SETTING_METADATA = {
  enabled: {
    label: 'Enable sentence rhythm highlighting',
    description: 'Default enabled state when auto-enable-by-tag is blank. When a tag is configured, note opening uses the tag rule instead.',
    type: SettingItemType.Bool,
  },
  autoEnableTagName: {
    label: 'Auto-enable for tag',
    description: 'If set, notes with this tag auto-open with highlighting enabled and other notes auto-open with highlighting disabled. Leave blank to disable tag-based auto-enable.',
    type: SettingItemType.String,
  },
  xsColor: {
    label: 'Extra short sentence color',
    description: 'Background color for extra short sentences. Use any CSS color, e.g. #fff2c8.',
    type: SettingItemType.String,
  },
  smColor: {
    label: 'Short sentence color',
    description: 'Background color for short sentences.',
    type: SettingItemType.String,
  },
  mdColor: {
    label: 'Medium sentence color',
    description: 'Background color for medium-length sentences.',
    type: SettingItemType.String,
  },
  lgColor: {
    label: 'Long sentence color',
    description: 'Background color for long sentences.',
    type: SettingItemType.String,
  },
  xlColor: {
    label: 'Extra long sentence color',
    description: 'Background color for very long sentences.',
    type: SettingItemType.String,
  },
  textColor: {
    label: 'Highlighted text color',
    description: 'Text color used inside highlighted sentences.',
    type: SettingItemType.String,
  },
  xsThreshold: {
    label: 'Extra short threshold',
    description: 'Sentences with this many words or fewer are classified as extra short.',
    type: SettingItemType.Int,
    minimum: 0,
    maximum: 200,
  },
  smThreshold: {
    label: 'Short threshold',
    description: 'Sentences with this many words or fewer are classified as short.',
    type: SettingItemType.Int,
    minimum: 0,
    maximum: 200,
  },
  mdThreshold: {
    label: 'Medium threshold',
    description: 'Sentences with this many words or fewer are classified as medium.',
    type: SettingItemType.Int,
    minimum: 0,
    maximum: 200,
  },
  lgThreshold: {
    label: 'Long threshold',
    description: 'Sentences with this many words or fewer are classified as long. Anything above becomes extra long.',
    type: SettingItemType.Int,
    minimum: 0,
    maximum: 200,
  },
  treatLineBreakAsSentenceEnd: {
    label: 'Treat line breaks as sentence boundaries',
    description: 'When enabled, a hard line break can end a sentence even without terminal punctuation.',
    type: SettingItemType.Bool,
    advanced: true,
  },
};

const getRawSettings = async () => {
  const result = {};

  for (const [key, defaultValue] of Object.entries(DEFAULT_SETTINGS)) {
    let value = await joplin.settings.value(key);

    if (value === undefined || value === null || value === '') value = defaultValue;
    if (typeof defaultValue === 'number') {
      const numericValue = Number(value);
      value = Number.isFinite(numericValue) ? numericValue : defaultValue;
    }
    if (typeof defaultValue === 'boolean') value = Boolean(value);
    if (typeof defaultValue === 'string') value = String(value);

    result[key] = value;
  }

  return result;
};

const escapeHtml = (value) => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const collectHtmlTagRanges = (text) => {
  const ranges = [];
  const regex = /<!--[\s\S]*?-->|<\/?[A-Za-z][^>]*?>/g;
  let match;

  while ((match = regex.exec(text)) !== null) {
    ranges.push({ from: match.index, to: match.index + match[0].length });
  }

  return ranges;
};

const maskRanges = (text, ranges) => {
  if (!ranges.length) return text;

  const chars = text.split('');
  for (const range of ranges) {
    for (let i = range.from; i < range.to && i < chars.length; i += 1) chars[i] = ' ';
  }

  return chars.join('');
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

const countSyllables = (word) => {
  const normalized = String(word)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z]/g, '');

  if (!normalized) return 0;
  if (normalized.length <= 3) return 1;

  let processed = normalized
    .replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/i, '')
    .replace(/^y/, '');

  const matches = processed.match(/[aeiouy]{1,2}/g);
  let count = matches ? matches.length : 1;

  if (/[^aeiou]le$/.test(normalized) && !/[^aeiou]les$/.test(normalized)) count += 1;
  return Math.max(1, count);
};

const readabilityDescriptor = (score) => {
  if (!Number.isFinite(score)) return 'N/A';
  if (score >= 90) return 'Very easy to read';
  if (score >= 80) return 'Easy to read';
  if (score >= 70) return 'Fairly easy to read';
  if (score >= 60) return 'Plain English';
  if (score >= 50) return 'Fairly difficult to read';
  if (score >= 30) return 'Difficult to read';
  if (score >= 10) return 'Very difficult to read';
  return 'Extremely difficult to read';
};

const analyzeNoteBody = (body, settings) => {
  const tagRanges = collectHtmlTagRanges(body);
  const analysisText = maskRanges(body, tagRanges);
  const sentenceRanges = findSentenceRanges(analysisText, settings);

  const counts = { xs: 0, sm: 0, md: 0, lg: 0, xl: 0 };
  let totalSentences = 0;
  let totalWords = 0;
  let totalSyllables = 0;

  for (const range of sentenceRanges) {
    const sentence = analysisText.slice(range.start, range.end).trim();
    const words = sentence.match(WORD_REGEX) || [];
    if (!words.length) continue;

    const wordCount = words.length;
    counts[classifySentence(wordCount, settings)] += 1;
    totalSentences += 1;
    totalWords += wordCount;

    for (const word of words) totalSyllables += countSyllables(word);
  }

  let fleschReadingEase = null;
  let fleschKincaidGrade = null;

  if (totalSentences > 0 && totalWords > 0 && totalSyllables > 0) {
    const wordsPerSentence = totalWords / totalSentences;
    const syllablesPerWord = totalSyllables / totalWords;
    fleschReadingEase = 206.835 - 1.015 * wordsPerSentence - 84.6 * syllablesPerWord;
    fleschKincaidGrade = 0.39 * wordsPerSentence + 11.8 * syllablesPerWord - 15.59;
  }

  return {
    totalSentences,
    totalWords,
    totalSyllables,
    counts,
    fleschReadingEase,
    fleschKincaidGrade,
  };
};

const donutChartSvg = (stats, settings) => {
  const total = stats.totalSentences;
  const size = 176;
  const radius = 54;
  const cx = size / 2;
  const cy = size / 2;
  const circumference = 2 * Math.PI * radius;

  if (!total) {
    return `
      <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="No sentence rhythm data">
        <circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="rgba(127,127,127,.2)" stroke-width="18" />
        <text x="${cx}" y="${cy - 4}" text-anchor="middle" font-size="26" font-weight="700" fill="currentColor">0</text>
        <text x="${cx}" y="${cy + 18}" text-anchor="middle" font-size="12" fill="currentColor">sentences</text>
      </svg>`;
  }

  let offset = 0;
  const segments = CATEGORY_ORDER.map((key) => {
    const value = stats.counts[key] || 0;
    if (!value) return '';

    const length = circumference * (value / total);
    const color = settings[`${key}Color`];
    const segment = `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="${escapeHtml(color)}" stroke-width="18" stroke-linecap="butt" stroke-dasharray="${length} ${circumference - length}" stroke-dashoffset="${-offset}" transform="rotate(-90 ${cx} ${cy})" />`;
    offset += length;
    return segment;
  }).join('');

  return `
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="Sentence rhythm distribution chart">
      <circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="rgba(127,127,127,.16)" stroke-width="18" />
      ${segments}
      <circle cx="${cx}" cy="${cy}" r="31" fill="var(--joplin-background-color)" />
      <text x="${cx}" y="${cy - 4}" text-anchor="middle" font-size="26" font-weight="700" fill="currentColor">${total}</text>
      <text x="${cx}" y="${cy + 18}" text-anchor="middle" font-size="12" fill="currentColor">sentences</text>
    </svg>`;
};

const metricCard = (label, value, sublabel) => `
  <div style="border:1px solid rgba(127,127,127,.22);border-radius:10px;padding:10px 12px;background:rgba(127,127,127,.04);min-width:0;">
    <div style="font-size:12px;opacity:.72;margin-bottom:4px;">${escapeHtml(label)}</div>
    <div style="font-size:22px;font-weight:700;line-height:1.1;">${escapeHtml(value)}</div>
    ${sublabel ? `<div style="font-size:12px;opacity:.72;margin-top:4px;">${escapeHtml(sublabel)}</div>` : ''}
  </div>`;

const overviewHtml = (stats, settings, noteTitle) => {
  const rows = CATEGORY_ORDER.map((key) => {
    const count = stats.counts[key] || 0;
    const percentage = stats.totalSentences ? (count / stats.totalSentences) * 100 : 0;
    const colorKey = `${key}Color`;

    return `
      <tr>
        <td style="padding:6px 8px;">
          <span style="display:inline-block;width:11px;height:11px;border-radius:999px;background:${escapeHtml(settings[colorKey])};margin-right:8px;vertical-align:middle;border:1px solid rgba(0,0,0,.14);"></span>${escapeHtml(CATEGORY_LABELS[key])}
        </td>
        <td style="padding:6px 8px;text-align:right;">${count}</td>
        <td style="padding:6px 8px;text-align:right;white-space:nowrap;">${percentage.toFixed(1)}%</td>
      </tr>`;
  }).join('');

  const fleschReadingEase = Number.isFinite(stats.fleschReadingEase) ? stats.fleschReadingEase.toFixed(1) : 'N/A';
  const fleschKincaidGrade = Number.isFinite(stats.fleschKincaidGrade) ? stats.fleschKincaidGrade.toFixed(1) : 'N/A';

  return `
    <div style="width:520px;max-width:100%;margin:0 auto;padding:14px 16px 12px;color:var(--joplin-color);font-family:var(--joplin-font-family);background:var(--joplin-background-color);box-sizing:border-box;">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:10px;">
        <div>
          <h2 style="margin:0;font-size:18px;line-height:1.2;">Sentence Rhythm</h2>
          <div style="margin-top:3px;font-size:12px;opacity:.72;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(noteTitle || 'Untitled note')}</div>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 176px;gap:14px;align-items:center;">
        <div style="min-width:0;">
          <div style="display:grid;grid-template-columns:repeat(2, minmax(0, 1fr));gap:8px;">
            ${metricCard('Sentences', String(stats.totalSentences), null)}
            ${metricCard('Words', String(stats.totalWords), `${stats.totalSyllables} syllables`)}
            ${metricCard('Flesch Reading Ease', fleschReadingEase, readabilityDescriptor(stats.fleschReadingEase))}
            ${metricCard('Flesch–Kincaid Grade', fleschKincaidGrade, 'Lower is easier')}
          </div>
        </div>
        <div style="display:flex;justify-content:center;align-items:center;">${donutChartSvg(stats, settings)}</div>
      </div>

      <div style="margin-top:12px;border:1px solid rgba(127,127,127,.22);border-radius:10px;overflow:hidden;">
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead>
            <tr style="background:rgba(127,127,127,.06);">
              <th style="text-align:left;padding:7px 8px;">Length</th>
              <th style="text-align:right;padding:7px 8px;">Count</th>
              <th style="text-align:right;padding:7px 8px;">Share</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>

      <div style="margin-top:10px;font-size:11px;line-height:1.45;opacity:.68;">
        The overview is recalculated only when you run the command. Flesch values are heuristic and are most meaningful for English prose.
      </div>
    </div>`;
};

const noteHasAutoEnableTag = async (noteId, tagName) => {
  const wanted = String(tagName || '').trim().toLowerCase();
  if (!wanted || !noteId) return false;

  let page = 1;
  while (true) {
    const response = await joplin.data.get(['notes', noteId, 'tags'], {
      fields: ['id', 'title'],
      page,
      limit: 100,
    });

    const items = response && response.items ? response.items : [];
    if (items.some((item) => String(item.title || '').trim().toLowerCase() === wanted)) return true;
    if (!response || !response.has_more) break;
    page += 1;
  }

  return false;
};

const getEffectiveSettings = async () => {
  const settings = await getRawSettings();
  const autoTagName = String(settings.autoEnableTagName || '').trim();

  if (sessionManualEnabledOverride !== null) {
    settings.enabled = sessionManualEnabledOverride;
    return settings;
  }

  if (!autoTagName) return settings;

  const selectedNote = await joplin.workspace.selectedNote();
  if (!selectedNote) {
    settings.enabled = false;
    return settings;
  }

  settings.enabled = await noteHasAutoEnableTag(selectedNote.id, autoTagName);
  return settings;
};

const updateEditorSettings = async () => {
  try {
    await joplin.commands.execute('editor.execCommand', {
      name: COMMAND_APPLY_SETTINGS_ID,
      args: [await getEffectiveSettings()],
    });
  } catch (error) {
    console.info('Sentence Rhythm: editor settings update skipped.', error && error.message ? error.message : error);
  }
};

const registerSettings = async () => {
  await joplin.settings.registerSection(SECTION_ID, {
    label: 'Sentence Rhythm',
    description: 'Highlight sentence length and writing rhythm in the Markdown editor.',
    iconName: 'fas fa-wave-square',
  });

  const settings = {};
  for (const [key, defaultValue] of Object.entries(DEFAULT_SETTINGS)) {
    const meta = SETTING_METADATA[key];
    settings[key] = {
      value: defaultValue,
      type: meta.type,
      section: SECTION_ID,
      public: true,
      label: meta.label,
      description: meta.description,
      advanced: Boolean(meta.advanced),
    };

    if (typeof meta.minimum === 'number') settings[key].minimum = meta.minimum;
    if (typeof meta.maximum === 'number') settings[key].maximum = meta.maximum;
  }

  await joplin.settings.registerSettings(settings);
};

const registerContentScriptMessages = async () => {
  await joplin.contentScripts.onMessage(CONTENT_SCRIPT_ID, async (message) => {
    if (message === 'getSettings') return await getEffectiveSettings();
    return null;
  });
};

const showOverviewDialog = async (dialogHandle) => {
  const note = await joplin.workspace.selectedNote();
  if (!note) {
    await joplin.views.dialogs.showMessageBox('No note is currently selected.');
    return;
  }

  const settings = await getRawSettings();
  const stats = analyzeNoteBody(String(note.body || ''), settings);

  await joplin.views.dialogs.setButtons(dialogHandle, [{ id: 'ok', title: 'Close' }]);
  await joplin.views.dialogs.setFitToContent(dialogHandle, false);
  await joplin.views.dialogs.setHtml(dialogHandle, overviewHtml(stats, settings, note.title));
  await joplin.views.dialogs.open(dialogHandle);
};

const registerCommands = async (dialogHandle) => {
  await joplin.commands.register({
    name: COMMAND_TOGGLE_ID,
    label: 'Toggle sentence rhythm highlighting',
    iconName: 'fas fa-wave-square',
    enabledCondition: 'markdownEditorPaneVisible && !richTextEditorVisible',
    execute: async () => {
      const rawSettings = await getRawSettings();
      const autoTagName = String(rawSettings.autoEnableTagName || '').trim();

      if (autoTagName) {
        const effectiveSettings = await getEffectiveSettings();
        sessionManualEnabledOverride = !Boolean(effectiveSettings.enabled);
      } else {
        await joplin.settings.setValue('enabled', !Boolean(rawSettings.enabled));
      }

      await updateEditorSettings();
    },
  });

  await joplin.commands.register({
    name: COMMAND_SHOW_OVERVIEW_ID,
    label: 'Show sentence rhythm overview',
    iconName: 'fas fa-chart-pie',
    execute: async () => {
      await showOverviewDialog(dialogHandle);
    },
  });
};

const registerButtonsAndMenus = async () => {
  await joplin.views.toolbarButtons.create(
    'sentenceRhythmToggleNoteToolbar',
    COMMAND_TOGGLE_ID,
    ToolbarButtonLocation.NoteToolbar
  );

  await joplin.views.toolbarButtons.create(
    'sentenceRhythmToggleEditorToolbar',
    COMMAND_TOGGLE_ID,
    ToolbarButtonLocation.EditorToolbar
  );

  await joplin.views.menuItems.create(
    'sentenceRhythmToggleEditorContextMenu',
    COMMAND_TOGGLE_ID,
    MenuItemLocation.EditorContextMenu
  );
};

joplin.plugins.register({
  onStart: async function () {
    const overviewDialogHandle = await joplin.views.dialogs.create(OVERVIEW_DIALOG_ID);

    await registerSettings();
    await registerContentScriptMessages();

    await joplin.contentScripts.register(
      ContentScriptType.CodeMirrorPlugin,
      CONTENT_SCRIPT_ID,
      './contentScript.js'
    );

    await registerCommands(overviewDialogHandle);
    await registerButtonsAndMenus();

    await joplin.workspace.onNoteSelectionChange(async () => {
      sessionManualEnabledOverride = null;
      await updateEditorSettings();
    });

    await joplin.settings.onChange(async () => {
      sessionManualEnabledOverride = null;
      await updateEditorSettings();
    });

    await updateEditorSettings();
  },
});
