// Voice input: records the microphone with MediaRecorder and transcribes it with
// OpenAI's speech-to-text API, using the tutoring conversation as context so that
// mathematical vocabulary is recognized.

const ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions';
export const TRANSCRIBE_MODEL = 'gpt-transcribe';
const MAX_SECONDS = 300;

export function recordingSupported(): boolean {
  return typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
}

function pickMime(): { mime: string; ext: string } {
  // iPad Safari records AAC in mp4; Chrome records Opus in webm.
  const candidates: [string, string][] = [['audio/mp4', 'm4a'], ['audio/webm;codecs=opus', 'webm'], ['audio/webm', 'webm'], ['audio/ogg;codecs=opus', 'ogg']];
  for (const [mime, ext] of candidates) if (MediaRecorder.isTypeSupported?.(mime)) return { mime, ext };
  return { mime: '', ext: 'm4a' };
}

export class Recorder {
  private rec: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: Blob[] = [];
  private ext = 'm4a';
  private timer = 0;
  private stopped: Promise<Blob> | null = null;
  started = 0;
  onAutoStop: () => void = () => {};

  get recording() { return this.rec !== null; }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const { mime, ext } = pickMime();
    this.ext = ext;
    this.chunks = [];
    this.rec = mime ? new MediaRecorder(this.stream, { mimeType: mime }) : new MediaRecorder(this.stream);
    const rec = this.rec;
    this.stopped = new Promise<Blob>((resolve) => {
      rec.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data); };
      rec.onstop = () => resolve(new Blob(this.chunks, { type: rec.mimeType || mime || 'audio/mp4' }));
    });
    rec.start(1000);
    this.started = Date.now();
    this.timer = window.setTimeout(() => this.onAutoStop(), MAX_SECONDS * 1000);
  }

  /** Stops recording and returns the audio as a named file. */
  async stop(): Promise<File | null> {
    const rec = this.rec;
    if (!rec) return null;
    clearTimeout(this.timer);
    this.rec = null;
    if (rec.state !== 'inactive') rec.stop();
    const blob = await this.stopped!;
    this.release();
    if (!blob.size) return null;
    return new File([blob], `speech.${this.ext}`, { type: blob.type });
  }

  /** Stops and discards the recording. */
  cancel() {
    clearTimeout(this.timer);
    const rec = this.rec;
    this.rec = null;
    try { if (rec && rec.state !== 'inactive') rec.stop(); } catch { /* ignore */ }
    this.release();
  }

  private release() {
    // Turns off the microphone (and the iPad's mic indicator).
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}

export class TranscribeError extends Error {
  constructor(message: string, public status = 0) { super(message); }
}

export interface TranscribeContext {
  /** The tutor's last message, plain text. */
  lastTutorMessage?: string;
  topic?: string;
  /** Domain terms (e.g. skill-map subskills). */
  terms?: string[];
}

function buildPrompt(ctx: TranscribeContext): string {
  const tutor = (ctx.lastTutorMessage ?? '')
    .replace(/```[\s\S]*?```/g, ' ')   // figures and skill maps
    .replace(/\s+/g, ' ')
    .trim();
  const tail = tutor.length > 900 ? '…' + tutor.slice(-900) : tutor;
  return [
    'A student is speaking to their tutor in a mathematics / science tutoring session',
    ctx.topic ? ` about ${ctx.topic}` : '',
    '. Expect mathematical terms (e.g. covariance, eigenvalue, derivative, integral, converges, decays to zero) and spoken formulas.',
    tail ? ` The tutor just said: "${tail}"` : '',
  ].join('');
}

function keywordsOf(ctx: TranscribeContext): string[] {
  const words = [ctx.topic, ...(ctx.terms ?? [])]
    .filter((w): w is string => !!w)
    .map((w) => w.replace(/[<>\r\n]/g, ' ').trim())
    .filter((w) => w.length > 1 && w.length < 80);
  return [...new Set(words)].slice(0, 30);
}

async function post(apiKey: string, form: FormData, signal?: AbortSignal): Promise<string> {
  let res: Response;
  try {
    res = await fetch(ENDPOINT, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form, signal });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    // OpenAI's error responses carry no CORS headers, so in a browser a rejected key or a
    // rejected request also shows up as a network failure.
    throw new TranscribeError('Could not reach OpenAI, or it rejected the request. Check the connection and the OpenAI key in Settings.');
  }
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.error?.message ?? ''; } catch { /* not JSON */ }
    if (res.status === 401) throw new TranscribeError('The OpenAI API key was rejected. Check it in Settings.', 401);
    if (res.status === 429) throw new TranscribeError('OpenAI rate limit or quota reached. ' + detail, 429);
    throw new TranscribeError(`Transcription failed (${res.status})${detail ? ': ' + detail : ''}`, res.status);
  }
  const data = await res.json();
  return String(data?.text ?? '').trim();
}

export async function transcribe(apiKey: string, file: File, ctx: TranscribeContext, signal?: AbortSignal): Promise<string> {
  const base = () => {
    const f = new FormData();
    f.append('file', file, file.name);
    f.append('model', TRANSCRIBE_MODEL);
    f.append('response_format', 'json');
    return f;
  };
  const form = base();
  form.append('prompt', buildPrompt(ctx));
  const kw = keywordsOf(ctx);
  if (kw.length) form.append('keywords', kw.join('\n'));
  try {
    return await post(apiKey, form, signal);
  } catch (e) {
    // If the context hints are rejected (e.g. a length limit), retry with the audio alone.
    // (Status 0 is included because a 400 is indistinguishable from a network error in a browser.)
    if (e instanceof TranscribeError && (e.status === 400 || e.status === 0)) return post(apiKey, base(), signal);
    throw e;
  }
}
