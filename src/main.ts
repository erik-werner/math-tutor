import 'katex/dist/katex.min.css';
import './style.css';
import type Anthropic from '@anthropic-ai/sdk';
import { Board, loadImage, svgToPng } from './board';
import { MODELS, addUsage, friendlyError, streamReply } from './claude';
import { extractLastSkillMap, renderMarkdown, renderSkillMap } from './markdown';
import { systemPrompt, type Mode } from './prompt';
import { Recorder, recordingSupported, transcribe, type TranscribeContext } from './transcribe';
import {
  type Session, type Settings, type StoredMessage,
  deleteSession, exportAll, getBoard, getSession, importAll, listSessions, loadSettings,
  newSession, putBoard, putSession, saveSettings, setUiPref, uiPref,
} from './store';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const h = (html: string) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild as HTMLElement; };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

let settings: Settings = loadSettings();
let session: Session;
let board: Board;
let sentVersion = 0;
let attachOverride: boolean | null = null; // null = automatic (on when the board has unsent changes)
let busy = false;
let abort: AbortController | null = null;

const messagesEl = $('#messages');
const input = $<HTMLTextAreaElement>('#input');

// ---------- Small UI helpers ----------
let toastTimer = 0;
function toast(msg: string, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.remove('show'), ms);
}

interface ModalButton { label: string; value: string; primary?: boolean; danger?: boolean }
function modal(title: string, body: HTMLElement | string, buttons: ModalButton[], onOpen?: (root: HTMLElement) => void): Promise<string | null> {
  return new Promise((resolve) => {
    const wrap = h(`<div class="modal-wrap"><div class="modal" role="dialog" aria-modal="true"><h3></h3><div class="m-body"></div><div class="m-actions"></div></div></div>`);
    wrap.querySelector('h3')!.textContent = title;
    const bodyEl = wrap.querySelector('.m-body')!;
    if (typeof body === 'string') bodyEl.innerHTML = body; else bodyEl.append(body);
    const actions = wrap.querySelector('.m-actions')!;
    const close = (v: string | null) => { wrap.remove(); resolve(v); };
    for (const b of buttons) {
      const btn = h(`<button class="pill${b.primary ? ' primary' : ''}${b.danger ? ' danger' : ''}" type="button"></button>`);
      btn.textContent = b.label;
      btn.onclick = () => close(b.value);
      actions.append(btn);
    }
    wrap.addEventListener('click', (e) => { if (e.target === wrap) close(null); });
    $('#modal-root').append(wrap);
    onOpen?.(wrap);
  });
}

async function promptText(title: string, value: string): Promise<string | null> {
  const body = h(`<div><input type="text" /></div>`);
  const inp = body.querySelector('input')!;
  inp.value = value;
  const r = await modal(title, body, [{ label: 'Cancel', value: 'cancel' }, { label: 'Save', value: 'ok', primary: true }], () => inp.focus());
  return r === 'ok' ? inp.value.trim() : null;
}

// ---------- Layout ----------
function setLayout(l: string) {
  document.body.dataset.layout = l;
  document.querySelectorAll('#layout-seg button').forEach((b) => b.classList.toggle('active', (b as HTMLElement).dataset.layout === l));
  setUiPref('layout', l);
}

function setupLayout() {
  setLayout(uiPref('layout', 'split'));
  $('#layout-seg').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (b?.dataset.layout) setLayout(b.dataset.layout);
  });
  const split = $('#split');
  const saved = uiPref<Record<string, number>>('split', {});
  const orient = () => (matchMedia('(orientation: portrait)').matches ? 'portrait' : 'landscape');
  const apply = () => {
    const v = saved[orient()];
    if (v) split.style.setProperty('--split', v + '%'); else split.style.removeProperty('--split');
  };
  apply();
  matchMedia('(orientation: portrait)').addEventListener('change', apply);
  const div = $('#divider');
  div.addEventListener('pointerdown', (e) => {
    div.setPointerCapture(e.pointerId);
    const r = split.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      const portrait = orient() === 'portrait';
      const frac = portrait ? (ev.clientY - r.top) / r.height : (ev.clientX - r.left) / r.width;
      const pct = Math.round(Math.min(80, Math.max(20, frac * 100)));
      split.style.setProperty('--split', pct + '%');
      saved[orient()] = pct;
    };
    const up = () => {
      div.removeEventListener('pointermove', move);
      div.removeEventListener('pointerup', up);
      setUiPref('split', saved);
    };
    div.addEventListener('pointermove', move);
    div.addEventListener('pointerup', up);
  });

  // Keep the layout above the on-screen keyboard on iPad.
  const vv = window.visualViewport;
  if (vv) {
    const fit = () => {
      document.documentElement.style.setProperty('--app-h', vv.height + 'px');
      window.scrollTo(0, 0);
    };
    vv.addEventListener('resize', fit);
    fit();
  }
}

