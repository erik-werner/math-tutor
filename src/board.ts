import { getStroke } from 'perfect-freehand';

export interface Stroke { pts: [number, number, number][]; color: string; size: number; pen: boolean }
export interface BoardImage { src: string; x: number; y: number; w: number; h: number }
interface State { strokes: Stroke[]; images: BoardImage[] }

export interface BoardExport { base64: string; mediaType: 'image/png'; dataUrl: string }

const MAX_EDGE = 1568;

// Outlines are computed once per stroke (in board coordinates) and reused for every redraw,
// so panning and zooming stay smooth.
const pathCache = new WeakMap<Stroke, Path2D>();
function strokePath(s: Stroke, cache = true): Path2D {
  const hit = cache ? pathCache.get(s) : undefined;
  if (hit) return hit;
  const outline = getStroke(s.pts, {
    size: s.size,
    thinning: s.pen ? 0.6 : 0.35,
    smoothing: 0.5,
    streamline: 0.35,
    simulatePressure: !s.pen,
    last: true,
  });
  const p = new Path2D();
  if (outline.length) {
    p.moveTo(outline[0][0], outline[0][1]);
    for (let i = 1; i < outline.length; i++) {
      const [x0, y0] = outline[i];
      const [x1, y1] = outline[(i + 1) % outline.length];
      p.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
    }
    p.closePath();
  }
  if (cache) pathCache.set(s, p);
  return p;
}

function pointInPolygon(x: number, y: number, poly: [number, number][]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const moved = (s: Stroke, dx: number, dy: number): Stroke =>
  ({ ...s, pts: s.pts.map(([x, y, p]) => [x + dx, y + dy, p] as [number, number, number]) });
const movedImg = (im: BoardImage, dx: number, dy: number): BoardImage => ({ ...im, x: im.x + dx, y: im.y + dy });

function boundsOf(strokes: Stroke[], images: BoardImage[]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of strokes) for (const [x, y] of s.pts) {
    x0 = Math.min(x0, x - s.size); y0 = Math.min(y0, y - s.size);
    x1 = Math.max(x1, x + s.size); y1 = Math.max(y1, y + s.size);
  }
  for (const im of images) {
    x0 = Math.min(x0, im.x); y0 = Math.min(y0, im.y);
    x1 = Math.max(x1, im.x + im.w); y1 = Math.max(y1, im.y + im.h);
  }
  return { x0, y0, x1, y1 };
}

// ---------- Clipboard shared by all boards (main board and scratch pad) ----------
interface Clip { strokes: Stroke[]; images: BoardImage[]; w: number; h: number }
let clipboard: Clip | null = null;
const clipListeners: (() => void)[] = [];
export const hasClip = () => clipboard !== null;
export function onClipChange(f: () => void) { clipListeners.push(f); }

function distToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export async function svgToPng(svg: string, scale = 2): Promise<{ src: string; w: number; h: number }> {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const el = doc.documentElement;
  if (el.nodeName.toLowerCase() !== 'svg') throw new Error('Not an SVG');
  let w = parseFloat(el.getAttribute('width') ?? '');
  let h = parseFloat(el.getAttribute('height') ?? '');
  const vb = (el.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number);
  if (!(w > 0 && h > 0)) {
    if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) { w = vb[2]; h = vb[3]; } else { w = 600; h = 400; }
  }
  el.setAttribute('width', String(w));
  el.setAttribute('height', String(h));
  if (!el.getAttribute('xmlns')) el.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  const xml = new XMLSerializer().serializeToString(el);
  const url = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml' }));
  try {
    const img = await loadImage(url);
    const c = document.createElement('canvas');
    c.width = Math.round(w * scale); c.height = Math.round(h * scale);
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return { src: c.toDataURL('image/png'), w, h };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Image failed to load'));
    img.src = src;
  });
}

interface View { x: number; y: number; s: number }
const MIN_ZOOM = 0.2, MAX_ZOOM = 5;
const DEFAULT_VIEW: View = { x: 0, y: 0, s: 1 };

