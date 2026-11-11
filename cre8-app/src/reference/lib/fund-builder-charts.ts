// Illustrative strategy thumbnails for the fund builder: seeded price paths drawn like trading charts (candles,
// area and level lines). They show how a strategy trades, not past results. Output is SVG markup built only from
// numbers and fixed labels; class names are mapped through `cls` so the page's CSS module styles them.

type Mark = [number, "b" | "s"];
type Level = { v: number; t: string; tone: "up" | "down" | "mute"; to?: number };
type Candle = { o: number; c: number; h: number; l: number };
type Spec = {
  style: "area" | "line" | "step" | "candle" | "multi" | "bars";
  closes?: number[];
  candles?: Candle[];
  series?: number[][];
  marks?: Mark[];
  levels?: Level[];
  grid?: number[];
  band?: [number, number];
  trail?: (number | null)[];
  fees?: boolean;
};
export type ChartKind = "hold" | "stack" | "dips" | "range" | "trend" | "lp" | "carry" | "custom" | "idle" | "rebalance" | "rotate" | "pair" | "stop";

function seeded(seed: number) {
  let s = seed % 2147483647;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}
function shape(keys: [number, number][], n: number, seed: number, noise: number) {
  const r = seeded(seed), out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    let k = 1;
    while (k < keys.length - 1 && keys[k][0] < t) k++;
    const [t0, v0] = keys[k - 1], [t1, v1] = keys[k];
    out.push((v0 + (v1 - v0) * ((t - t0) / (t1 - t0))) * (1 + (r() - 0.5) * noise));
  }
  return out;
}
function ohlc(closes: number[], seed: number, vol: number): Candle[] {
  const r = seeded(seed);
  return closes.map((c, i) => {
    const o = i ? closes[i - 1] : c * 0.996;
    return { o, c, h: Math.max(o, c) * (1 + r() * vol), l: Math.min(o, c) * (1 - r() * vol) };
  });
}