// ---------- Rendering messages ----------
function textOf(m: StoredMessage): string {
  if (typeof m.content === 'string') return m.content;
  return m.content.filter((b) => b.type === 'text').map((b) => (b as Anthropic.Beta.BetaTextBlockParam).text).join('\n\n');
}
function imagesOf(m: StoredMessage): string[] {
  if (typeof m.content === 'string') return [];
  return m.content.filter((b) => b.type === 'image').map((b) => {
    const src = (b as Anthropic.Beta.BetaImageBlockParam).source as Anthropic.Beta.BetaBase64ImageSource;
    return `data:${src.media_type};base64,${src.data}`;
  });
}

function messageEl(m: StoredMessage): HTMLElement {
  if (m.role === 'user') {
    const el = h(`<div class="msg user"></div>`);
    const imgs = imagesOf(m);
    if (imgs.length) {
      const row = h(`<div class="thumbs"></div>`);
      for (const src of imgs) {
        const w = h(`<div class="thumb-wrap"><img class="thumb" alt="Whiteboard" /></div>`);
        (w.querySelector('img') as HTMLImageElement).src = src;
        row.append(w);
      }
      el.append(row);
    }
    const text = textOf(m);
    if (text && text !== BOARD_ONLY_TEXT) el.append(h(`<div class="md">${renderMarkdown(text)}</div>`));
    return el;
  }
  const el = h(`<div class="msg assistant"><div class="md"></div></div>`);
  el.querySelector('.md')!.innerHTML = renderMarkdown(textOf(m));
  if (Array.isArray(m.content) && m.content.some((b) => b.type === 'fallback')) {
    el.append(h(`<div class="msg-note">Part of this answer came from a fallback model.</div>`));
  }
  return el;
}

function welcomeEl(): HTMLElement {
  const tutor = session.mode === 'tutor';
  const ex = tutor
    ? ['Teach me eigenvalues and eigenvectors', 'Drill me on integration by parts', 'Help me master Bayes’ theorem', 'Tutor me on proofs by induction']
    : ['Why does the determinant measure area?', 'Explain the Fourier transform with a picture', 'Check my solution on the board'];
  const el = h(`<div class="welcome"><h2>${tutor ? 'What do you want to learn?' : 'Ask anything'}</h2>
    <div>${tutor ? 'Name a topic. The tutor starts by asking a few questions to see where you are, then teaches mainly by asking you questions.' : 'Free-form questions and explanations, no quizzing.'}
    Answer by typing, dictating, or writing on the board.</div><div class="suggestions"></div></div>`);
  const box = el.querySelector('.suggestions')!;
  for (const s of ex) {
    const b = h(`<button type="button"></button>`);
    b.textContent = s;
    b.onclick = () => { input.value = s; autosize(); input.focus(); };
    box.append(b);
  }
  return el;
}

function renderAll() {
  messagesEl.innerHTML = '';
  if (!session.messages.length) messagesEl.append(welcomeEl());
  for (const m of session.messages) messagesEl.append(messageEl(m));
  scrollToBottom(true);
  updateHeader();
}

// "Pinned" = the user is reading the end of the conversation, so new content keeps it scrolled down.
let pinned = true;
function nearBottom() { return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 120; }
messagesEl.addEventListener('scroll', () => { pinned = nearBottom(); }, { passive: true });
function scrollToBottom(force = false) {
  if (force || pinned) { messagesEl.scrollTop = messagesEl.scrollHeight; pinned = true; }
}
// Images (whiteboard thumbnails) change the height after they load.
messagesEl.addEventListener('load', () => scrollToBottom(), true);

function updateHeader() {
  $('#session-title').textContent = session.title;
  const u = session.usage;
  $('#cost').textContent = u.cost > 0 ? `$${u.cost < 0.995 ? u.cost.toFixed(2) : u.cost.toFixed(2)}` : '';
  $('#cost').title = `Estimated cost. Tokens: ${u.input} input, ${u.cacheWrite} cache write, ${u.cacheRead} cache read, ${u.output} output`;
  $('#quick').hidden = session.mode !== 'tutor';
}