type Action =
  | { kind: 'draw'; pointer: number; type: string; t0: number }
  | { kind: 'erase'; pointer: number; type: string; t0: number }
  | { kind: 'lasso'; pointer: number; type: string; t0: number; pts: [number, number][] }
  | { kind: 'move'; pointer: number; type: string; t0: number; x0: number; y0: number };

/**
 * A whiteboard with an infinite canvas. Strokes are stored in board coordinates; the view
 * (pan offset and zoom) maps them to the screen. Two fingers pan and zoom; the Pencil (or a
 * finger, when finger drawing is on) draws, erases, or selects with a lasso.
 */
export class Board {
  private canvas: HTMLCanvasElement;
  private live: HTMLCanvasElement;
  private bar: HTMLDivElement;
  private ctx: CanvasRenderingContext2D;
  private lctx: CanvasRenderingContext2D;
  private state: State = { strokes: [], images: [] };
  private undoStack: State[] = [];
  private redoStack: State[] = [];
  private imgCache = new Map<string, HTMLImageElement>();
  private current: Stroke | null = null;
  private action: Action | null = null;
  private erasedThisGesture = false;
  private dpr = 1;
  private view: View = { ...DEFAULT_VIEW };
  private touches = new Map<number, { x: number; y: number }>();
  private gesture: { wx: number; wy: number; d0: number; s0: number } | null = null;
  private gestureLock = false; // after a pinch, ignore the remaining finger until all are lifted
  private penDown = false;
  private sel: { strokes: Set<Stroke>; images: Set<BoardImage> } | null = null;
  private drag = { dx: 0, dy: 0 };
  private frame = 0;
  private _tool: 'pen' | 'eraser' | 'select' = 'pen';

  color = '#1f2328';
  size = 3.5;
  fingerDraws = true;
  version = 0;
  onChange: () => void = () => {};
  onViewChange: () => void = () => {};
  onPenDetected: () => void = () => {};
  onCopy: (cut: boolean) => void = () => {};

