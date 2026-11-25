import { getStroke } from 'perfect-freehand';

export interface Stroke { pts: [number, number, number][]; color: string; size: number; pen: boolean }
export interface BoardImage { src: string; x: number; y: number; w: number; h: number }
interface State { strokes: Stroke[]; images: BoardImage[] }

export interface BoardExport { base64: string; mediaType: 'image/png'; dataUrl: string }

const MAX_EDGE = 1568;

function strokePath(s: Stroke): Path2D {
  const outline = getStroke(s.pts, {
    size: s.size,
    thinning: s.pen ? 0.6 : 0.35,
    smoothing: 0.5,
    streamline: 0.35,
    simulatePressure: !s.pen,
    last: true,
  });
  const p = new Path2D();
  if (!outline.length) return p;
  p.moveTo(outline[0][0], outline[0][1]);
  for (let i = 1; i < outline.length; i++) {
    const [x0, y0] = outline[i];
    const [x1, y1] = outline[(i + 1) % outline.length];
    p.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
  }
  p.closePath();
  return p;
}

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

export class Board {
  private canvas: HTMLCanvasElement;
  private live: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private lctx: CanvasRenderingContext2D;
  private state: State = { strokes: [], images: [] };
  private undoStack: State[] = [];
  private redoStack: State[] = [];
  private imgCache = new Map<string, HTMLImageElement>();
  private current: Stroke | null = null;
  private activePointer: number | null = null;
  private erasing = false;
  private erasedThisGesture = false;
  private dpr = 1;

  tool: 'pen' | 'eraser' = 'pen';
  color = '#1f2328';
  size = 3.5;
  fingerDraws = true;
  version = 0;
  onChange: () => void = () => {};
  onPenDetected: () => void = () => {};