// Click handlers inside the message list (figures to board, image zoom)
messagesEl.addEventListener('click', async (e) => {
  const t = e.target as HTMLElement;
  const figBtn = t.closest('[data-action="fig-to-board"]');
  if (figBtn) {
    const svg = figBtn.closest('.fig')?.querySelector('svg');
    if (!svg) return;
    try {
      const png = await svgToPng(new XMLSerializer().serializeToString(svg));
      await placeOnBoard(png.src, png.w, png.h);
    } catch (err) {
      toast('Could not copy figure: ' + (err as Error).message);
    }
    return;
  }
  const img = t.closest('img.thumb') as HTMLImageElement | null;
  if (img) {
    const body = h(`<div><img class="big" alt="Whiteboard" /></div>`);
    (body.querySelector('img') as HTMLImageElement).src = img.src;
    const r = await modal('Whiteboard image', body, [{ label: 'Close', value: 'close' }, { label: '✎ Put on board', value: 'board', primary: true }]);
    if (r === 'board') {
      const im = await loadImage(img.src);
      await placeOnBoard(img.src, im.naturalWidth / 2, im.naturalHeight / 2);
    }
  }
});

async function placeOnBoard(src: string, w: number, h2: number) {
  if (document.body.dataset.layout === 'chat') setLayout('split');
  if (board.hasInk()) {
    const r = await modal('Put on board', 'Your board already has drawings on it.', [
      { label: 'Cancel', value: 'cancel' }, { label: 'Add to board', value: 'add' }, { label: 'Replace board', value: 'replace', primary: true },
    ]);
    if (r === 'replace') board.clear();
    else if (r !== 'add') return;
  } else if (!board.isEmpty()) {
    board.clear();
  }
  await board.addImage(src, w, h2);
  toast('Draw on the figure, then tap Send board');
}

// ---------- Sending ----------
const BOARD_ONLY_TEXT = '(My work is on the whiteboard image.)';

function boardDirty() { return !board.isEmpty() && board.version !== sentVersion && board.hasInk(); }
function attachOn() { return attachOverride ?? boardDirty(); }
function updateAttachChip() {
  const chip = $('#attach-chip');
  chip.setAttribute('aria-pressed', String(attachOn() && !board.isEmpty()));
  (chip as HTMLButtonElement).disabled = board.isEmpty();
}

async function send(text: string, forceBoard = false) {
  if (busy) return;
  text = text.trim();
  const withBoard = !board.isEmpty() && (forceBoard || attachOn());
  if (!text && !withBoard) {
    if (forceBoard) toast('The board is empty');
    return;
  }
  if (!settings.apiKey.trim()) {
    await openSettings();
    if (!settings.apiKey.trim()) return;
  }
  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  if (withBoard) {
    const exp = await board.export();
    if (exp) {
      content.push({ type: 'image', source: { type: 'base64', media_type: exp.mediaType, data: exp.base64 } });
      sentVersion = board.version;
      attachOverride = null;
    }
  }
  content.push({ type: 'text', text: text || BOARD_ONLY_TEXT });
  const msg: StoredMessage = { role: 'user', content, ts: Date.now() };
  if (!session.messages.length) {
    messagesEl.innerHTML = '';
    if (text) session.title = text.length > 48 ? text.slice(0, 46) + '…' : text;
  }
  session.messages.push(msg);
  session.updated = Date.now();
  await putSession(session);
  messagesEl.append(messageEl(msg));
  clearComposerAfterSend(text);
  updateAttachChip();
  updateHeader();
  scrollToBottom(true);
  await runAssistant();
}

async function runAssistant() {
  busy = true;
  setBusyUi(true);
  const el = h(`<div class="msg assistant"><div class="md"><span class="typing"><i></i><i></i><i></i> thinking</span></div></div>`);
  messagesEl.append(el);
  scrollToBottom(true);
  const md = el.querySelector('.md')!;
  abort = new AbortController();
  let latest = '', scheduled = false;
  const sess = session;
  try {
    const r = await streamReply({
      settings, system: systemPrompt(sess.mode), messages: sess.messages, signal: abort.signal,
      onText: (t) => {
        latest = t;
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => {
          scheduled = false;
          if (sess !== session) return;
          md.innerHTML = renderMarkdown(latest, true);
          scrollToBottom();
        });
      },
    });
    sess.usage = addUsage(sess.usage, r.usage);
    if (r.content.some((b) => b.type === 'text' && (b as Anthropic.Beta.BetaTextBlockParam).text.trim())) {
      const am: StoredMessage = { role: 'assistant', content: r.content, ts: Date.now() };
      sess.messages.push(am);
      const sm = extractLastSkillMap(r.text);
      if (sm) sess.skillmap = sm;
      if (sess === session) el.replaceWith(messageEl(am));
    } else if (sess === session) {
      el.remove();
    }
    if (sess === session) {
      if (r.stopReason === 'refusal') messagesEl.append(h(`<div class="msg error"><span>Claude declined to answer this. Try rephrasing.</span></div>`));
      if (r.stopReason === 'max_tokens') messagesEl.append(h(`<div class="msg-note">The reply was cut off at the length limit.</div>`));
    }
  } catch (e) {
    const aborted = abort?.signal.aborted;
    if (aborted && latest.trim()) {
      const am: StoredMessage = { role: 'assistant', content: [{ type: 'text', text: latest + '\n\n*(stopped)*' }], ts: Date.now() };
      sess.messages.push(am);
      if (sess === session) el.replaceWith(messageEl(am));
    } else {
      el.remove();
      if (!aborted && sess === session) {
        const err = h(`<div class="msg error"><span></span><button class="pill" type="button">Retry</button></div>`);
        err.querySelector('span')!.textContent = friendlyError(e);
        err.querySelector('button')!.onclick = () => { err.remove(); if (!busy) runAssistant(); };
        messagesEl.append(err);
      }
    }
  } finally {
    busy = false;
    abort = null;
    sess.updated = Date.now();
    await putSession(sess);
    setBusyUi(false);
    if (sess === session) { updateHeader(); scrollToBottom(); }
  }
}