const SPEC: Record<Exclude<ChartKind, "carry">, () => Spec> = {
  hold: () => ({ style: "area", closes: shape([[0, 100], [0.3, 104], [0.5, 102], [0.75, 109], [1, 115]], 40, 7, 0.022), marks: [[0, "b"]] }),
  stack: () => {
    const closes = shape([[0, 100], [0.2, 93], [0.42, 99], [0.62, 91], [0.85, 100], [1, 104]], 40, 11, 0.022);
    const buys = [1, 7, 13, 19, 25, 31, 37];
    const avg = buys.length / buys.reduce((s, i) => s + 1 / closes[i], 0);
    return { style: "area", closes, marks: buys.map((i): Mark => [i, "b"]), levels: [{ v: avg, t: "Avg", tone: "mute" }] };
  },
  dips: () => {
    const closes = shape([[0, 100], [0.26, 112], [0.46, 98], [0.54, 101.5], [0.74, 116], [0.86, 108], [1, 114]], 32, 5, 0.014);
    const c = ohlc(closes, 9, 0.012);
    let lo = 9;
    for (let i = 9; i < 18; i++) if (closes[i] < closes[lo]) lo = i;
    const b = lo + 2, tp = closes[b] * 1.13;
    let s = b + 1;
    while (s < 31 && c[s].h < tp) s++;
    let rb = s + 1;
    for (let i = s + 1; i < 31; i++) if (closes[i] < closes[rb]) rb = i;
    return { style: "candle", candles: c, marks: [[b, "b"], [s, "s"], [rb, "b"]], levels: [{ v: tp, t: "TP", tone: "up" }] };
  },
  range: () => {
    const r = seeded(21);
    const closes = Array.from({ length: 32 }, (_, i) => 100 + 6.6 * Math.sin(i / 2.05 + 0.4) + (r() - 0.5) * 1.6);
    const c = ohlc(closes, 3, 0.01), marks: Mark[] = [];
    for (let i = 1; i < 31; i++) {
      if (closes[i] < 95.5 && closes[i] <= closes[i - 1] && closes[i] <= closes[i + 1]) marks.push([i, "b"]);
      if (closes[i] > 104.5 && closes[i] >= closes[i - 1] && closes[i] >= closes[i + 1]) marks.push([i, "s"]);
    }
    return { style: "candle", candles: c, marks, grid: [92, 96, 100, 104, 108], levels: [{ v: 108, t: "High", tone: "mute" }, { v: 92, t: "Low", tone: "mute" }] };
  },
  trend: () => {
    const closes = shape([[0, 100], [0.3, 101.5], [0.37, 99.5], [0.42, 104.5], [0.62, 115], [0.8, 125], [0.9, 119], [1, 112]], 32, 13, 0.012);
    const c = ohlc(closes, 17, 0.01);
    const hi = Math.max(...closes.slice(0, 12));
    let e = 12;
    while (e < 31 && closes[e] <= hi) e++;
    const p0 = closes[e], marks: Mark[] = [[e, "b"]];
    for (let k = e + 1, step = 1; k < 31 && step < 3; k++) if (closes[k] >= p0 * (1 + 0.05 * step)) { marks.push([k, "b"]); step++; }
    const trail: (number | null)[] = closes.map(() => null);
    let peak = 0, exit: number | null = null;
    for (let i = e; i < 32; i++) {
      peak = Math.max(peak, closes[i]);
      trail[i] = peak * 0.93;
      if (exit == null && i > marks[marks.length - 1][0] && closes[i] < (trail[i] as number)) exit = i;
    }
    if (exit != null) {
      marks.push([exit, "s"]);
      for (let i = exit + 1; i < 32; i++) trail[i] = null;
    }
    return { style: "candle", candles: c, marks, trail, levels: [{ v: hi, t: "High", tone: "mute", to: e }] };
  },
  lp: () => {
    const r = seeded(31);
    const closes = Array.from({ length: 40 }, (_, i) => 100 + 3.4 * Math.sin(i / 3.1) + (r() - 0.5) * 1.4);
    return { style: "line", closes, band: [95, 105], fees: true, levels: [{ v: 105, t: "Range", tone: "mute" }] };
  },
  custom: () => {
    const closes = shape([[0, 100], [0.3, 97], [0.6, 106], [1, 112]], 40, 41, 0.02);
    return { style: "area", closes, marks: [[3, "b"]], levels: [{ v: closes[3] * 1.18, t: "TP", tone: "up" }, { v: closes[3] * 0.9, t: "Stop", tone: "down" }] };
  },
  idle: () => ({ style: "step", closes: [100, 100, 100.3, 100.3, 100.6, 100.6, 100.9, 100.9, 101.2, 101.2, 101.5, 101.5] }),
  stop: () => {
    const closes = shape([[0, 100], [0.3, 108], [0.5, 112], [0.7, 101], [0.85, 92], [1, 89]], 40, 51, 0.015);
    let x = 0;
    while (x < 39 && closes[x] > 92.5) x++;
    return { style: "area", closes, marks: [[x, "s"]], levels: [{ v: 92.5, t: "Stop", tone: "down" }] };
  },
  pair: () => {
    const r = seeded(61);
    const closes = Array.from({ length: 40 }, (_, i) => 1 + 0.045 * Math.sin(i / 2.6) + (r() - 0.5) * 0.012);
    const marks: Mark[] = [];
    for (let i = 1; i < 39; i++) {
      if (closes[i] < 0.965 && closes[i] <= closes[i - 1] && closes[i] <= closes[i + 1]) marks.push([i, "b"]);
      if (closes[i] > 1.035 && closes[i] >= closes[i - 1] && closes[i] >= closes[i + 1]) marks.push([i, "s"]);
    }
    return { style: "line", closes, band: [0.955, 1.045], marks };
  },
  rotate: () => ({ style: "multi", series: [shape([[0, 100], [1, 128]], 40, 71, 0.02), shape([[0, 100], [1, 108]], 40, 73, 0.02), shape([[0, 100], [1, 92]], 40, 77, 0.02)] }),
  rebalance: () => ({ style: "bars" }),
};

const f = (n: number) => n.toFixed(1);

