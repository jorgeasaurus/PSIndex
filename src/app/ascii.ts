// Animated ASCII density field drawn on a fixed canvas behind the UI.
// Glyphs are pre-rendered into an atlas (one per ramp step) and blitted with drawImage,
// which keeps a full-HD frame to a few ms. Pauses when hidden; one static frame under reduced motion.

const RAMP = ' .·:-=+*%#@';
const SIGILS = '$|{}<>;'; // PowerShell punctuation sprinkled into the densest cells

export type Theme = 'light' | 'dark';

interface Ripple { x: number; y: number; t0: number; amp: number }

export class AsciiField {
  private ctx: CanvasRenderingContext2D;
  private atlas: HTMLCanvasElement;
  private cell = 14;
  private qpad = 18; // how far the field fades out around quiet zones
  private headerFade = 0.5; // fraction of the viewport where the field is at full strength
  private cols = 0;
  private rows = 0;
  private dpr = 1;
  private raf = 0;
  private last = 0;
  private ripples: Ripple[] = [];
  private mouse = { x: -1e4, y: -1e4 };
  private color = '#8b7cf6';
  private dim = 0.55;
  private reduced: boolean;
  private seed = Math.random() * 1000;
  private glyphW = 0;
  private running = false;
  private quiet: DOMRect[] = [];