function setBusyUi(on: boolean) {
  const btn = $('#btn-send');
  btn.innerHTML = on
    ? '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2" class="fill"/></svg>'
    : '<svg viewBox="0 0 24 24"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4Z"/></svg>';
  btn.title = on ? 'Stop' : 'Send';
  ($('#board-send') as HTMLButtonElement).disabled = on;
}

// iPad keyboard dictation often commits its final text a moment after the message was sent,
// putting it back into the cleared field. For a short while after sending, drop text that
// matches what was just sent.
let echoGuard: { text: string; until: number } | null = null;
let stopDictation: () => void = () => {};

// Compares texts ignoring case, punctuation and spacing: iOS often re-inserts dictated text
// with a capital letter or a final period added.
const normText = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function clearComposerAfterSend(sent: string) {
  stopDictation();
  // Taking focus away from the field ends an active iPad keyboard-dictation session,
  // so it can't write the text back. (Hides the keyboard, which also frees space for the reply.)
  if (document.activeElement === input) input.blur();
  input.value = '';
  autosize();
  const norm = normText(sent);
  if (norm) {
    echoGuard = { text: norm, until: Date.now() + 4000 };
    // Some dictation commits don't fire any event, so also check on a timer.
    for (const ms of [150, 400, 900, 1600, 2500, 3500]) setTimeout(dropDictationEcho, ms);
  }
}

function dropDictationEcho() {
  if (!echoGuard) return;
  if (Date.now() > echoGuard.until) { echoGuard = null; return; }
  const v = normText(input.value);
  // Require a substantial chunk, so a new message typed right away isn't wiped.
  if (v && v.length >= Math.min(echoGuard.text.length, 6) && echoGuard.text.includes(v)) {
    input.value = '';
    autosize();
  }
}

/** Sends the composer text, first finishing any voice recording or transcription in progress. */
async function sendComposer(doSend: (text: string) => unknown = (t) => send(t)) {
  if (recorder.recording) await toggleOpenAIRecording();
  else if (transcription) await transcription;
  doSend(input.value);
}

function autosize() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight + 2, window.innerHeight * 0.3) + 'px';
}

function setupComposer() {
  $('#composer').addEventListener('submit', (e) => {
    e.preventDefault();
    if (busy) { abort?.abort(); return; }
    sendComposer();
  });
  input.addEventListener('input', () => { dropDictationEcho(); autosize(); });
  for (const ev of ['compositionend', 'change'] as const) input.addEventListener(ev, dropDictationEcho);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (!busy) sendComposer();
    }
  });
  $('#quick').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (b?.dataset.quick) sendComposer((t) => send(b.dataset.quick + (t.trim() ? '\n\n' + t : '')));
  });
  $('#attach-chip').addEventListener('click', () => {
    attachOverride = !attachOn();
    updateAttachChip();
  });
  $('#board-send').addEventListener('click', () => sendComposer((t) => send(t, true)));
  setupDictation();
}

// ---------- Voice input ----------
// With an OpenAI key: record and transcribe with OpenAI, using the conversation as context.
// Without one: the browser's Web Speech API, where available. (The iPad keyboard's own mic
// key always works too.)
const SpeechRec = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
const recorder = new Recorder();
let transcribing: AbortController | null = null;
let transcription: Promise<void> | null = null;

function useOpenAIVoice() { return !!settings.openaiKey.trim() && recordingSupported(); }

function updateMicButton() {
  $('#btn-mic').hidden = !(useOpenAIVoice() || SpeechRec);
}