  constructor(private container: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.live = document.createElement('canvas');
    this.canvas.className = 'board-canvas';
    this.live.className = 'board-canvas live';
    container.append(this.canvas, this.live);
    this.ctx = this.canvas.getContext('2d')!;
    this.lctx = this.live.getContext('2d')!;

    const ro = new ResizeObserver(() => this.resize());
    ro.observe(container);
    this.resize();

    const el = this.live;
    el.addEventListener('pointerdown', (e) => this.down(e));
    el.addEventListener('pointermove', (e) => this.move(e));
    el.addEventListener('pointerup', (e) => this.up(e));
    el.addEventListener('pointercancel', (e) => this.up(e));
    // Stops iOS Safari from scrolling, magnifying, or selecting text while drawing.
    const block = (e: TouchEvent) => { if (e.cancelable) e.preventDefault(); };
    el.addEventListener('touchstart', block, { passive: false });
    el.addEventListener('touchmove', block, { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  get width() { return this.container.clientWidth; }
  get height() { return this.container.clientHeight; }

  private resize() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    for (const c of [this.canvas, this.live]) {
      c.width = Math.max(1, Math.round(this.width * this.dpr));
      c.height = Math.max(1, Math.round(this.height * this.dpr));
    }
    this.redraw();
  }

  private pos(e: PointerEvent): [number, number, number] {
    const r = this.live.getBoundingClientRect();
    const p = e.pointerType === 'pen' ? (e.pressure || 0.5) : 0.5;
    return [e.clientX - r.left, e.clientY - r.top, p];
  }

  private snapshot() {
    this.undoStack.push({ strokes: this.state.strokes, images: this.state.images });
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
  }

  private changed() {
    this.version++;
    this.onChange();
  }

  private down(e: PointerEvent) {
    if (e.pointerType === 'pen' && this.fingerDraws) {
      this.fingerDraws = false;
      this.onPenDetected();
    }
    if (e.pointerType === 'touch' && !this.fingerDraws) return; // palm rejection
    if (this.activePointer !== null) return;
    e.preventDefault();
    this.activePointer = e.pointerId;
    this.live.setPointerCapture(e.pointerId);
    // Pen eraser button (buttons bit 32) or eraser tool
    this.erasing = this.tool === 'eraser' || (e.buttons & 32) !== 0;
    if (this.erasing) {
      this.erasedThisGesture = false;
      this.eraseAt(this.pos(e));
    } else {
      this.current = { pts: [this.pos(e)], color: this.color, size: this.size, pen: e.pointerType === 'pen' };
      this.drawLive();
    }
  }

  private move(e: PointerEvent) {
    if (e.pointerId !== this.activePointer) return;
    const events = (e as any).getCoalescedEvents?.() as PointerEvent[] | undefined;
    const list = events && events.length ? events : [e];
    if (this.erasing) {
      for (const ev of list) this.eraseAt(this.pos(ev));
    } else if (this.current) {
      for (const ev of list) this.current.pts.push(this.pos(ev));
      this.drawLive();
    }
  }

  private up(e: PointerEvent) {
    if (e.pointerId !== this.activePointer) return;
    this.activePointer = null;
    if (this.erasing) {
      this.erasing = false;
      if (this.erasedThisGesture) this.changed();
      return;
    }
    const s = this.current;
    this.current = null;
    this.lctx.setTransform(1, 0, 0, 1, 0, 0);
    this.lctx.clearRect(0, 0, this.live.width, this.live.height);
    if (!s) return;
    if (s.pts.length === 1) s.pts.push([s.pts[0][0] + 0.1, s.pts[0][1] + 0.1, s.pts[0][2]]); // dot
    this.snapshot();
    this.state = { ...this.state, strokes: [...this.state.strokes, s] };
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.paintStroke(this.ctx, s);
    this.changed();
  }

  private drawLive() {
    const c = this.lctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, this.live.width, this.live.height);
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (this.current) this.paintStroke(c, this.current);
  }

  private eraseAt([x, y]: [number, number, number]) {
    const r = 12;
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
    c.fill(strokePath(s));
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

  private paintAll(c: CanvasRenderingContext2D) {
    for (const im of this.state.images) {
      const el = this.img(im.src);
      if (el) {
        c.drawImage(el, im.x, im.y, im.w, im.h);
        c.strokeStyle = '#d0d7de';
        c.lineWidth = 1;
        c.strokeRect(im.x, im.y, im.w, im.h);
      }
    }
    for (const s of this.state.strokes) this.paintStroke(c, s);
  }

  redraw() {
    const c = this.ctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, this.canvas.width, this.canvas.height);
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.paintAll(c);
  }

  undo() {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(this.state);
    this.state = prev;
    this.redraw();
    this.changed();
  }
  redo() {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(this.state);
    this.state = next;
    this.redraw();
    this.changed();
  }
  clear() {
    if (this.isEmpty()) return;
    this.snapshot();
    this.state = { strokes: [], images: [] };
    this.redraw();
    this.changed();
  }
  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  isEmpty() { return this.state.strokes.length === 0 && this.state.images.length === 0; }
  hasInk() { return this.state.strokes.length > 0; }

  private bounds() {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const s of this.state.strokes) for (const [x, y] of s.pts) {
      x0 = Math.min(x0, x - s.size); y0 = Math.min(y0, y - s.size);
      x1 = Math.max(x1, x + s.size); y1 = Math.max(y1, y + s.size);
    }
    for (const im of this.state.images) {
      x0 = Math.min(x0, im.x); y0 = Math.min(y0, im.y);
      x1 = Math.max(x1, im.x + im.w); y1 = Math.max(y1, im.y + im.h);
    }
    return { x0, y0, x1, y1 };
  }

  /** Places an image (PNG data URL with logical size) on the board, below existing content when it fits. */
  async addImage(src: string, w: number, h: number) {
    const maxW = Math.max(120, this.width - 40), maxH = Math.max(120, this.height - 40);
    const scale = Math.min(1, maxW / w, maxH / h);
    w *= scale; h *= scale;
    let y = 20;
    if (!this.isEmpty()) {
      const b = this.bounds();
      if (b.y1 + 20 + h <= this.height) y = b.y1 + 20;
    }
    await loadImage(src).catch(() => null);
    this.snapshot();
    this.state = { ...this.state, images: [...this.state.images, { src, x: 20, y, w, h }] };
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

  toJSON(): State { return this.state; }

  load(data: unknown) {
    const d = data as Partial<State> | undefined;
    this.state = {
      strokes: Array.isArray(d?.strokes) ? d!.strokes : [],
      images: Array.isArray(d?.images) ? d!.images : [],
    };
    this.undoStack = [];
    this.redoStack = [];
    this.version++;
    this.redraw();
  }
}
