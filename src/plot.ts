// Renders the ```plot JSON spec to an SVG string, using a small safe expression parser.

// ---------- Expression parser ----------
type Fn = (env: Record<string, number>) => number;
type Tok = { t: 'num' | 'id' | 'op'; v: string };

const FUNCS: Record<string, (...a: number[]) => number> = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan,
  sec: (x) => 1 / Math.cos(x), csc: (x) => 1 / Math.sin(x), cot: (x) => 1 / Math.tan(x),
  asin: Math.asin, acos: Math.acos, atan: Math.atan, atan2: Math.atan2,
  arcsin: Math.asin, arccos: Math.acos, arctan: Math.atan,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
  exp: Math.exp, ln: Math.log, log: (x, b) => (b === undefined ? Math.log10(x) : Math.log(x) / Math.log(b)),
  log2: Math.log2, log10: Math.log10, sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs,
  floor: Math.floor, ceil: Math.ceil, round: Math.round, sign: Math.sign,
  min: Math.min, max: Math.max, pow: Math.pow, mod: (a, b) => ((a % b) + b) % b,
};
const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E, tau: 2 * Math.PI };

function tokenize(src: string): Tok[] {
  const s = src
    .replace(/π/g, ' pi ')
    .replace(/[·×⋅]/g, '*')
    .replace(/[−–]/g, '-')
    .replace(/÷/g, '/')
    .replace(/\*\*/g, '^')
    .replace(/²/g, '^2')
    .replace(/³/g, '^3')
    .replace(/√/g, ' sqrt ');
  const out: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    const num = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(s.slice(i));
    if (num) { out.push({ t: 'num', v: num[0] }); i += num[0].length; continue; }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i));
    if (id) { out.push({ t: 'id', v: id[0] }); i += id[0].length; continue; }
    if ('+-*/^(),|'.includes(c)) { out.push({ t: 'op', v: c }); i++; continue; }
    throw new Error(`Unexpected character '${c}' in "${src}"`);
  }
  return out;
}

export function compile(src: string, vars: string[], params: Record<string, number> = {}): (...v: number[]) => number {
  const toks = tokenize(String(src));
  let p = 0;
  const peek = () => toks[p];
  const isOp = (v: string) => peek()?.t === 'op' && peek().v === v;
  const expect = (v: string) => {
    if (!isOp(v)) throw new Error(`Expected '${v}' in "${src}"`);
    p++;
  };

  function expr(): Fn {
    let left = term();
    while (isOp('+') || isOp('-')) {
      const op = toks[p++].v;
      const a = left, b = term();
      left = op === '+' ? (e) => a(e) + b(e) : (e) => a(e) - b(e);
    }
    return left;
  }
  function startsFactor(): boolean {
    const k = peek();
    return !!k && (k.t === 'num' || k.t === 'id' || (k.t === 'op' && k.v === '('));
  }
  function term(): Fn {
    let left = unary();
    for (;;) {
      if (isOp('*') || isOp('/')) {
        const op = toks[p++].v;
        const a = left, b = unary();
        left = op === '*' ? (e) => a(e) * b(e) : (e) => a(e) / b(e);
      } else if (startsFactor()) {
        const a = left, b = power(); // implicit multiplication: 2x, 3(x+1), x sin(x)
        left = (e) => a(e) * b(e);
      } else break;
    }
    return left;
  }
  function unary(): Fn {
    if (isOp('-')) { p++; const a = unary(); return (e) => -a(e); }
    if (isOp('+')) { p++; return unary(); }
    return power();
  }
  function power(): Fn {
    const base = primary();
    if (isOp('^')) {
      p++;
      const ex = unary(); // right-associative, allows 2^-x
      return (e) => Math.pow(base(e), ex(e));
    }
    return base;
  }
  function primary(): Fn {
    const k = peek();
    if (!k) throw new Error(`Unexpected end of "${src}"`);
    if (k.t === 'num') { p++; const v = parseFloat(k.v); return () => v; }
    if (k.t === 'op' && k.v === '(') { p++; const a = expr(); expect(')'); return a; }
    if (k.t === 'op' && k.v === '|') { p++; const a = expr(); expect('|'); return (e) => Math.abs(a(e)); }
    if (k.t === 'id') {
      p++;
      const name = k.v;
      if (vars.includes(name)) return (e) => e[name];
      if (name in params) { const v = Number(params[name]); return () => v; }
      if (name in FUNCS) {
        const f = FUNCS[name];
        if (isOp('(')) {
          p++;
          const args: Fn[] = [expr()];
          while (isOp(',')) { p++; args.push(expr()); }
          expect(')');
          return (e) => f(...args.map((a) => a(e)));
        }
        // sin x, sin 2x  (function applied to the following power term)
        const arg = power();
        return (e) => f(arg(e));
      }
      if (name in CONSTS) { const v = CONSTS[name]; return () => v; }
      throw new Error(`Unknown name '${name}' in "${src}"`);
    }
    throw new Error(`Unexpected '${k.v}' in "${src}"`);
  }

  const fn = expr();
  if (p < toks.length) throw new Error(`Unexpected '${toks[p].v}' in "${src}"`);
  return (...v: number[]) => {
    const env: Record<string, number> = {};
    vars.forEach((name, i) => (env[name] = v[i]));
    return fn(env);
  };
}