const MIC_ICONS = {
  idle: '<svg viewBox="0 0 24 24"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z M19 10v2a7 7 0 0 1-14 0v-2 M12 19v3"/></svg>',
  listening: '<svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="2" class="fill"/></svg>',
  busy: '<svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-6.2-8.6"/></svg>',
};

function setMicState(state: 'idle' | 'listening' | 'busy', title?: string) {
  const btn = $('#btn-mic') as HTMLButtonElement;
  btn.innerHTML = MIC_ICONS[state];
  btn.classList.toggle('listening', state === 'listening');
  btn.classList.toggle('busy', state === 'busy');
  btn.title = title ?? (state === 'listening' ? 'Stop and transcribe' : 'Dictate');
}

function appendToInput(text: string) {
  if (!text) return;
  const cur = input.value.replace(/\s+$/, '');
  input.value = cur ? cur + ' ' + text : text;
  autosize();
}

function transcriptionContext(): TranscribeContext {
  const lastTutor = [...session.messages].reverse().find((m) => m.role === 'assistant');
  const sm = session.skillmap;
  return {
    lastTutorMessage: lastTutor ? textOf(lastTutor) : undefined,
    topic: sm?.topic,
    terms: Array.isArray(sm?.skills) ? sm!.skills.map((k) => String(k.name ?? '')) : [],
  };
}

// Live preview while recording: every few seconds the audio so far is transcribed and shown
// in the text field, greyed out. When recording stops, the whole clip is transcribed once
// more and that text replaces the preview.
let preview: { base: string; stopped: boolean; timer: number; ctrl: AbortController | null; failures: number } | null = null;

function showVoiceText(base: string, text: string) {
  input.value = base && text ? base + ' ' + text : base || text;
  autosize();
  input.scrollTop = input.scrollHeight;
}

function startPreview() {
  const p = { base: input.value.replace(/\s+$/, ''), stopped: false, timer: 0, ctrl: null as AbortController | null, failures: 0 };
  preview = p;
  input.readOnly = true;
  input.classList.add('interim');
  const tick = async () => {
    if (p.stopped || !recorder.recording) return;
    const file = recorder.snapshot();
    if (file && file.size > 8000) { // the first chunk can be just the file header
      p.ctrl = new AbortController();
      try {
        const text = await transcribe(settings.openaiKey.trim(), file, transcriptionContext(), p.ctrl.signal, false);
        if (!p.stopped && text) showVoiceText(p.base, text);
        p.failures = 0;
      } catch {
        // Previews are best-effort; give up on them after repeated failures.
        if (++p.failures >= 3) return;
      } finally {
        p.ctrl = null;
      }
    }
    // Each preview re-sends the whole clip so far, so space them out as the clip grows.
    const secs = (Date.now() - recorder.started) / 1000;
    if (!p.stopped) p.timer = window.setTimeout(tick, Math.max(1500, secs * 125));
  };
  p.timer = window.setTimeout(tick, 2000);
}

/** Ends the preview and returns the text that was in the field before recording. */
function stopPreview(): string {
  input.readOnly = false;
  input.classList.remove('interim');
  const p = preview;
  preview = null;
  if (!p) return input.value.replace(/\s+$/, '');
  p.stopped = true;
  clearTimeout(p.timer);
  p.ctrl?.abort();
  return p.base;
}

function toggleOpenAIRecording(): Promise<void> {
  if (transcription) return transcription; // still working on the previous clip
  if (!recorder.recording) return startRecording();
  transcription = finishRecording().finally(() => { transcription = null; });
  return transcription;
}

async function startRecording() {
  echoGuard = null;
  try {
    await recorder.start();
  } catch (e) {
    const name = (e as Error).name;
    toast(name === 'NotAllowedError' ? 'Microphone access was denied. Allow it in Settings → Safari → Microphone.' : 'Could not start the microphone: ' + (e as Error).message, 4500);
    return;
  }
  setMicState('listening');
  startPreview();
}

async function finishRecording() {
  const shown = input.value;
  const base = stopPreview();
  const file = await recorder.stop();
  if (!file) { setMicState('idle'); return; }
  setMicState('busy', 'Transcribing…');
  input.classList.add('interim');
  transcribing = new AbortController();
  const sess = session;
  try {
    const text = await transcribe(settings.openaiKey.trim(), file, transcriptionContext(), transcribing.signal);
    if (sess === session) {
      if (text) showVoiceText(base, text);
      else { showVoiceText(base, ''); toast('No speech recognized'); }
    }
  } catch (e) {
    // The preview text (if any) stays in the field.
    if ((e as Error).name !== 'AbortError') { toast((e as Error).message, 4500); input.value = shown; autosize(); }
  } finally {
    transcribing = null;
    input.classList.remove('interim');
    setMicState('idle');
  }
}