/** SVG markup for one chart. `cls` maps the fixed class names below to the page's CSS module names. */
export function chartSvg(kind: ChartKind, w: number, h: number, mini: boolean, cls: (name: string) => string, id: string): string {
  const c = (...names: string[]) => names.map(cls).join(" ");
  const svg = (g: string) => `<svg class="${c("cv")}" viewBox="0 0 ${w} ${h}" ${mini ? `width="${w}" height="${h}"` : 'width="100%"'} aria-hidden="true" focusable="false">${g}</svg>`;
  if (kind === "carry") return svg(gauge(w, h, mini, c));
  const s = SPEC[kind]();
  const pad = mini ? { l: 3, r: 3, t: 4, b: 4 } : { l: 6, r: 36, t: 9, b: 9 };
  const pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;
  let g = `<rect class="${c("pl")}" x="0" y="0" width="${w}" height="${h}"/>`;
  if (s.style === "bars") {
    const cols = [[0.55, 0.3, 0.45], [0.42, 0.42, 0.42]], bw = pw / 9;
    cols.forEach((set, k) => set.forEach((v, j) => {
      const x = pad.l + (k * 4.6 + j * 1.25 + 0.4) * bw, bh = v * ph;
      g += `<rect class="${k ? c("cb", "u") : c("g1")}" x="${f(x)}" y="${f(pad.t + ph - bh)}" width="${f(bw * 0.9)}" height="${f(bh)}"/>`;
    }));
    return svg(g);
  }
  const all: number[] = [];
  s.candles?.forEach((candle) => all.push(candle.h, candle.l));
  s.closes?.forEach((v) => all.push(v));
  s.series?.forEach((series) => series.forEach((v) => all.push(v)));
  s.levels?.forEach((level) => all.push(level.v));
  if (s.band) all.push(...s.band);
  if (s.grid) all.push(...s.grid);
  let mx = Math.max(...all), mn = Math.min(...all);
  const sp = (mx - mn) * 0.1;
  mx += sp;
  mn -= sp;
  const n = s.candles ? s.candles.length : (s.closes ?? s.series![0]).length;
  const X = (i: number) => pad.l + (s.candles ? ((i + 0.5) * pw) / n : (i * pw) / (n - 1));
  const Y = (v: number) => pad.t + ((mx - v) / (mx - mn)) * ph;
  if (!mini) for (let k = 1; k <= 3; k++) g += `<line class="${c("gr")}" x1="${pad.l}" x2="${w - pad.r}" y1="${f(pad.t + (ph * k) / 4)}" y2="${f(pad.t + (ph * k) / 4)}"/>`;
  if (s.band) g += `<rect class="${c("bd")}" x="${pad.l}" y="${f(Y(s.band[1]))}" width="${pw}" height="${f(Y(s.band[0]) - Y(s.band[1]))}"/>`;
  s.grid?.forEach((v) => { g += `<line class="${c("gr", "dash")}" x1="${pad.l}" x2="${w - pad.r}" y1="${f(Y(v))}" y2="${f(Y(v))}"/>`; });
  if (s.fees) {
    const fb = 26;
    for (let i = 0; i < fb; i++) {
      const bh = ((i + 1) / fb) * ph * 0.22, x = pad.l + (i * pw) / fb;
      g += `<rect class="${c("fee")}" x="${f(x)}" y="${f(pad.t + ph - bh)}" width="${f((pw / fb) * 0.6)}" height="${f(bh)}"/>`;
    }
  }
  const pts = (arr: number[]) => arr.map((v, i) => `${f(X(i))},${f(Y(v))}`).join(" ");
  if ((s.style === "area" || s.style === "step") && s.closes) {
    const arr = s.closes;
    const line = s.style === "step" ? arr.map((v, i) => `${f(X(i))},${f(Y(v))}` + (i < arr.length - 1 ? ` ${f(X(i + 1))},${f(Y(v))}` : "")).join(" ") : pts(arr);
    g += `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="${c("stop0")}"/><stop offset="1" class="${c("stop1")}"/></linearGradient></defs>`;
    g += `<polygon points="${f(X(0))},${pad.t + ph} ${line} ${f(X(arr.length - 1))},${pad.t + ph}" fill="url(#${id})"/>`;
    g += `<polyline class="${c("ln")}" points="${line}"/>`;
  }
  if (s.style === "line" && s.closes) g += `<polyline class="${c("ln")}" points="${pts(s.closes)}"/>`;
  if (s.style === "multi") s.series!.forEach((series, k) => { g += `<polyline class="${k ? c("ln", "soft") : c("ln")}" points="${pts(series)}"/>`; });
  if (s.candles && !mini) {
    const cw = Math.max(1.6, (pw / s.candles.length) * 0.58);
    s.candles.forEach((candle, i) => {
      const up = candle.c >= candle.o ? "u" : "d", x = X(i);
      g += `<line class="${c("wk", up)}" x1="${f(x)}" x2="${f(x)}" y1="${f(Y(candle.h))}" y2="${f(Y(candle.l))}"/>`;
      const top = Y(Math.max(candle.o, candle.c)), bh = Math.max(1, Y(Math.min(candle.o, candle.c)) - top);
      g += `<rect class="${c("cb", up)}" x="${f(x - cw / 2)}" y="${f(top)}" width="${f(cw)}" height="${f(bh)}"/>`;
    });
  } else if (s.candles) g += `<polyline class="${c("ln")}" points="${s.candles.map((candle, i) => `${f(X(i))},${f(Y(candle.c))}`).join(" ")}"/>`;
  if (s.trail) g += `<polyline class="${c("tr")}" points="${s.trail.map((v, i) => (v == null ? null : `${f(X(i))},${f(Y(v))}`)).filter(Boolean).join(" ")}"/>`;
  if (!mini) s.levels?.forEach((level) => {
    const y = Y(level.v), x2 = level.to != null ? X(level.to) : w - pad.r;
    g += `<line class="${c("lv", level.tone)}" x1="${pad.l}" x2="${f(x2)}" y1="${f(y)}" y2="${f(y)}"/>`;
    g += level.to != null
      ? `<text class="${c("tg", level.tone)}" x="${pad.l + 2}" y="${f(y - 4)}">${level.t}</text>`
      : `<text class="${c("tg", level.tone)}" x="${f(w - pad.r + 4)}" y="${f(y + 3)}">${level.t}</text>`;
  });
  const r = mini ? 2.6 : 3.6;
  s.marks?.forEach(([i, t]) => {
    const candle = s.candles?.[i], v = s.closes?.[i] ?? 0;
    const x = X(i), yb = candle ? Y(candle.l) + 3 : Y(v) + 3, ys = candle ? Y(candle.h) - 3 : Y(v) - 3;
    g += t === "b" ? `<path class="${c("mb")}" d="M${f(x)},${f(yb)} l${r},${r * 1.6} h${-2 * r}z"/>` : `<path class="${c("ms")}" d="M${f(x)},${f(ys)} l${r},${-r * 1.6} h${-2 * r}z"/>`;
  });
  return svg(g);
}

