import Anthropic from '@anthropic-ai/sdk';
import type { Settings, StoredMessage, Usage } from './store';

export const MODELS: { id: string; name: string; price: { in: number; out: number; cw: number; cr: number } }[] = [
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5 (recommended)', price: { in: 4, out: 20, cw: 5, cr: 0.2 } },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5 (cheaper, faster)', price: { in: 2, out: 10, cw: 2.5, cr: 0.1 } },
  { id: 'claude-fable-5-2', name: 'Claude Fable 5.2 (most capable, pricier)', price: { in: 8, out: 40, cw: 10, cr: 0.2 } },
];

export interface ReplyResult {
  content: Anthropic.Beta.BetaContentBlockParam[];
  text: string;
  stopReason: string | null;
  usage: Usage;
  model: string;
}

export function addUsage(a: Usage, b: Usage): Usage {
  return { input: a.input + b.input, output: a.output + b.output, cacheWrite: a.cacheWrite + b.cacheWrite, cacheRead: a.cacheRead + b.cacheRead, cost: a.cost + b.cost };
}

function usageOf(msg: Anthropic.Beta.BetaMessage, requestedModel: string): Usage {
  const u = msg.usage;
  const model = MODELS.find((m) => msg.model?.startsWith(m.id)) ?? MODELS.find((m) => m.id === requestedModel) ?? MODELS[0];
  const input = u.input_tokens ?? 0, output = u.output_tokens ?? 0;
  const cacheWrite = u.cache_creation_input_tokens ?? 0, cacheRead = u.cache_read_input_tokens ?? 0;
  const p = model.price;
  const cost = (input * p.in + output * p.out + cacheWrite * p.cw + cacheRead * p.cr) / 1e6;
  return { input, output, cacheWrite, cacheRead, cost };
}

/**
 * After a mid-output server-side fallback, model-internal blocks (thinking, tool_use)
 * before the last `fallback` block must not be echoed back; the fallback block itself
 * stays in place.
 */
function echoableContent(blocks: Anthropic.Beta.BetaContentBlock[]): Anthropic.Beta.BetaContentBlockParam[] {
  let lastFallback = -1;
  blocks.forEach((b, i) => { if (b.type === 'fallback') lastFallback = i; });
  const keep = blocks.filter((b, i) => {
    if (i >= lastFallback) return true;
    return b.type === 'text' || b.type === 'fallback';
  });
  return keep as unknown as Anthropic.Beta.BetaContentBlockParam[];
}

export function friendlyError(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) return 'The API key was rejected. Check it in Settings.';
  if (e instanceof Anthropic.PermissionDeniedError) return 'This API key is not allowed to use that model.';
  if (e instanceof Anthropic.NotFoundError) return 'Model not found. Pick another model in Settings.';
  if (e instanceof Anthropic.RateLimitError) return 'Rate limited. Wait a moment and retry.';
  if (e instanceof Anthropic.BadRequestError) return 'Request rejected: ' + e.message;
  if (e instanceof Anthropic.InternalServerError) return 'Anthropic server error (' + e.status + '). Retry in a moment.';
  if (e instanceof Anthropic.APIConnectionError) return 'Network error. Check the connection and retry.';
  if (e instanceof Anthropic.APIError) return `API error ${e.status ?? ''}: ${e.message}`;
  return String((e as Error)?.message ?? e);
}

export async function streamReply(opts: {
  settings: Settings;
  system: string;
  messages: StoredMessage[];
  signal: AbortSignal;
  onText: (fullText: string) => void;
}): Promise<ReplyResult> {
  const { settings, system, signal, onText } = opts;
  const messages = opts.messages.map((m) => ({ role: m.role, content: m.content })) as Anthropic.Beta.BetaMessageParam[];

  if (settings.apiKey.trim().toLowerCase() === 'demo') return demoReply(messages, signal, onText);

  const client = new Anthropic({ apiKey: settings.apiKey.trim(), dangerouslyAllowBrowser: true });
  const stream = client.beta.messages.stream(
    {
      model: settings.model,
      max_tokens: 64000,
      system: [{ type: 'text', text: system }],
      messages,
      thinking: { type: 'adaptive' },
      output_config: { effort: settings.effort },
      cache_control: { type: 'ephemeral' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    },
    { signal },
  );

  let text = '';
  stream.on('text', (delta) => {
    text += delta;
    onText(text);
  });
  const final = await stream.finalMessage();
  const fullText = final.content.filter((b) => b.type === 'text').map((b) => (b as Anthropic.Beta.BetaTextBlock).text).join('');
  return {
    content: echoableContent(final.content),
    text: fullText,
    stopReason: final.stop_reason,
    usage: usageOf(final, settings.model),
    model: final.model,
  };
}

// ---------- Demo mode (API key "demo"): canned replies to try the UI offline ----------
const DEMO_REPLIES = [
  `Let's find out what you already know about **derivatives**. I'll ask a few questions, one at a time.

Here is the graph of $f(x) = \\tfrac{1}{4}x^3 - x$:

\`\`\`plot
{"x": [-3, 3], "y": [-3, 3], "items": [
  {"type": "function", "fn": "x^3/4 - x", "label": "f(x) = ¼x³ − x"},
  {"type": "point", "at": [1, -0.75], "label": "P"}
]}
\`\`\`

Tap **To board**, and sketch the tangent line to the curve at $P$. Roughly what is its slope?`,
  `You drew a line through $P$. Before I tell you anything: how would you *compute* the slope exactly, using
$$f'(x) = \\lim_{h \\to 0} \\frac{f(x+h) - f(x)}{h}\\,?$$

\`\`\`skillmap
{"topic": "Derivatives", "target": 4, "skills": [
  {"name": "Slope of a secant line", "level": 3},
  {"name": "Limit definition", "level": 1, "focus": true},
  {"name": "Power rule", "level": 2},
  {"name": "Chain rule", "level": 0}
]}
\`\`\`

What do you get for $f'(1)$?`,
  `Here's a schematic for the next question:

\`\`\`svg
<svg viewBox="0 0 600 220" xmlns="http://www.w3.org/2000/svg">
  <rect width="600" height="220" fill="#fff"/>
  <line x1="60" y1="180" x2="540" y2="180" stroke="#1f2328" stroke-width="2"/>
  <line x1="120" y1="180" x2="420" y2="50" stroke="#1f6feb" stroke-width="3"/>
  <text x="430" y="50" font-size="18" fill="#1f6feb">secant</text>
  <circle cx="120" cy="180" r="6" fill="#d1242f"/><circle cx="420" cy="50" r="6" fill="#d1242f"/>
  <text x="100" y="205" font-size="16">x</text><text x="400" y="205" font-size="16">x + h</text>
</svg>
\`\`\`

As $h \\to 0$, what happens to the secant line?`,
];

async function demoReply(messages: Anthropic.Beta.BetaMessageParam[], signal: AbortSignal, onText: (t: string) => void): Promise<ReplyResult> {
  const n = messages.filter((m) => m.role === 'assistant').length;
  const reply = DEMO_REPLIES[n % DEMO_REPLIES.length];
  let text = '';
  for (let i = 0; i < reply.length; i += 6) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    text = reply.slice(0, i + 6);
    onText(text);
    await new Promise((r) => setTimeout(r, 12));
  }
  return {
    content: [{ type: 'text', text: reply }],
    text: reply, stopReason: 'end_turn', model: 'demo',
    usage: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 },
  };
}