let webSpeech: any = null;
function toggleWebSpeech() {
  if (webSpeech) { webSpeech.stop(); return; }
  echoGuard = null;
  const rec = new SpeechRec();
  webSpeech = rec;
  rec.lang = settings.speechLang;
  rec.continuous = true;
  rec.interimResults = true;
  const base = input.value.trim();
  rec.onresult = (e: any) => {
    let text = '';
    for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
    input.value = (base ? base + ' ' : '') + text.trim();
    autosize();
  };
  rec.onerror = (e: any) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') toast('Speech recognition is not allowed here. Use the mic key on the iPad keyboard, or add an OpenAI key in Settings.', 4500);
    else if (e.error !== 'aborted' && e.error !== 'no-speech') toast('Dictation error: ' + e.error);
  };
  rec.onend = () => { if (webSpeech === rec) webSpeech = null; setMicState('idle'); };
  try {
    rec.start();
    setMicState('listening');
  } catch (err) {
    webSpeech = null;
    toast('Could not start dictation: ' + (err as Error).message);
  }
}

function setupDictation() {
  updateMicButton();
  recorder.onAutoStop = () => { if (recorder.recording) toggleOpenAIRecording(); };
  stopDictation = () => {
    // Sending a message discards any recording or recognition still in progress.
    if (preview) stopPreview();
    if (recorder.recording) recorder.cancel();
    transcribing?.abort();
    if (webSpeech) {
      const r = webSpeech;
      webSpeech = null;
      r.onresult = null;
      try { r.abort(); } catch { /* already stopped */ }
    }
    setMicState('idle');
  };
  $('#btn-mic').addEventListener('click', () => {
    if (useOpenAIVoice()) toggleOpenAIRecording();
    else if (SpeechRec) toggleWebSpeech();
  });
}

// ---------- Board ----------
let boardSaveTimer = 0;
function persistBoardSoon() {
  clearTimeout(boardSaveTimer);
  const id = session.id;
  boardSaveTimer = window.setTimeout(() => putBoard({ id, data: board.toJSON() }), 600);
}
async function flushBoard() {
  clearTimeout(boardSaveTimer);
  if (session) await putBoard({ id: session.id, data: board.toJSON() });
}

function updateBoardUi() {
  ($('#tool-undo') as HTMLButtonElement).disabled = !board.canUndo;
  ($('#tool-redo') as HTMLButtonElement).disabled = !board.canRedo;
  $('#tool-eraser').classList.toggle('active', board.tool === 'eraser');
  $('#tool-finger').classList.toggle('active', board.fingerDraws);
  updateAttachChip();
}

function setupBoard() {
  board = new Board($('#board'));
  board.fingerDraws = !settings.penOnly;
  board.onChange = () => { updateBoardUi(); persistBoardSoon(); };
  board.onPenDetected = () => { updateBoardUi(); toast('Apple Pencil detected: fingers no longer draw (toggle with ✋)'); };
  const sizes = [2.2, 3.5, 6];
  let sizeIdx = 1;
  $('#colors').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('.swatch') as HTMLElement | null;
    if (!b) return;
    document.querySelectorAll('#colors .swatch').forEach((s) => s.classList.toggle('active', s === b));
    board.color = b.dataset.color!;
    board.tool = 'pen';
    updateBoardUi();
  });
  $('#tool-size').addEventListener('click', () => {
    sizeIdx = (sizeIdx + 1) % sizes.length;
    board.size = sizes[sizeIdx];
    board.tool = 'pen';
    $('#tool-size').querySelector('circle')!.setAttribute('r', String([1.6, 2.5, 4][sizeIdx]));
    updateBoardUi();
  });
  $('#tool-eraser').addEventListener('click', () => { board.tool = board.tool === 'eraser' ? 'pen' : 'eraser'; updateBoardUi(); });
  $('#tool-finger').addEventListener('click', () => {
    board.fingerDraws = !board.fingerDraws;
    settings.penOnly = !board.fingerDraws;
    saveSettings(settings);
    updateBoardUi();
    toast(board.fingerDraws ? 'Fingers draw on the board' : 'Only the Apple Pencil draws');
  });
  $('#tool-undo').addEventListener('click', () => board.undo());
  $('#tool-redo').addEventListener('click', () => board.redo());
  $('#tool-clear').addEventListener('click', async () => {
    if (board.isEmpty()) return;
    const r = await modal('Clear the board?', 'You can still undo this.', [{ label: 'Cancel', value: 'no' }, { label: 'Clear', value: 'yes', primary: true }]);
    if (r === 'yes') board.clear();
  });
  updateBoardUi();
}