function gauge(w: number, h: number, mini: boolean, c: (...names: string[]) => string) {
  const pad = mini ? 4 : 10, bw = w - pad * 2, y = mini ? h / 2 - 4 : h * 0.42, bh = mini ? 8 : 10;
  let g = `<rect class="${c("pl")}" x="0" y="0" width="${w}" height="${h}"/><rect class="${c("g0")}" x="${pad}" y="${y}" width="${bw}" height="${bh}"/><rect class="${c("g1")}" x="${pad}" y="${y}" width="${bw * 0.5}" height="${bh}"/>`;
  // Labels alternate above and below the bar so neighbouring ticks never collide.
  const tick = (p: number, t: string, tone: string, above: boolean, anchor: string, dx: number) => {
    const x = pad + bw * p;
    g += `<line class="${c("lv", tone, "solid")}" x1="${x}" x2="${x}" y1="${y - 5}" y2="${y + bh + 5}"/>`;
    if (!mini) g += `<text class="${c("tg", tone)}" x="${x + dx}" y="${above ? y - 9 : y + bh + 15}" text-anchor="${anchor}">${t}</text>`;
  };
  tick(0.5, "Target 50%", "mute", true, "end", -3);
  tick(0.65, "Repay", "down", false, "middle", 0);
  tick(0.75, "Liquidation", "down", true, "start", 3);
  if (!mini) g += `<text class="${c("tg", "mute")}" x="${pad}" y="${y + bh + 15}">Debt / collateral</text>`;
  return g;
}