// ---------- Plot rendering ----------
export const COLORS: Record<string, string> = {
  black: '#1f2328', gray: '#6e7781', grey: '#6e7781', blue: '#1f6feb', red: '#d1242f',
  green: '#1a7f37', orange: '#d4760a', purple: '#8250df', teal: '#0f8a8a',
};
const DEFAULT_CYCLE = ['blue', 'red', 'green', 'orange', 'purple', 'teal'];

type Pt = [number, number];
interface Item { type: string; [k: string]: any }
interface Spec {
  x?: Pt; y?: Pt; aspect?: string; grid?: boolean; axes?: boolean; title?: string;
  params?: Record<string, number>; items?: Item[]; width?: number; height?: number;
}

const esc = (s: unknown) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

function niceStep(range: number, target = 8): number {
  const raw = range / target;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
}
const fmt = (v: number) => {
  const r = Math.round(v * 1e6) / 1e6;
  return Math.abs(r) < 1e-9 ? '0' : String(r).replace('-', '−');
};

export function renderPlot(specIn: Spec | string): string {
  const spec: Spec = typeof specIn === 'string' ? JSON.parse(specIn) : specIn;
  const params = spec.params ?? {};
  let [x0, x1] = (spec.x ?? [-5, 5]).map(Number) as Pt;
  let [y0, y1] = (spec.y ?? [-5, 5]).map(Number) as Pt;
  if (!(x1 > x0) || !(y1 > y0)) throw new Error('plot: x and y ranges must be [min, max] with min < max');

  const W = Math.min(Math.max(Number(spec.width) || 600, 200), 1000);
  const pad = { l: 12, r: 12, t: spec.title ? 34 : 12, b: 12 };
  const iw = W - pad.l - pad.r;
  let ih: number;
  if (spec.aspect === 'equal') {
    ih = (iw * (y1 - y0)) / (x1 - x0);
    const clamped = Math.min(Math.max(ih, 200), 700);
    if (clamped !== ih) {
      // Keep the aspect ratio equal by widening the y-range around its center.
      const cy = (y0 + y1) / 2, half = ((x1 - x0) * clamped) / iw / 2;
      y0 = cy - half; y1 = cy + half; ih = clamped;
    }
  } else {
    ih = Math.min(Math.max(Number(spec.height) || 400, 150), 800) - pad.t - pad.b;
  }
  const H = ih + pad.t + pad.b;
  const sx = (x: number) => pad.l + ((x - x0) / (x1 - x0)) * iw;
  const sy = (y: number) => pad.t + ((y1 - y) / (y1 - y0)) * ih;
  const ux = iw / (x1 - x0), uy = ih / (y1 - y0);

  const parts: string[] = [];
  const clipId = 'c' + Math.random().toString(36).slice(2, 8);
  parts.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/>`);
  parts.push(`<defs><clipPath id="${clipId}"><rect x="${pad.l}" y="${pad.t}" width="${iw}" height="${ih}"/></clipPath></defs>`);

  // Grid and axes
  const stepX = niceStep(x1 - x0), stepY = niceStep(y1 - y0, Math.max(4, Math.round(8 * (ih / iw))));
  if (spec.grid !== false) {
    const g: string[] = [];
    for (let v = Math.ceil(x0 / stepX) * stepX; v <= x1 + 1e-9; v += stepX) g.push(`M${sx(v).toFixed(1)} ${pad.t}V${pad.t + ih}`);
    for (let v = Math.ceil(y0 / stepY) * stepY; v <= y1 + 1e-9; v += stepY) g.push(`M${pad.l} ${sy(v).toFixed(1)}H${pad.l + iw}`);
    parts.push(`<path d="${g.join('')}" stroke="#d8dee4" stroke-width="1" fill="none"/>`);
  }
  parts.push(`<rect x="${pad.l}" y="${pad.t}" width="${iw}" height="${ih}" fill="none" stroke="#d0d7de"/>`);
  if (spec.axes !== false) {
    const ax = Math.min(Math.max(0, y0), y1), ay = Math.min(Math.max(0, x0), x1);
    const axY = sy(ax), axX = sx(ay);
    parts.push(`<path d="M${pad.l} ${axY}H${pad.l + iw}M${axX} ${pad.t}V${pad.t + ih}" stroke="#57606a" stroke-width="1.3"/>`);
    const labels: string[] = [];
    const lyBelow = axY + 16 > pad.t + ih ? axY - 6 : axY + 16;
    for (let v = Math.ceil(x0 / stepX) * stepX; v <= x1 + 1e-9; v += stepX) {
      if (Math.abs(v) < stepX / 2 && x0 < 0 && x1 > 0) continue;
      const px = sx(v);
      if (px < pad.l + 8 || px > pad.l + iw - 8) continue;
      labels.push(`<text x="${px}" y="${lyBelow}" text-anchor="middle">${fmt(v)}</text>`);
    }
    const leftSide = axX - 6 < pad.l + 20;
    for (let v = Math.ceil(y0 / stepY) * stepY; v <= y1 + 1e-9; v += stepY) {
      if (Math.abs(v) < stepY / 2 && y0 < 0 && y1 > 0) continue;
      const py = sy(v);
      if (py < pad.t + 8 || py > pad.t + ih - 6) continue;
      labels.push(`<text x="${leftSide ? axX + 6 : axX - 6}" y="${py + 4}" text-anchor="${leftSide ? 'start' : 'end'}">${fmt(v)}</text>`);
    }
    parts.push(`<g font-size="12" fill="#57606a" font-family="-apple-system, system-ui, sans-serif">${labels.join('')}</g>`);
  }

  const items = spec.items ?? [];
  let cycle = 0;
  const colorOf = (it: Item, fallback?: string) => {
    const name = it.color ?? fallback ?? DEFAULT_CYCLE[cycle++ % DEFAULT_CYCLE.length];
    return COLORS[name] ?? (/^#[0-9a-fA-F]{3,8}$/.test(name) ? name : COLORS.blue);
  };
  const dash = (it: Item) => (it.dash ? ' stroke-dasharray="7 5"' : '');
  const legend: { label: string; color: string; dash: boolean }[] = [];
  const drawn: string[] = [];
  const overlays: string[] = [];
  const label = (x: number, y: number, text: string, color: string, dx = 8, dy = -8) =>
    overlays.push(`<text x="${x + dx}" y="${y + dy}" fill="${color}" font-size="15" font-weight="600" paint-order="stroke" stroke="#fff" stroke-width="4" stroke-linejoin="round">${esc(text)}</text>`);

  const curvePath = (pts: (Pt | null)[]) => {
    // Breaks the path at undefined values and at jumps (asymptotes).
    let d = '', pen = false;
    let prev: Pt | null = null;
    const span = y1 - y0;
    for (const q of pts) {
      if (!q || !isFinite(q[0]) || !isFinite(q[1]) || Math.abs(q[1] - (y0 + y1) / 2) > span * 50) { pen = false; prev = null; continue; }
      if (prev && Math.abs(q[1] - prev[1]) > span * 3 && (Math.sign(q[1] - y0) !== Math.sign(prev[1] - y0) || Math.sign(q[1] - y1) !== Math.sign(prev[1] - y1))) pen = false;
      d += (pen ? 'L' : 'M') + sx(q[0]).toFixed(2) + ' ' + sy(q[1]).toFixed(2);
      pen = true; prev = q;
    }
    return d;
  };

  for (const it of items) {
    const t = it.type;
    if (t === 'function') {
      const f = compile(it.fn, ['x'], params);
      const c = colorOf(it);
      const [a, b] = (it.domain ?? [x0, x1]).map(Number);
      const lo = Math.max(a, x0), hi = Math.min(b, x1);
      const N = 800, pts: (Pt | null)[] = [];
      for (let i = 0; i <= N; i++) { const x = lo + ((hi - lo) * i) / N; pts.push([x, f(x)]); }
      drawn.push(`<path d="${curvePath(pts)}" stroke="${c}" stroke-width="2.4" fill="none" stroke-linejoin="round"${dash(it)}/>`);
      if (it.label) legend.push({ label: it.label, color: c, dash: !!it.dash });
    } else if (t === 'parametric') {
      const fx = compile(it.x, ['t'], params), fy = compile(it.y, ['t'], params);
      const c = colorOf(it);
      const [a, b] = (it.t ?? [0, 2 * Math.PI]).map(Number);
      const N = 800, pts: (Pt | null)[] = [];
      for (let i = 0; i <= N; i++) { const tt = a + ((b - a) * i) / N; pts.push([fx(tt), fy(tt)]); }
      drawn.push(`<path d="${curvePath(pts)}" stroke="${c}" stroke-width="2.4" fill="none"${dash(it)}/>`);
      if (it.label) legend.push({ label: it.label, color: c, dash: !!it.dash });
    } else if (t === 'area') {
      const f = compile(it.fn, ['x'], params), g = compile(it.fn2 ?? '0', ['x'], params);
      const c = colorOf(it, 'orange');
      const a = Number(it.from ?? x0), b = Number(it.to ?? x1);
      const N = 300, top: string[] = [], bot: string[] = [];
      for (let i = 0; i <= N; i++) {
        const x = a + ((b - a) * i) / N;
        top.push(`${sx(x).toFixed(2)} ${sy(f(x)).toFixed(2)}`);
        bot.push(`${sx(x).toFixed(2)} ${sy(g(x)).toFixed(2)}`);
      }
      drawn.unshift(`<path d="M${top.join('L')}L${bot.reverse().join('L')}Z" fill="${c}" fill-opacity="0.25" stroke="none"/>`);
      if (it.label) legend.push({ label: it.label, color: c, dash: false });
    } else if (t === 'point') {
      const c = colorOf(it, 'black');
      const [px, py] = it.at.map(Number);
      overlays.push(`<circle cx="${sx(px)}" cy="${sy(py)}" r="${it.open ? 4.5 : 5}" fill="${it.open ? '#fff' : c}" stroke="${c}" stroke-width="2"/>`);
      if (it.label) label(sx(px), sy(py), it.label, c);
    } else if (t === 'segment' || t === 'arrow' || t === 'vector') {
      const c = colorOf(it, 'black');
      const [ax, ay] = it.from.map(Number), [bx, by] = it.to.map(Number);
      const X1 = sx(ax), Y1 = sy(ay), X2 = sx(bx), Y2 = sy(by);
      if (t === 'segment') {
        drawn.push(`<path d="M${X1} ${Y1}L${X2} ${Y2}" stroke="${c}" stroke-width="2.4"${dash(it)}/>`);
      } else {
        const ang = Math.atan2(Y2 - Y1, X2 - X1), L = 13, wA = 0.42;
        const hx = X2 - L * Math.cos(ang) * 0.8, hy = Y2 - L * Math.sin(ang) * 0.8;
        drawn.push(`<path d="M${X1} ${Y1}L${hx} ${hy}" stroke="${c}" stroke-width="2.4"${dash(it)}/>`);
        drawn.push(`<path d="M${X2} ${Y2}L${X2 - L * Math.cos(ang - wA)} ${Y2 - L * Math.sin(ang - wA)}L${X2 - L * Math.cos(ang + wA)} ${Y2 - L * Math.sin(ang + wA)}Z" fill="${c}"/>`);
      }
      if (it.label) label((X1 + X2) / 2, (Y1 + Y2) / 2, it.label, c);
    } else if (t === 'line') {
      const c = colorOf(it, 'gray');
      const [[ax, ay], [bx, by]] = it.through.map((q: number[]) => q.map(Number));
      const dx = bx - ax, dy = by - ay, big = 1e3 * Math.max(x1 - x0, y1 - y0) / Math.hypot(dx, dy || 1e-12);
      drawn.push(`<path d="M${sx(ax - dx * big)} ${sy(ay - dy * big)}L${sx(ax + dx * big)} ${sy(ay + dy * big)}" stroke="${c}" stroke-width="2"${dash(it)}/>`);
      if (it.label) legend.push({ label: it.label, color: c, dash: !!it.dash });
    } else if (t === 'polygon') {
      const c = colorOf(it, 'purple');
      const pts = it.points.map((q: number[]) => `${sx(Number(q[0]))} ${sy(Number(q[1]))}`).join('L');
      drawn.push(`<path d="M${pts}Z" fill="${c}" fill-opacity="${it.fill === false ? 0 : 0.15}" stroke="${c}" stroke-width="2.2"${dash(it)}/>`);
      if (it.label) legend.push({ label: it.label, color: c, dash: !!it.dash });
    } else if (t === 'circle') {
      const c = colorOf(it, 'blue');
      const [cx, cy] = it.center.map(Number), r = Number(it.r);
      drawn.push(`<ellipse cx="${sx(cx)}" cy="${sy(cy)}" rx="${r * ux}" ry="${r * uy}" fill="${it.fill ? c : 'none'}" fill-opacity="0.15" stroke="${c}" stroke-width="2.2"${dash(it)}/>`);
      if (it.label) legend.push({ label: it.label, color: c, dash: !!it.dash });
    } else if (t === 'text') {
      const c = colorOf(it, 'black');
      const [tx, ty] = it.at.map(Number);
      overlays.push(`<text x="${sx(tx)}" y="${sy(ty)}" fill="${c}" font-size="${Number(it.size) || 15}" text-anchor="${it.anchor === 'middle' || it.anchor === 'end' ? it.anchor : 'start'}" paint-order="stroke" stroke="#fff" stroke-width="4" stroke-linejoin="round">${esc(it.text)}</text>`);
    } else {
      throw new Error(`plot: unknown item type "${t}"`);
    }
  }

  parts.push(`<g clip-path="url(#${clipId})">${drawn.join('')}</g>`);
  parts.push(`<g font-family="-apple-system, system-ui, sans-serif">${overlays.join('')}</g>`);

  if (legend.length) {
    const lh = 22, lw = Math.min(iw - 8, 36 + Math.max(...legend.map((l) => l.label.length)) * 8.2);
    const lx = pad.l + 8, ly = pad.t + 8;
    const rows = legend.map((l, i) =>
      `<path d="M${lx + 8} ${ly + 13 + i * lh}h22" stroke="${l.color}" stroke-width="3"${l.dash ? ' stroke-dasharray="6 4"' : ''}/>` +
      `<text x="${lx + 36}" y="${ly + 18 + i * lh}" fill="#1f2328">${esc(l.label)}</text>`);
    parts.push(`<g font-size="14" font-family="-apple-system, system-ui, sans-serif"><rect x="${lx}" y="${ly}" width="${lw}" height="${legend.length * lh + 6}" rx="6" fill="#fff" fill-opacity="0.9" stroke="#d0d7de"/>${rows.join('')}</g>`);
  }
  if (spec.title) parts.push(`<text x="${W / 2}" y="22" text-anchor="middle" font-size="16" font-weight="600" fill="#1f2328" font-family="-apple-system, system-ui, sans-serif">${esc(spec.title)}</text>`);

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H.toFixed(0)}" width="${W}" height="${H.toFixed(0)}">${parts.join('')}</svg>`;
}