  /** `quietSelector` marks elements the field steps back from, so text over it stays clean. */
  constructor(private canvas: HTMLCanvasElement, private quietSelector = '[data-quiet]') {
    this.ctx = canvas.getContext('2d', { alpha: true })!;
    this.atlas = document.createElement('canvas');
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.resize = this.resize.bind(this);
    this.frame = this.frame.bind(this);
    addEventListener('resize', this.resize, { passive: true });
    addEventListener('pointermove', (e: PointerEvent) => { this.mouse.x = e.clientX; this.mouse.y = e.clientY; }, { passive: true });
    document.addEventListener('visibilitychange', () => (document.hidden ? this.stop() : this.start()));
    matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', (e) => {
      this.reduced = e.matches;
      this.reduced ? (this.stop(), this.draw(performance.now())) : this.start();
    });
    this.resize();
    // Web fonts change both the glyphs and the layout of the quiet zones.
    document.fonts?.ready.then(() => this.resize());
  }

  /** Tint the field with a source colour, for the current theme (darker glyphs on the light ground). */
  setTone(hex: string, theme: Theme) {
    const color = theme === 'light' ? scaleHex(hex, 0.62) : hex;
    const dim = theme === 'light' ? 0.85 : 0.78;
    if (color === this.color && dim === this.dim) return;
    this.color = color;
    this.dim = dim;
    this.bakeAtlas();
    if (this.reduced) this.draw(performance.now());
  }

  /** Push a ripple out from a screen point (e.g. the search caret on each keystroke). */
  pulse(x: number, y: number, amp = 1) {
    this.ripples.push({ x, y, t0: performance.now(), amp });
    if (this.ripples.length > 8) this.ripples.shift();
  }

  start() {
    if (this.running || this.reduced) { if (this.reduced) this.draw(performance.now()); return; }
    this.running = true;
    this.raf = requestAnimationFrame(this.frame);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  private resize() {
    const c = this.canvas;
    this.dpr = Math.min(2, devicePixelRatio || 1);
    const w = innerWidth, h = innerHeight;
    const narrow = w < 640;
    this.cell = narrow ? 12 : 14;
    this.qpad = narrow ? 6 : 18;
    this.headerFade = Math.min(1, (narrow ? 520 : 420) / Math.max(1, h));
    this.quiet = [...document.querySelectorAll(this.quietSelector)].map((el) => el.getBoundingClientRect());
    c.width = Math.round(w * this.dpr);
    c.height = Math.round(h * this.dpr);
    c.style.width = w + 'px';
    c.style.height = h + 'px';
    this.cols = Math.ceil(w / this.cell) + 1;
    this.rows = Math.ceil(h / this.cell) + 1;
    this.bakeAtlas();
    this.draw(performance.now());
  }

  private bakeAtlas() {
    const glyphs = RAMP + SIGILS;
    const px = Math.round(this.cell * this.dpr);
    this.glyphW = px;
    this.atlas.width = px * glyphs.length;
    this.atlas.height = px;
    const a = this.atlas.getContext('2d')!;
    a.clearRect(0, 0, this.atlas.width, px);
    a.font = `${Math.round(px * 0.78)}px "Geist Mono Variable", ui-monospace, monospace`;
    a.textAlign = 'center';
    a.textBaseline = 'middle';
    a.fillStyle = this.color;
    for (let i = 0; i < glyphs.length; i++) {
      // Brighter ramp steps are drawn more opaque, so density and brightness agree.
      const step = Math.min(i, RAMP.length - 1) / (RAMP.length - 1);
      a.globalAlpha = (0.18 + 0.82 * step) * this.dim;
      a.fillText(glyphs[i], i * px + px / 2, px / 2 + px * 0.04);
    }
  }

  private frame(now: number) {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.frame);
    if (now - this.last < 33) return; // ~30 fps is plenty for ambience
    this.last = now;
    this.draw(now);
  }

  private draw(now: number) {
    const { ctx, cols, rows, cell, dpr, glyphW } = this;
    const W = this.canvas.width, H = this.canvas.height;
    ctx.clearRect(0, 0, W, H);
    const t = (this.reduced ? 0 : now / 1000) + this.seed;
    const step = cell * dpr;
    const nRamp = RAMP.length;
    const mx = this.mouse.x, my = this.mouse.y;
    const live = this.ripples.filter((r) => now - r.t0 < 2200);
    this.ripples = live;
    const { headerFade, qpad } = this;

    for (let y = 0; y < rows; y++) {
      const py = y * cell;
      const vy = y / rows;
      // Vertical falloff: full strength across the top band, a quiet floor beneath.
      const fall = 0.28 + 0.72 * Math.pow(Math.max(0, 1 - vy / (headerFade * 1.2)), 0.8);
      for (let x = 0; x < cols; x++) {
        const px = x * cell;
        // Domain-warped interference read as a contour map: thin flowing ridges over a quiet floor.
        const qx = x * 0.07 + 1.8 * Math.sin(y * 0.06 + t * 0.21);
        const qy = y * 0.1 + 1.8 * Math.cos(x * 0.035 - t * 0.17);
        const h = Math.sin(qx) + Math.sin(qy) + Math.sin((qx + qy) * 0.7 + t * 0.12);
        const ridge = 1 - Math.abs(Math.sin(h * 3.4));
        let val = 0.1 + Math.pow(ridge, 2.6) * 0.95 + (h + 3) * 0.045;
        for (const r of live) {
          const age = (now - r.t0) / 1000;
          const d = Math.hypot(px - r.x, py - r.y);
          const front = age * 520;
          const band = d - front;
          if (band > -90 && band < 40) val += r.amp * (1 - age / 2.2) * Math.cos(band * 0.07) * 0.75 * (band < 0 ? 1 + band / 90 : 1 - band / 40);
        }
        const md = Math.hypot(px - mx, py - my);
        if (md < 160) val += (1 - md / 160) * 0.45;
        val *= fall;
        for (const q of this.quiet) {
          const dx = Math.max(q.left - px, 0, px - q.right);
          const dy = Math.max(q.top - py, 0, py - q.bottom);
          const d = Math.max(dx, dy);
          if (d < qpad) val *= 0.08 + (d / qpad) * 0.92;
        }
        if (val <= 0.06) continue;
        let gi = Math.min(nRamp - 1, Math.floor(val * nRamp));
        if (gi >= nRamp - 2 && ((x * 7 + y * 13 + Math.floor(t * 0.5)) % 11 === 0)) gi = nRamp + ((x + y) % SIGILS.length);
        ctx.drawImage(this.atlas, gi * glyphW, 0, glyphW, glyphW, x * step, y * step, step, step);
      }
    }
  }
}

/** Multiply each RGB channel of a #rrggbb colour by k. */
function scaleHex(hex: string, k: number) {
  const n = parseInt(hex.slice(1), 16);
  return '#' + [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(v * k).toString(16).padStart(2, '0')).join('');
}