// ---------- Sessions ----------
async function openSession(s: Session) {
  if (session) await flushBoard();
  abort?.abort();
  stopDictation();
  session = s;
  setUiPref('lastSession', s.id);
  const rec = await getBoard(s.id);
  board.load(rec?.data);
  sentVersion = board.version;
  attachOverride = null;
  updateBoardUi();
  renderAll();
}

async function createSession(mode: Mode) {
  if (session && !session.messages.length && session.mode === mode && board.isEmpty()) { closeDrawer(); return; }
  const s = newSession(mode);
  await putSession(s);
  await openSession(s);
  closeDrawer();
  input.focus();
}

function fmtDate(t: number) {
  const d = new Date(t);
  const today = new Date();
  return d.toDateString() === today.toDateString()
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

async function renderSessionList() {
  const list = $('#session-list');
  list.innerHTML = '';
  const all = await listSessions();
  for (const s of all) {
    const li = h(`<li><div class="s-main"><div class="s-title"></div><div class="s-meta"></div></div>
      <button class="icon-btn" data-act="rename" aria-label="Rename"><svg viewBox="0 0 24 24"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></button>
      <button class="icon-btn" data-act="delete" aria-label="Delete"><svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg></button></li>`);
    if (s.id === session.id) li.classList.add('current');
    li.querySelector('.s-title')!.textContent = s.title;
    const turns = s.messages.filter((m) => m.role === 'user').length;
    li.querySelector('.s-meta')!.textContent = `${s.mode === 'tutor' ? 'Tutor' : 'Chat'} · ${fmtDate(s.updated)} · ${turns} turn${turns === 1 ? '' : 's'}${s.usage.cost ? ` · $${s.usage.cost.toFixed(2)}` : ''}`;
    li.querySelector('.s-main')!.addEventListener('click', async () => {
      const full = await getSession(s.id);
      if (full) await openSession(full);
      closeDrawer();
    });
    li.querySelector('[data-act="rename"]')!.addEventListener('click', async () => {
      const t = await promptText('Rename session', s.title);
      if (t) {
        s.title = t;
        await putSession(s);
        if (s.id === session.id) { session.title = t; updateHeader(); }
        renderSessionList();
      }
    });
    li.querySelector('[data-act="delete"]')!.addEventListener('click', async () => {
      const r = await modal('Delete session?', `“${esc(s.title)}” and its whiteboard will be deleted permanently.`, [{ label: 'Cancel', value: 'no' }, { label: 'Delete', value: 'yes', danger: true }]);
      if (r !== 'yes') return;
      await deleteSession(s.id);
      if (s.id === session.id) {
        const rest = await listSessions();
        if (rest.length) await openSession(rest[0]); else await openSession(await (async () => { const n = newSession('tutor'); await putSession(n); return n; })());
      }
      renderSessionList();
    });
    list.append(li);
  }
}

function openDrawer() { $('#drawer').hidden = false; renderSessionList(); }
function closeDrawer() { $('#drawer').hidden = true; }

// ---------- Settings ----------
async function openSettings() {
  const body = h(`<div>
    <label>Anthropic API key
      <p class="hint">Stored only in this browser on this device. Create one at console.anthropic.com, and consider setting a monthly spend limit there. Enter <b>demo</b> to try the interface without a key.</p></label>
    <input type="password" id="s-key" placeholder="sk-ant-…" autocomplete="off" autocapitalize="off" spellcheck="false" />
    <label>Model</label><select id="s-model"></select>
    <label>Thinking effort <p class="hint">Higher is more careful but slower and more expensive. Medium suits tutoring.</p></label>
    <select id="s-effort"><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="xhigh">Extra high</option><option value="max">Max</option></select>
    <label>OpenAI API key (voice input, optional)
      <p class="hint">With this key, the mic button records you and transcribes the audio with OpenAI's speech model, using the conversation as context, so math terms come through correctly (about half a cent per minute). Create one at platform.openai.com. Stored only on this device.</p></label>
    <input type="password" id="s-okey" placeholder="sk-…" autocomplete="off" autocapitalize="off" spellcheck="false" />
    <label>Browser dictation language <p class="hint">Only used by the mic button when no OpenAI key is set (e.g. sv-SE, en-US).</p></label>
    <input type="text" id="s-lang" autocapitalize="off" spellcheck="false" />
    <label>Text size</label>
    <select id="s-font"><option value="0.9">Small</option><option value="1">Normal</option><option value="1.12">Large</option><option value="1.25">Extra large</option></select>
    <label>Data</label>
    <div class="row"><button class="pill" type="button" id="s-export">Export all sessions</button>
    <button class="pill" type="button" id="s-import">Import…</button><input type="file" id="s-file" accept="application/json,.json" hidden /></div>
    <p class="hint" style="margin-top:14px">Version ${esc(__BUILD__)}</p>
  </div>`);
  const key = body.querySelector('#s-key') as HTMLInputElement;
  const model = body.querySelector('#s-model') as HTMLSelectElement;
  const effort = body.querySelector('#s-effort') as HTMLSelectElement;
  const lang = body.querySelector('#s-lang') as HTMLInputElement;
  const okey = body.querySelector('#s-okey') as HTMLInputElement;
  okey.value = settings.openaiKey;
  const font = body.querySelector('#s-font') as HTMLSelectElement;
  for (const m of MODELS) model.append(new Option(m.name, m.id));
  key.value = settings.apiKey;
  model.value = settings.model;
  effort.value = settings.effort;
  lang.value = settings.speechLang;
  font.value = String(settings.fontScale);
  body.querySelector('#s-export')!.addEventListener('click', async () => {
    const blob = new Blob([await exportAll()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `math-tutor-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });
  const file = body.querySelector('#s-file') as HTMLInputElement;
  body.querySelector('#s-import')!.addEventListener('click', () => file.click());
  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    if (!f) return;
    try { toast(`Imported ${await importAll(await f.text())} sessions`); } catch (e) { toast('Import failed: ' + (e as Error).message); }
  });
  const r = await modal('Settings', body, [{ label: 'Cancel', value: 'cancel' }, { label: 'Save', value: 'save', primary: true }]);
  if (r !== 'save') return;
  settings = {
    ...settings,
    apiKey: key.value.trim(),
    model: model.value,
    effort: effort.value as Settings['effort'],
    speechLang: lang.value.trim() || 'en-US',
    openaiKey: okey.value.trim(),
    fontScale: Number(font.value) || 1,
  };
  saveSettings(settings);
  applyFont();
  updateMicButton();
}

function applyFont() { document.documentElement.style.setProperty('--scale', String(settings.fontScale)); }

async function openProgress() {
  const body = session.skillmap
    ? renderSkillMap(session.skillmap)
    : '<p>No skill map yet. The tutor shows one after the first diagnostic questions, or tap "Show progress".</p>';
  await modal('Progress', body, [{ label: 'Close', value: 'close', primary: true }]);
}

// ---------- Update check ----------
// GitHub Pages lets browsers cache the page for a while, and a home-screen app keeps running in
// the background. When the app comes back to the foreground, check whether a newer build is
// deployed and offer a reload.
const currentBundle = (document.querySelector('script[type="module"][src]') as HTMLScriptElement | null)?.getAttribute('src') ?? '';
let updateOffered = false;
async function checkForUpdate() {
  if (updateOffered || import.meta.env.DEV || !currentBundle) return;
  try {
    // 'reload' bypasses and refreshes the HTTP cache, so location.reload() then gets the new page.
    const html = await (await fetch('./index.html', { cache: 'reload' })).text();
    const latest = /<script[^>]+type="module"[^>]+src="([^"]+)"/.exec(html)?.[1];
    if (latest && latest !== currentBundle) {
      updateOffered = true;
      const r = await modal('Update available', 'A new version of the app has been deployed.', [{ label: 'Later', value: 'later' }, { label: 'Reload now', value: 'reload', primary: true }]);
      if (r === 'reload') { await flushBoard(); location.reload(); }
    }
  } catch { /* offline */ }
}

// ---------- Boot ----------
async function boot() {
  applyFont();
  setupLayout();
  setupBoard();
  setupComposer();
  $('#btn-sessions').addEventListener('click', openDrawer);
  $('#drawer-close').addEventListener('click', closeDrawer);
  $('#drawer-scrim').addEventListener('click', closeDrawer);
  $('#new-tutor').addEventListener('click', () => createSession('tutor'));
  $('#new-chat').addEventListener('click', () => createSession('chat'));
  $('#btn-settings').addEventListener('click', openSettings);
  $('#btn-progress').addEventListener('click', openProgress);
  $('#session-title').addEventListener('click', async () => {
    const t = await promptText('Rename session', session.title);
    if (t) { session.title = t; await putSession(session); updateHeader(); }
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) flushBoard(); else checkForUpdate(); });
  setTimeout(checkForUpdate, 3000);

  const all = await listSessions();
  const lastId = uiPref<string | null>('lastSession', null);
  let s = all.find((x) => x.id === lastId) ?? all[0];
  if (!s) { s = newSession('tutor'); await putSession(s); }
  await openSession(s);
  if (!settings.apiKey) openSettings();
}

boot();
