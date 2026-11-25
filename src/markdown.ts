import { Marked, type Tokens } from 'marked';
import katex from 'katex';
import DOMPurify from 'dompurify';
import { renderPlot } from './plot';

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

function tex(src: string, display: boolean): string {
  try {
    return katex.renderToString(src, { displayMode: display, throwOnError: false, strict: 'ignore', trust: false, output: 'htmlAndMathml' });
  } catch {
    return `<code>${esc(src)}</code>`;
  }
}

export interface SkillMap {
  topic?: string;
  target?: number;
  skills: { name: string; level: number; note?: string; focus?: boolean }[];
}

export function renderSkillMap(m: SkillMap): string {
  const skills = Array.isArray(m.skills) ? m.skills : [];
  const total = skills.reduce((s, k) => s + Math.max(0, Math.min(5, Number(k.level) || 0)), 0);
  const pct = skills.length ? Math.round((100 * total) / (5 * skills.length)) : 0;
  const target = Number(m.target) || 4;
  const rows = skills.map((k) => {
    const lvl = Math.max(0, Math.min(5, Math.round(Number(k.level) || 0)));
    const segs = Array.from({ length: 5 }, (_, i) =>
      `<span class="sk-seg${i < lvl ? ' on' : ''}${i === target - 1 ? ' target' : ''}"></span>`).join('');
    return `<div class="sk-row${k.focus ? ' focus' : ''}${lvl >= target ? ' done' : ''}">
      <div class="sk-name">${esc(String(k.name ?? ''))}${k.focus ? ' <span class="sk-badge">focus</span>' : ''}${k.note ? `<div class="sk-note">${esc(String(k.note))}</div>` : ''}</div>
      <div class="sk-bar">${segs}</div><div class="sk-lvl">${lvl}/5</div></div>`;
  }).join('');
  return `<div class="skillmap"><div class="sk-head"><span class="sk-topic">${esc(String(m.topic ?? 'Progress'))}</span>
    <span class="sk-overall"><span class="sk-meter"><span style="width:${pct}%"></span></span>${pct}%</span></div>${rows}</div>`;
}

function figureCard(svg: string, kind: string): string {
  return `<figure class="fig" data-kind="${kind}"><div class="fig-body">${svg}</div>
    <button class="fig-toboard" type="button" data-action="fig-to-board">✎ To board</button></figure>`;
}

function sanitizeSvg(src: string): string {
  const clean = DOMPurify.sanitize(src, { USE_PROFILES: { svg: true, svgFilters: true } });
  if (!/<svg[\s>]/i.test(clean)) throw new Error('no <svg> element');
  return clean;
}

function makeMarked(streaming: boolean) {
  const m = new Marked({ gfm: true, breaks: false });
  m.use({
    extensions: [
      {
        name: 'blockMath',
        level: 'block',
        start(src: string) {
          const i = src.search(/\$\$|\\\[/);
          return i < 0 ? undefined : i;
        },
        tokenizer(src: string) {
          const mm = /^ {0,3}\$\$([\s\S]+?)\$\$[ \t]*(?:\n|$)/.exec(src) ?? /^ {0,3}\\\[([\s\S]+?)\\\][ \t]*(?:\n|$)/.exec(src);
          if (mm) return { type: 'blockMath', raw: mm[0], text: mm[1].trim() };
          return undefined;
        },
        renderer(token: Tokens.Generic) {
          return `<div class="math-display">${tex(token.text, true)}</div>`;
        },
      },
      {
        name: 'inlineMath',
        level: 'inline',
        start(src: string) {
          const i = src.search(/\$|\\\(|\\\[/);
          return i < 0 ? undefined : i;
        },
        tokenizer(src: string) {
          let mm = /^\$\$([\s\S]+?)\$\$/.exec(src);
          if (mm) return { type: 'inlineMath', raw: mm[0], text: mm[1], display: true };
          mm = /^\\\[([\s\S]+?)\\\]/.exec(src);
          if (mm) return { type: 'inlineMath', raw: mm[0], text: mm[1], display: true };
          mm = /^\\\(([\s\S]+?)\\\)/.exec(src);
          if (mm) return { type: 'inlineMath', raw: mm[0], text: mm[1], display: false };
          mm = /^\$(?=\S)((?:\\.|[^\\$\n])*?[^\s\\$]|\\.)\$(?!\d)/.exec(src);
          if (mm) return { type: 'inlineMath', raw: mm[0], text: mm[1], display: false };
          return undefined;
        },
        renderer(token: Tokens.Generic) {
          return token.display ? `<span class="math-display">${tex(token.text, true)}</span>` : tex(token.text, false);
        },
      },
    ],
    renderer: {
      code(token: Tokens.Code) {
        const lang = (token.lang ?? '').trim().toLowerCase();
        const body = token.text;
        if (lang === 'plot' || lang === 'svg' || lang === 'skillmap') {
          try {
            if (lang === 'plot') return figureCard(renderPlot(body), 'plot');
            if (lang === 'svg') return figureCard(sanitizeSvg(body), 'svg');
            return renderSkillMap(JSON.parse(body));
          } catch (e) {
            if (streaming) return `<div class="fig-pending">${lang === 'skillmap' ? 'Updating progress…' : 'Drawing figure…'}</div>`;
            return `<div class="fig-error">Could not render ${lang}: ${esc(String((e as Error).message))}<pre><code>${esc(body)}</code></pre></div>`;
          }
        }
        return `<pre><code>${esc(body)}</code></pre>`;
      },
    },
  });
  return m;
}

const finalMd = makeMarked(false);
const streamMd = makeMarked(true);

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

export function renderMarkdown(src: string, streaming = false): string {
  const html = (streaming ? streamMd : finalMd).parse(src, { async: false }) as string;
  return DOMPurify.sanitize(html, { ADD_ATTR: ['data-action', 'data-kind', 'target'] });
}

export function extractLastSkillMap(src: string): SkillMap | null {
  const re = /```skillmap\s*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null, last: SkillMap | null = null;
  while ((m = re.exec(src))) {
    try { last = JSON.parse(m[1]); } catch { /* ignore */ }
  }
  return last;
}