  constructor(private container: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.live = document.createElement('canvas');
    this.canvas.className = 'board-canvas';
    this.live.className = 'board-canvas live';
    this.bar = document.createElement('div');
    this.bar.className = 'sel-bar';
    this.bar.hidden = true;
    this.bar.innerHTML = '<button data-sel="copy">Copy</button><button data-sel="cut">Cut</button><button data-sel="delete">Delete</button>';
    this.bar.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).closest('button')?.dataset.sel;
      if (a === 'copy') this.copySelection();
      else if (a === 'cut') { this.copySelection(true); this.deleteSelection(); }
      else if (a === 'delete') this.deleteSelection();
    });
    container.append(this.canvas, this.live, this.bar);
    this.ctx = this.canvas.getContext('2d')!;
    this.lctx = this.live.getContext('2d')!;

    const ro = new ResizeObserver(() => this.resize());
    ro.observe(container);
    this.resize();

    const el = this.live;
    el.addEventListener('pointerdown', (e) => this.down(e));
    el.addEventListener('pointermove', (e) => this.move(e));
    el.addEventListener('pointerup', (e) => this.up(e));
    el.addEventListener('pointercancel', (e) => this.up(e, true));
    // Stops iOS Safari from scrolling, magnifying, or selecting text while drawing.
    const block = (e: TouchEvent) => { if (e.cancelable) e.preventDefault(); };
    el.addEventListener('touchstart', block, { passive: false });
    el.addEventListener('touchmove', block, { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    // Mouse wheel / trackpad: scroll pans, pinch (ctrl + wheel) zooms.
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) this.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.01));
      else { this.view.x -= e.deltaX; this.view.y -= e.deltaY; this.viewChanged(); }
    }, { passive: false });
  }

  get width() { return this.container.clientWidth; }
  get height() { return this.container.clientHeight; }
  get zoom() { return this.view.s; }

  get tool() { return this._tool; }
  set tool(t: 'pen' | 'eraser' | 'select') {
    this._tool = t;
    if (t !== 'select') this.clearSelection();
  }

  private resize() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    for (const c of [this.canvas, this.live]) {
      c.width = Math.max(1, Math.round(this.width * this.dpr));
      c.height = Math.max(1, Math.round(this.height * this.dpr));
    }
    this.redraw();
    this.drawLive();
  }

  // ----- view -----
  private toWorld(cx: number, cy: number): [number, number] {
    const r = this.live.getBoundingClientRect();
    return [(cx - r.left - this.view.x) / this.view.s, (cy - r.top - this.view.y) / this.view.s];
  }

  private pos(e: PointerEvent): [number, number, number] {
    const p = e.pointerType === 'pen' ? (e.pressure || 0.5) : 0.5;
    return [...this.toWorld(e.clientX, e.clientY), p];
  }

  private zoomAt(sx: number, sy: number, factor: number) {
    const v = this.view;
    const s = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.s * factor));
    const wx = (sx - v.x) / v.s, wy = (sy - v.y) / v.s;
    this.view = { s, x: sx - wx * s, y: sy - wy * s };
    this.viewChanged();
  }

  private viewChanged() {
    if (!this.frame) {
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        this.redraw();
        this.drawLive();
      });
    }
    this.updateGrid();
    this.onViewChange();
  }

  private updateGrid() {
    const { x, y, s } = this.view;
    let g = 28;
    while (g * s < 14) g *= 2;
    while (g * s > 56) g /= 2;
    this.container.style.backgroundSize = `${g * s}px ${g * s}px`;
    this.container.style.backgroundPosition = `${x}px ${y}px`;
  }

  /** Back to the normal view, or zoomed out to show everything if the drawing is larger. */
  resetView() {
    const W = this.width, H = this.height;
    this.view = { ...DEFAULT_VIEW };
    if (!this.isEmpty()) {
      const b = this.bounds();
      if (b.x0 < 0 || b.y0 < 0 || b.x1 > W || b.y1 > H) {
        const pad = 24, bw = b.x1 - b.x0, bh = b.y1 - b.y0;
        const s = Math.max(MIN_ZOOM, Math.min(1, (W - 2 * pad) / bw, (H - 2 * pad) / bh));
        this.view = { s, x: (W - bw * s) / 2 - b.x0 * s, y: (H - bh * s) / 2 - b.y0 * s };
      }
    }
    this.viewChanged();
  }

  private visibleRect() {
    const { x, y, s } = this.view;
    return { x: -x / s, y: -y / s, w: this.width / s, h: this.height / s };
  }

  // ----- undo -----
  private snapshot() {
    this.undoStack.push({ strokes: this.state.strokes, images: this.state.images });
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
  }

  private changed() {
    this.version++;
    this.onChange();
  }

  // ----- pointer input -----
  private down(e: PointerEvent) {
    if (e.pointerType === 'pen' && this.fingerDraws) {
      this.fingerDraws = false;
      this.onPenDetected();
    }
    e.preventDefault();
    if (e.pointerType === 'touch') {
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try { this.live.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      if (this.penDown) return; // palm while writing
      if (this.touches.size === 2 && !this.gestureLock && !this.gesture) {
        const a = this.action;
        if (a && a.type !== 'touch') return;
        if (a) {
          // A second finger soon after the first turns a just-started stroke into a pinch.
          if (Date.now() - a.t0 > 400) return;
          this.cancelAction();
        }
        this.startGesture();
        return;
      }
      if (this.touches.size > 1 || this.gestureLock || this.gesture || !this.fingerDraws) return;
    }
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (this.action) return;
    if (e.pointerType === 'pen') {
      this.penDown = true;
      if (this.gesture) { this.gesture = null; this.gestureLock = this.touches.size > 0; }
    }
    this.live.setPointerCapture(e.pointerId);
    this.begin(e);
  }

  private move(e: PointerEvent) {
    if (e.pointerType === 'touch' && this.touches.has(e.pointerId)) {
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.gesture) { this.updateGesture(); return; }
    }
    const a = this.action;
    if (!a || e.pointerId !== a.pointer) return;
    const events = (e as any).getCoalescedEvents?.() as PointerEvent[] | undefined;
    const list = events && events.length ? events : [e];
    if (a.kind === 'erase') {
      for (const ev of list) this.eraseAt(this.pos(ev));
    } else if (a.kind === 'draw' && this.current) {
      for (const ev of list) this.current.pts.push(this.pos(ev));
      this.drawLive();
    } else if (a.kind === 'lasso') {
      for (const ev of list) { const [x, y] = this.pos(ev); a.pts.push([x, y]); }
      this.drawLive();
    } else if (a.kind === 'move') {
      const [x, y] = this.pos(e);
      this.drag = { dx: x - a.x0, dy: y - a.y0 };
      this.viewChanged();
    }
  }

  private up(e: PointerEvent, cancelled = false) {
    if (e.pointerType === 'touch' && this.touches.delete(e.pointerId)) {
      if (this.gesture) { this.gesture = null; this.gestureLock = this.touches.size > 0; this.onViewChange(); }
      if (this.touches.size === 0) this.gestureLock = false;
    }
    if (e.pointerType === 'pen') this.penDown = false;
    const a = this.action;
    if (!a || e.pointerId !== a.pointer) return;
    if (cancelled && (a.kind === 'lasso' || a.kind === 'move')) { this.cancelAction(); return; }
    this.action = null;
    if (a.kind === 'erase') {
      if (this.erasedThisGesture) this.changed();
    } else if (a.kind === 'draw') {
      this.commitStroke();
    } else if (a.kind === 'lasso') {
      this.finishLasso(a.pts);
    } else if (a.kind === 'move') {
      this.finishMove();
    }
  }

  private begin(e: PointerEvent) {
    const p = this.pos(e);
    const base = { pointer: e.pointerId, type: e.pointerType, t0: Date.now() };
    if (this._tool === 'eraser' || (e.buttons & 32) !== 0) {
      this.action = { kind: 'erase', ...base };
      this.erasedThisGesture = false;
      this.eraseAt(p);
    } else if (this._tool === 'select') {
      const box = this.selectionBox();
      const pad = 12 / this.view.s;
      if (box && p[0] > box.x0 - pad && p[0] < box.x1 + pad && p[1] > box.y0 - pad && p[1] < box.y1 + pad) {
        this.action = { kind: 'move', ...base, x0: p[0], y0: p[1] };
        this.drag = { dx: 0, dy: 0 };
        this.bar.hidden = true;
      } else {
        this.clearSelection();
        this.action = { kind: 'lasso', ...base, pts: [[p[0], p[1]]] };
      }
    } else {
      this.action = { kind: 'draw', ...base };
      this.current = { pts: [p], color: this.color, size: this.size, pen: e.pointerType === 'pen' };
      this.drawLive();
    }
  }

  private cancelAction() {
    const a = this.action;
    this.action = null;
    this.current = null;
    if (a?.kind === 'erase' && this.erasedThisGesture) this.changed();
    if (a?.kind === 'move') { this.drag = { dx: 0, dy: 0 }; this.redraw(); }
    this.drawLive();
  }

  private startGesture() {
    const [a, b] = [...this.touches.values()];
    const [wx, wy] = this.toWorld((a.x + b.x) / 2, (a.y + b.y) / 2);
    this.gesture = { wx, wy, d0: Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)), s0: this.view.s };
  }

  private updateGesture() {
    const g = this.gesture!;
    const [a, b] = [...this.touches.values()];
    if (!b) return;
    const r = this.live.getBoundingClientRect();
    const mx = (a.x + b.x) / 2 - r.left, my = (a.y + b.y) / 2 - r.top;
    const s = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, g.s0 * Math.hypot(a.x - b.x, a.y - b.y) / g.d0));
    this.view = { s, x: mx - g.wx * s, y: my - g.wy * s };
    this.viewChanged();
  }

  // ----- drawing -----
  private commitStroke() {
    const s = this.current;
    this.current = null;
    this.drawLive();
    if (!s) return;
    if (s.pts.length === 1) s.pts.push([s.pts[0][0] + 0.1, s.pts[0][1] + 0.1, s.pts[0][2]]); // dot
    this.snapshot();
    this.state = { ...this.state, strokes: [...this.state.strokes, s] };
    this.applyView(this.ctx);
    this.paintStroke(this.ctx, s);
    this.changed();
  }

  private applyView(c: CanvasRenderingContext2D) {
    const { x, y, s } = this.view, d = this.dpr;
    c.setTransform(d * s, 0, 0, d * s, d * x, d * y);
  }

  private drawLive() {
    const c = this.lctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, this.live.width, this.live.height);
    this.applyView(c);
    const a = this.action;
    if (this.current) this.paintStroke(c, this.current);
    const px = 1 / this.view.s;
    if (a?.kind === 'lasso' && a.pts.length > 1) {
      c.beginPath();
      a.pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
      c.closePath();
      c.fillStyle = 'rgba(47,111,219,0.06)';
      c.fill();
      c.setLineDash([6 * px, 4 * px]);
      c.lineWidth = 1.5 * px;
      c.strokeStyle = '#2f6fdb';
      c.stroke();
      c.setLineDash([]);
    }
    const box = this.selectionBox();
    if (box) {
      const pad = 8 * px;
      const { dx, dy } = this.drag;
      c.setLineDash([6 * px, 4 * px]);
      c.lineWidth = 1.5 * px;
      c.strokeStyle = '#2f6fdb';
      c.fillStyle = 'rgba(47,111,219,0.05)';
      const rx = box.x0 - pad + dx, ry = box.y0 - pad + dy, rw = box.x1 - box.x0 + 2 * pad, rh = box.y1 - box.y0 + 2 * pad;
      c.fillRect(rx, ry, rw, rh);
      c.strokeRect(rx, ry, rw, rh);
      c.setLineDash([]);
      if (a?.kind !== 'move') this.placeBar(rx, ry, rw, rh);
    } else {
      this.bar.hidden = true;
    }
  }

  private placeBar(rx: number, ry: number, rw: number, rh: number) {
    const { x, y, s } = this.view;
    this.bar.hidden = false;
    const bw = this.bar.offsetWidth || 200, bh = this.bar.offsetHeight || 40;
    const left = Math.min(Math.max(6, x + (rx + rw / 2) * s - bw / 2), this.width - bw - 6);
    let top = y + ry * s - bh - 8;
    if (top < 6) top = y + (ry + rh) * s + 8;
    top = Math.min(Math.max(6, top), this.height - bh - 6);
    this.bar.style.transform = `translate(${left}px, ${top}px)`;
  }

  private eraseAt([x, y]: [number, number, number]) {
    const r = 12 / this.view.s;
    const keep = this.state.strokes.filter((s) => {
      const pts = s.pts;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[Math.min(i + 1, pts.length - 1)];
        if (distToSeg(x, y, a[0], a[1], b[0], b[1]) < r + s.size / 2) return false;
      }
      return true;
    });
    if (keep.length !== this.state.strokes.length) {
      if (!this.erasedThisGesture) this.snapshot();
      this.erasedThisGesture = true;
      this.state = { ...this.state, strokes: keep };
      this.redraw();
    }
  }

  private paintStroke(c: CanvasRenderingContext2D, s: Stroke) {
    c.fillStyle = s.color;
    // The stroke being drawn still grows, so its outline isn't cached.
    c.fill(strokePath(s, s !== this.current));
  }

  private img(src: string): HTMLImageElement | null {
    let im = this.imgCache.get(src);
    if (!im) {
      im = new Image();
      im.onload = () => this.redraw();
      im.src = src;
      this.imgCache.set(src, im);
    }
    return im.complete && im.naturalWidth ? im : null;
  }

  private paintAll(c: CanvasRenderingContext2D, withDrag = false) {
    const { dx, dy } = this.drag;
    const sel = withDrag && (dx || dy) ? this.sel : null;
    for (const im of this.state.images) {
      const el = this.img(im.src);
      if (!el) continue;
      const o = sel?.images.has(im);
      const x = im.x + (o ? dx : 0), y = im.y + (o ? dy : 0);
      c.drawImage(el, x, y, im.w, im.h);
      c.strokeStyle = '#d0d7de';
      c.lineWidth = 1 / this.view.s;
      c.strokeRect(x, y, im.w, im.h);
    }
    for (const s of this.state.strokes) {
      if (sel?.strokes.has(s)) {
        c.save(); c.translate(dx, dy); this.paintStroke(c, s); c.restore();
      } else {
        this.paintStroke(c, s);
      }
    }
  }

  redraw() {
    const c = this.ctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.applyView(c);
    this.paintAll(c, true);
  }

  // ----- selection, copy and paste -----
  private finishLasso(poly: [number, number][]) {
    const b = boundsOf([{ pts: poly.map(([x, y]) => [x, y, 0.5] as [number, number, number]), color: '', size: 0, pen: false }], []);
    if (poly.length < 3 || (b.x1 - b.x0) * this.view.s < 8 || (b.y1 - b.y0) * this.view.s < 8) { this.drawLive(); return; }
    const strokes = new Set(this.state.strokes.filter((s) => {
      const inside = s.pts.filter(([x, y]) => pointInPolygon(x, y, poly)).length;
      return inside >= s.pts.length / 2;
    }));
    const images = new Set(this.state.images.filter((im) => pointInPolygon(im.x + im.w / 2, im.y + im.h / 2, poly)));
    this.sel = strokes.size || images.size ? { strokes, images } : null;
    this.drawLive();
  }

  private finishMove() {
    const { dx, dy } = this.drag;
    this.drag = { dx: 0, dy: 0 };
    const sel = this.sel;
    if (sel && (dx || dy)) {
      const strokes = new Set<Stroke>(), images = new Set<BoardImage>();
      this.snapshot();
      this.state = {
        strokes: this.state.strokes.map((s) => { if (!sel.strokes.has(s)) return s; const m = moved(s, dx, dy); strokes.add(m); return m; }),
        images: this.state.images.map((im) => { if (!sel.images.has(im)) return im; const m = movedImg(im, dx, dy); images.add(m); return m; }),
      };
      this.sel = { strokes, images };
      this.redraw();
      this.changed();
    }
    this.drawLive();
  }

  private selectionBox() {
    if (!this.sel) return null;
    return boundsOf([...this.sel.strokes], [...this.sel.images]);
  }

  get hasSelection() { return this.sel !== null; }

  clearSelection() {
    if (!this.sel) return;
    this.sel = null;
    this.drawLive();
  }

  copySelection(cut = false) {
    const box = this.selectionBox();
    if (!this.sel || !box) return;
    clipboard = {
      strokes: [...this.sel.strokes].map((s) => moved(s, -box.x0, -box.y0)),
      images: [...this.sel.images].map((im) => movedImg(im, -box.x0, -box.y0)),
      w: box.x1 - box.x0, h: box.y1 - box.y0,
    };
    clipListeners.forEach((f) => f());
    this.onCopy(cut);
  }

  deleteSelection() {
    const sel = this.sel;
    if (!sel) return;
    this.snapshot();
    this.state = {
      strokes: this.state.strokes.filter((s) => !sel.strokes.has(s)),
      images: this.state.images.filter((im) => !sel.images.has(im)),
    };
    this.sel = null;
    this.redraw();
    this.drawLive();
    this.changed();
  }

  /** Pastes the clipboard in the middle of the visible area and selects it, so it can be moved. */
  paste(): boolean {
    const clip = clipboard;
    if (!clip) return false;
    const v = this.visibleRect();
    const dx = v.x + (v.w - clip.w) / 2, dy = v.y + (v.h - clip.h) / 2;
    const strokes = clip.strokes.map((s) => moved(s, dx, dy));
    const images = clip.images.map((im) => movedImg(im, dx, dy));
    this.snapshot();
    this.state = { strokes: [...this.state.strokes, ...strokes], images: [...this.state.images, ...images] };
    this._tool = 'select';
    this.sel = { strokes: new Set(strokes), images: new Set(images) };
    this.redraw();
    this.drawLive();
    this.changed();
    return true;
  }

  // ----- history and content -----
  undo() {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(this.state);
    this.state = prev;
    this.sel = null;
    this.redraw();
    this.drawLive();
    this.changed();
  }
  redo() {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(this.state);
    this.state = next;
    this.sel = null;
    this.redraw();
    this.drawLive();
    this.changed();
  }
  clear() {
    if (this.isEmpty()) return;
    this.snapshot();
    this.state = { strokes: [], images: [] };
    this.sel = null;
    this.view = { ...DEFAULT_VIEW };
    this.updateGrid();
    this.redraw();
    this.drawLive();
    this.changed();
    this.onViewChange();
  }
  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  isEmpty() { return this.state.strokes.length === 0 && this.state.images.length === 0; }
  hasInk() { return this.state.strokes.length > 0; }

  private bounds() { return boundsOf(this.state.strokes, this.state.images); }

  /** Places an image (PNG data URL with logical size) in the visible area, below existing content when it fits. */
  async addImage(src: string, w: number, h: number) {
    const v = this.visibleRect();
    const m = 20 / this.view.s;
    const maxW = Math.max(120, v.w - 2 * m), maxH = Math.max(120, v.h - 2 * m);
    const scale = Math.min(1, maxW / w, maxH / h);
    w *= scale; h *= scale;
    let y = v.y + m;
    if (!this.isEmpty()) {
      const b = this.bounds();
      if (b.y1 > y && b.y1 + m + h <= v.y + v.h) y = b.y1 + m;
    }
    await loadImage(src).catch(() => null);
    this.snapshot();
    this.state = { ...this.state, images: [...this.state.images, { src, x: v.x + m, y, w, h }] };
    this.redraw();
    this.changed();
  }

  /** Crops to the content, flattens onto white, and returns a PNG for Claude. */
  async export(): Promise<BoardExport | null> {
    if (this.isEmpty()) return null;
    for (const im of this.state.images) await loadImage(im.src).catch(() => null);
    const b = this.bounds();
    const pad = 24;
    let x0 = b.x0 - pad, y0 = b.y0 - pad, x1 = b.x1 + pad, y1 = b.y1 + pad;
    if (x1 - x0 < 240) { const c = (x0 + x1) / 2; x0 = c - 120; x1 = c + 120; }
    if (y1 - y0 < 160) { const c = (y0 + y1) / 2; y0 = c - 80; y1 = c + 80; }
    const w = x1 - x0, h = y1 - y0;
    const scale = Math.min(2, MAX_EDGE / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.round(w * scale); c.height = Math.round(h * scale);
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.setTransform(scale, 0, 0, scale, -x0 * scale, -y0 * scale);
    for (const im of this.state.images) {
      const el = this.img(im.src);
      if (el) ctx.drawImage(el, im.x, im.y, im.w, im.h);
    }
    for (const s of this.state.strokes) this.paintStroke(ctx, s);
    const dataUrl = c.toDataURL('image/png');
    return { base64: dataUrl.slice(dataUrl.indexOf(',') + 1), mediaType: 'image/png', dataUrl };
  }

  toJSON(): State & { view: View } { return { ...this.state, view: this.view }; }

  load(data: unknown) {
    const d = data as (Partial<State> & { view?: View }) | undefined;
    this.state = {
      strokes: Array.isArray(d?.strokes) ? d!.strokes : [],
      images: Array.isArray(d?.images) ? d!.images : [],
    };
    const v = d?.view;
    this.view = v && [v.x, v.y, v.s].every(Number.isFinite) && v.s > 0 ? { ...v } : { ...DEFAULT_VIEW };
    this.undoStack = [];
    this.redoStack = [];
    this.sel = null;
    this.action = null;
    this.current = null;
    this.version++;
    this.updateGrid();
    this.redraw();
    this.drawLive();
  }
}
