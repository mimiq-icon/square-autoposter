// cards.mjs  (v11 — the desk's card engine)
// ============================================================================
// Every image this bot posts is built here, from the same brand system, as
// SVG: news cards, alert cards, explainer slides, bar charts, stat grids,
// line charts and article covers. One look everywhere, no design tools, no
// network, no dependencies.
//
// Design rules, on purpose:
//  - PURE: nothing here touches the network, the filesystem or process.env.
//    Same input in, byte-identical SVG out — which is what the tests assert.
//  - NO EMOTICONS in SVG text: the PNG renderer's system fonts usually lack
//    colour emoji glyphs, and a tofu box on a branded card is worse than no
//    glyph. Cards communicate with typography and colour instead.
//  - MANUAL text wrapping: SVG has no auto-wrap and the renderer's font
//    metrics are unknowable in advance, so every builder wraps by a
//    conservative character budget and never reflows. A slightly early wrap
//    is invisible; an overflow past the card edge is a bug.
//  - ALL dynamic text goes through esc(): headlines come from RSS feeds and
//    AI output, i.e. untrusted, so a stray "<" or "&" must never break the
//    SVG.
//
// PNG rendering is OPTIONAL. renderSvgToPng() uses @resvg/resvg-js when it
// is installed ("npm install --no-save @resvg/resvg-js" — the one-time
// install mentioned in the docs) and returns null otherwise. Callers treat
// null as "post without an image": a card that can't render never blocks a
// post.
// ============================================================================

// ---------------------------------------------------------------------------
// Brand system — one palette, one type scale, one corner radius.
// ---------------------------------------------------------------------------
export const BRAND = {
  name: "THE TAPE",
  tagline: "",
  bg: "#0B0E11",
  panel: "#151B24",
  panelAlt: "#10151C",
  border: "#2A313C",
  text: "#F5F7FA",
  muted: "#8B95A5",
  accent: "#F0B90B",   // brand yellow
  green: "#0ECB81",
  red: "#F6465D",
  blue: "#4B9FFF",
  font: "DejaVu Sans, Arial, Liberation Sans, Helvetica, sans-serif",
};

export function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Word-wraps to at most maxLines lines of maxChars characters, breaking on
// spaces. Long words that can't fit on a line alone get hard-truncated with
// an ellipsis rather than overflowing the card. If words must be dropped,
// the last line ends with an ellipsis so truncation is never silent. Returns
// [] (never null) so callers can always join/map.
export function wrapText(text, maxChars, maxLines) {
  const words = String(text ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0 || maxChars < 4 || maxLines < 1) return [];
  const lines = [];
  let cur = "";
  let i = 0;
  let overflow = false;
  while (i < words.length) {
    const w = words[i];
    if (w.length > maxChars) {
      // Hard-truncated word takes the whole line.
      if (cur) {
        if (lines.length >= maxLines) { overflow = true; break; }
        lines.push(cur); cur = "";
      }
      if (lines.length >= maxLines) { overflow = true; break; }
      lines.push(w.slice(0, maxChars - 1) + "…");
      i++;
      continue;
    }
    if (!cur) { cur = w; i++; continue; }
    if (cur.length + 1 + w.length <= maxChars) { cur += " " + w; i++; continue; }
    // Start a new line.
    if (lines.length >= maxLines) { overflow = true; break; }
    lines.push(cur);
    cur = w;
    i++;
  }
  if (cur) {
    if (lines.length < maxLines) lines.push(cur);
    else overflow = true;
  }
  if (overflow && lines.length) {
    lines[lines.length - 1] = lines[lines.length - 1].replace(/…?$/, "…");
  }
  return lines.slice(0, maxLines);
}

export function fmtSignedPct(n, digits = 1) {
  if (!Number.isFinite(n)) return "n/a";
  const v = Number(n);
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(digits)}%`;
}

export function fmtUsdCompact(n) {
  if (!Number.isFinite(n)) return "n/a";
  const abs = Math.abs(n);
  const fmt = (v, suf) => `$${v.toFixed(v >= 100 ? 0 : v >= 1 ? 2 : 4)}${suf}`;
  if (abs >= 1e12) return fmt(n / 1e12, "T");
  if (abs >= 1e9) return fmt(n / 1e9, "B");
  if (abs >= 1e6) return fmt(n / 1e6, "M");
  if (abs >= 1e3) return fmt(n / 1e3, "K");
  return fmt(n, "");
}

export function fmtPrice(n) {
  if (!Number.isFinite(n)) return "n/a";
  const abs = Math.abs(n);
  if (abs >= 1000) return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  if (abs >= 1) return `$${n.toFixed(2)}`;
  if (abs >= 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toPrecision(3)}`;
}

// Shared SVG scaffolding: rounded background, subtle border, brand footer.
function svgRoot(w, h, inner, brand = BRAND) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="${brand.font}">
<rect width="${w}" height="${h}" fill="${brand.bg}"/>
<rect x="6" y="6" width="${w - 12}" height="${h - 12}" rx="18" fill="${brand.bg}" stroke="${brand.border}" stroke-width="2"/>
${inner}
</svg>`;
}

// Left-aligned brand lockup used on every card. The offset after the bold
// name is measured for 19px bold + 3px letter-spacing (~17px per glyph) plus
// a 20px gap — verified against a rendered PNG, since SVG text has no
// auto-measure.
function brandLockup(x, y, brand = BRAND) {
  const mark = `${brandMarkSvg(x - 2, y - 36, 46, brand)}
<text x="${x + 56}" y="${y}" font-size="26" font-weight="800" letter-spacing="4" fill="${brand.text}">${esc(brand.name)}</text>`;
  if (!brand.tagline) return mark;
  const after = x + 56 + brand.name.length * 22 + 20;
  return `${mark}
<text x="${after}" y="${y}" font-size="19" font-weight="400" letter-spacing="3" fill="${brand.muted}">${esc(brand.tagline)}</text>`;
}

function footerLine(x, y, text, brand = BRAND, w = 1080) {
  if (!text) return "";
  return `<line x1="${x}" y1="${y}" x2="${w - x}" y2="${y}" stroke="${brand.border}" stroke-width="1"/>
<text x="${x}" y="${y + 30}" font-size="18" fill="${brand.muted}">${esc(text)}</text>`;
}

// Coin chip: symbol + optional 24h change, colour-coded.
function coinChip(x, y, symbol, change24h, brand = BRAND) {
  const has = Number.isFinite(change24h);
  const tone = !has ? brand.text : change24h >= 0 ? brand.green : brand.red;
  const label = has ? `${symbol}  ${fmtSignedPct(change24h)}` : symbol;
  const w = 56 + Math.round(label.length * 11.5);
  return { w: w + 12, svg: `<rect x="${x}" y="${y - 22}" width="${w}" height="38" rx="19" fill="${brand.panel}" stroke="${brand.border}" stroke-width="1"/>
<circle cx="${x + 20}" cy="${y - 3}" r="6" fill="${tone}"/>
<text x="${x + 38}" y="${y + 3}" font-size="18" font-weight="700" fill="${tone}">${esc(label)}</text>` };
}

function chipRow(y, coins, brand = BRAND) {
  let x = 56;
  return coins.slice(0, 3).map((c) => {
    const chip = coinChip(x, y, c.symbol, c.change24h, brand);
    x += chip.w;
    return chip.svg;
  }).join("\n");
}

// ---------------------------------------------------------------------------
// 1. NEWS CARD — the hook. One big headline, who said it, which coins moved.
//    Nothing on the card is repeated from the post text: the text carries the
//    story, the card carries the headline. (v11.2: no "Source:" twice, no
//    disclaimer on the image — it is already in the post text — no filler
//    captions, and the headline is sized to fill the card.)
// ---------------------------------------------------------------------------
export function buildNewsCardSvg({
  headline,
  context = null,            // optional; the bot no longer passes the feed blurb here
  source = "",
  coins = [],
  disclaimer = "",           // accepted for compatibility; the card no longer prints it
  sparkline = null,          // [{ p: number }] or null
  sparklineLabel = "7 days",
  brand = BRAND,
}) {
  const W = 1080, H = 1080, PAD = 56;
  const hasSpark = Array.isArray(sparkline) && sparkline.length >= 8;
  const len = String(headline ?? "").length;
  // Size tiers: short headlines get big type, long ones step down. Char budgets
  // are conservative for bold DejaVu (~0.56em per glyph) inside a 940px column.
  const tier = hasSpark ? { size: 60, chars: 24, lines: 4 }
    : len <= 55 ? { size: 84, chars: 18, lines: 5 }
    : len <= 95 ? { size: 72, chars: 20, lines: 6 }
    : { size: 62, chars: 23, lines: 7 };
  const headLines = wrapText(headline, tier.chars, tier.lines);
  const lineH = Math.round(tier.size * 1.16);
  const parts = [];

  parts.push(brandLockup(PAD, 92, brand));
  parts.push(`<rect x="${PAD}" y="138" width="104" height="36" rx="7" fill="${brand.accent}"/>
<text x="${PAD + 52}" y="163" text-anchor="middle" font-size="17" font-weight="800" letter-spacing="3" fill="#1A1D21">NEWS</text>`);

  let y = 214;
  if (coins.length) {
    parts.push(chipRow(y + 24, coins, brand));
    y += 70;
  }

  const headTop = y + 44;
  const headH = headLines.length * lineH;
  parts.push(`<rect x="${PAD}" y="${headTop}" width="6" height="${headH - 8}" rx="3" fill="${brand.accent}"/>`);
  parts.push(headLines.map((l, i) =>
    `<text x="${PAD + 30}" y="${headTop + tier.size * 0.82 + i * lineH}" font-size="${tier.size}" font-weight="800" fill="${brand.text}">${esc(l)}</text>`
  ).join("\n"));
  y = headTop + headH;

  if (context) {
    const ctxLines = wrapText(context, 44, 2);
    parts.push(ctxLines.map((l, i) =>
      `<text x="${PAD + 30}" y="${y + 40 + i * 36}" font-size="28" fill="${brand.muted}">${esc(l)}</text>`
    ).join("\n"));
    y += 40 + ctxLines.length * 36;
  }

  if (hasSpark) {
    const chartTop = Math.max(y + 56, 640);
    const chartH = Math.min(200, H - 130 - 70 - chartTop);
    const chartW = W - PAD * 2;
    const vals = sparkline.map((d) => d.p);
    const min = Math.min(...vals), max = Math.max(...vals);
    const span = max - min || 1;
    const up = vals[vals.length - 1] >= vals[0];
    const tone = up ? brand.green : brand.red;
    const xy = vals.map((v, i) => [PAD + (i / (vals.length - 1)) * chartW, chartTop + chartH - ((v - min) / span) * (chartH - 20) - 10]);
    const [lx, ly] = xy[xy.length - 1];
    parts.push(`<text x="${PAD}" y="${chartTop - 14}" font-size="18" fill="${brand.muted}">${esc(sparklineLabel)}</text>
<polyline points="${xy.map(([a, b]) => `${a.toFixed(1)},${b.toFixed(1)}`).join(" ")}" fill="none" stroke="${tone}" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"/>
<circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="7" fill="${tone}"/>
<text x="${PAD + chartW}" y="${chartTop - 14}" text-anchor="end" font-size="18" fill="${brand.muted}">${esc(fmtPrice(max))} high · ${esc(fmtPrice(min))} low</text>`);
  }

  const src = String(source ?? "").split(/,\s*/).filter(Boolean).join("  ·  ");
  parts.push(footerLine(PAD, H - 110, src, brand));
  return svgRoot(W, H, parts.join("\n"), brand);
}

// ---------------------------------------------------------------------------
// 2. ALERT CARD — sharp moves. Big price, big change, ONE chart. With price
//    history the chart carries the 24h high/low and the crossed level; without
//    it the card falls back to the range bar. (v11.2: range bar and sparkline
//    no longer both appear, labels no longer collide, the line ends on a dot
//    instead of a hook, and the caption filler is gone.)
// ---------------------------------------------------------------------------
export function buildAlertCardSvg({
  symbol = "",
  price = null,
  change24h = null,
  low = null,
  high = null,
  windowLabel = "24h range",
  headline = "",
  source = "",
  disclaimer = "",           // accepted for compatibility; the card no longer prints it
  sparkline = null,
  sparklineLabel = "24h",
  level = null,
  brand = BRAND,
}) {
  const W = 1080, H = 1080, PAD = 56;
  const parts = [];
  const down = Number.isFinite(change24h) && change24h < 0;
  const tone = down ? brand.red : brand.green;

  parts.push(brandLockup(PAD, 92, brand));
  parts.push(`<rect x="${PAD}" y="130" width="210" height="42" rx="8" fill="${tone}"/>
<text x="${PAD + 105}" y="158" text-anchor="middle" font-size="19" font-weight="800" letter-spacing="3" fill="#14171B">PRICE ALERT</text>`);

  if (symbol) parts.push(`<text x="${PAD}" y="268" font-size="60" font-weight="800" fill="${brand.muted}">${esc(symbol)}</text>`);
  if (price != null && Number.isFinite(price)) {
    parts.push(`<text x="${PAD}" y="384" font-size="124" font-weight="800" fill="${brand.text}">${esc(fmtPrice(price))}</text>`);
  }
  if (Number.isFinite(change24h)) {
    parts.push(`<text x="${PAD}" y="450" font-size="44" font-weight="700" fill="${tone}">${esc(fmtSignedPct(change24h))} in 24h</text>`);
  }

  const sparkVals = Array.isArray(sparkline) ? sparkline.map((d) => d.p).filter(Number.isFinite) : [];
  const hasSpark = sparkVals.length >= 8;
  let headlineTop = 780, headlineLines = 3, headlineChars = 40;

  if (hasSpark) {
    const chartTop = 540, chartH = 250, chartW = W - PAD * 2;
    let min = Math.min(...sparkVals), max = Math.max(...sparkVals);
    const hi = Number.isFinite(high) ? Math.max(high, max) : max;
    const lo = Number.isFinite(low) ? Math.min(low, min) : min;
    if (Number.isFinite(level)) { min = Math.min(min, level); max = Math.max(max, level); }
    const span = max - min || 1;
    const lineTone = sparkVals[sparkVals.length - 1] >= sparkVals[0] ? brand.green : brand.red;
    const yOf = (v) => chartTop + chartH - ((v - min) / span) * (chartH - 24) - 12;
    const xy = sparkVals.map((v, i) => [PAD + (i / (sparkVals.length - 1)) * chartW, yOf(v)]);
    const [lx, ly] = xy[xy.length - 1];
    if (Number.isFinite(level)) {
      const lvY = yOf(level);
      parts.push(`<line x1="${PAD}" y1="${lvY.toFixed(1)}" x2="${PAD + chartW}" y2="${lvY.toFixed(1)}" stroke="${brand.accent}" stroke-width="2" stroke-dasharray="10 8"/>
<text x="${PAD}" y="${(lvY - 10).toFixed(1)}" font-size="20" font-weight="700" fill="${brand.accent}">${esc(fmtPrice(level))}</text>`);
    }
    parts.push(`<polyline points="${xy.map(([a, b]) => `${a.toFixed(1)},${b.toFixed(1)}`).join(" ")}" fill="none" stroke="${lineTone}" stroke-width="5" stroke-linejoin="round" stroke-linecap="round"/>
<circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="8" fill="${lineTone}"/>
<text x="${PAD}" y="${chartTop - 14}" font-size="18" fill="${brand.muted}">${esc(sparklineLabel)}</text>
<text x="${PAD + chartW}" y="${chartTop - 14}" text-anchor="end" font-size="18" fill="${brand.muted}">high ${esc(fmtPrice(hi))}</text>
<text x="${PAD + chartW}" y="${chartTop + chartH + 28}" text-anchor="end" font-size="18" fill="${brand.muted}">low ${esc(fmtPrice(lo))}</text>`);
    headlineTop = 876; headlineLines = 2; headlineChars = 40;
  } else if (Number.isFinite(low) && Number.isFinite(high) && high > low && Number.isFinite(price)) {
    const barY = 590, barW = W - PAD * 2, barH = 18;
    const frac = Math.min(1, Math.max(0, (price - low) / (high - low)));
    const px = PAD + frac * (barW - 8);
    parts.push(`<text x="${PAD}" y="${barY - 16}" font-size="18" fill="${brand.muted}">${esc(windowLabel)}</text>
<rect x="${PAD}" y="${barY}" width="${barW}" height="${barH}" rx="9" fill="${brand.panel}" stroke="${brand.border}" stroke-width="1"/>
<rect x="${PAD}" y="${barY}" width="${(frac * (barW - 8) + 8).toFixed(1)}" height="${barH}" rx="9" fill="${tone}" opacity="0.45"/>
<circle cx="${(px + 4).toFixed(1)}" cy="${barY + barH / 2}" r="10" fill="${tone}"/>
<text x="${PAD}" y="${barY + barH + 34}" font-size="18" fill="${brand.muted}">low ${esc(fmtPrice(low))}</text>
<text x="${PAD + barW}" y="${barY + barH + 34}" text-anchor="end" font-size="18" fill="${brand.muted}">high ${esc(fmtPrice(high))}</text>`);
    headlineTop = 760;
  }

  if (headline) {
    const hl = wrapText(headline, headlineChars, headlineLines);
    parts.push(hl.map((l, i) =>
      `<text x="${PAD}" y="${headlineTop + i * 44}" font-size="34" font-weight="700" fill="${brand.text}">${esc(l)}</text>`
    ).join("\n"));
  }

  parts.push(footerLine(PAD, H - 110, String(source ?? ""), brand));
  return svgRoot(W, H, parts.join("\n"), brand);
}

// ---------------------------------------------------------------------------
// BRAND MARK — a "T" whose crossbar is a strip of ticker tape (sprocket holes).
// Drawn in a 100-unit box so it scales from a 34px card lockup to a 1024px
// profile picture. One source of truth: cards and avatar both call this.
// ---------------------------------------------------------------------------
export function brandMarkSvg(x, y, size, brand = BRAND) {
  const k = size / 100;
  const holes = [20, 35, 50, 65, 80].map((cx) => `<circle cx="${cx}" cy="25" r="3.6" fill="${brand.bg}"/>`).join("");
  return `<g transform="translate(${x} ${y}) scale(${k.toFixed(4)})">
<rect x="6" y="9" width="88" height="32" rx="7" fill="${brand.accent}"/>
${holes}
<rect x="37" y="34" width="26" height="58" rx="6" fill="${brand.accent}"/>
</g>`;
}

// Profile picture: square, mark centred with room for the circular crop that
// Binance Square applies. node make-avatar.mjs writes brand/ files from this.
export function buildAvatarSvg({ size = 1024, brand = BRAND } = {}) {
  const m = size * 0.56;
  const off = (size - m) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
<defs><radialGradient id="g" cx="50%" cy="42%" r="70%"><stop offset="0" stop-color="#1B222C"/><stop offset="1" stop-color="${brand.bg}"/></radialGradient></defs>
<rect width="${size}" height="${size}" fill="url(#g)"/>
${brandMarkSvg(off, off - size * 0.01, m, { ...brand, bg: "#151B24" })}
</svg>`;
}

// ---------------------------------------------------------------------------
// EXTREME ALERT CARD — only for violent moves. Red (down) or green (up) glow,
// a huge percentage, and the REAL price line drawn as a glowing trace. It is
// the same data as the normal alert card, just loud: a static image cannot
// flash, so the glow carries the urgency. Never decorative — the line is the
// actual price history, never a stock chart.
// ---------------------------------------------------------------------------
export function buildExtremeAlertCardSvg({
  symbol = "",
  price = null,
  heroPct = null,            // the number that made this extreme (24h or short window)
  heroLabel = "in 24h",
  change24h = null,
  headline = "",
  source = "",
  sparkline = null,
  level = null,
  brand = BRAND,
}) {
  const W = 1080, H = 1080, PAD = 56;
  const down = Number.isFinite(heroPct) ? heroPct < 0 : Number.isFinite(change24h) && change24h < 0;
  const tone = down ? brand.red : brand.green;
  const deep = down ? "#2A0610" : "#042A1B";
  const parts = [];

  const vals = Array.isArray(sparkline) ? sparkline.map((d) => d.p).filter(Number.isFinite) : [];
  const hasLine = vals.length >= 8;

  parts.push(`<defs>
<radialGradient id="bgGlow" cx="50%" cy="72%" r="85%"><stop offset="0" stop-color="${deep}"/><stop offset="1" stop-color="${brand.bg}"/></radialGradient>
<filter id="glow" x="-20%" y="-40%" width="140%" height="180%"><feGaussianBlur stdDeviation="9"/></filter>
<filter id="glowBig" x="-20%" y="-40%" width="140%" height="180%"><feGaussianBlur stdDeviation="22"/></filter>
</defs>
<rect width="${W}" height="${H}" fill="url(#bgGlow)"/>`);

  // faint grid, like a trading screen
  const grid = [];
  for (let gx = PAD; gx <= W - PAD; gx += 160) grid.push(`<line x1="${gx}" y1="0" x2="${gx}" y2="${H}"/>`);
  for (let gy = 100; gy <= H; gy += 160) grid.push(`<line x1="0" y1="${gy}" x2="${W}" y2="${gy}"/>`);
  parts.push(`<g stroke="${tone}" stroke-opacity="0.10" stroke-width="1">${grid.join("")}</g>`);

  parts.push(`<rect x="6" y="6" width="${W - 12}" height="${H - 12}" rx="18" fill="none" stroke="${tone}" stroke-opacity="0.55" stroke-width="2"/>`);
  parts.push(brandLockup(PAD, 92, brand));
  parts.push(`<rect x="${PAD}" y="130" width="210" height="42" rx="8" fill="${tone}"/>
<text x="${PAD + 105}" y="158" text-anchor="middle" font-size="19" font-weight="800" letter-spacing="3" fill="#14171B">PRICE ALERT</text>`);

  if (symbol) parts.push(`<text x="${PAD}" y="270" font-size="60" font-weight="800" fill="${brand.text}">${esc(symbol)}</text>`);
  if (Number.isFinite(heroPct)) {
    const t = esc(fmtSignedPct(heroPct));
    parts.push(`<text x="${PAD}" y="420" font-size="168" font-weight="800" fill="${tone}" filter="url(#glowBig)" opacity="0.65">${t}</text>
<text x="${PAD}" y="420" font-size="168" font-weight="800" fill="${tone}">${t}</text>
<text x="${PAD}" y="480" font-size="40" font-weight="600" fill="${brand.text}">${esc(heroLabel)}${price != null && Number.isFinite(price) ? `   ·   ${esc(fmtPrice(price))}` : ""}</text>`);
  }

  let headlineTop = 840;
  if (hasLine) {
    const chartTop = 540, chartH = 250, chartW = W - PAD * 2;
    let min = Math.min(...vals), max = Math.max(...vals);
    if (Number.isFinite(level)) { min = Math.min(min, level); max = Math.max(max, level); }
    const span = max - min || 1;
    const yOf = (v) => chartTop + chartH - ((v - min) / span) * (chartH - 24) - 12;
    const xy = vals.map((v, i) => [PAD + (i / (vals.length - 1)) * chartW, yOf(v)]);
    const pts = xy.map(([a, b]) => `${a.toFixed(1)},${b.toFixed(1)}`).join(" ");
    const [lx, ly] = xy[xy.length - 1];
    if (Number.isFinite(level)) {
      const lvY = yOf(level);
      parts.push(`<line x1="${PAD}" y1="${lvY.toFixed(1)}" x2="${PAD + chartW}" y2="${lvY.toFixed(1)}" stroke="${brand.accent}" stroke-width="2" stroke-dasharray="10 8"/>
<text x="${PAD}" y="${(lvY - 10).toFixed(1)}" font-size="20" font-weight="700" fill="${brand.accent}">${esc(fmtPrice(level))}</text>`);
    }
    parts.push(`<polyline points="${pts}" fill="none" stroke="${tone}" stroke-width="16" stroke-linejoin="round" stroke-linecap="round" filter="url(#glow)" opacity="0.9"/>
<polyline points="${pts}" fill="none" stroke="#FFFFFF" stroke-width="5" stroke-linejoin="round" stroke-linecap="round"/>
<circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="18" fill="${tone}" filter="url(#glow)"/>
<circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="8" fill="#FFFFFF"/>`);
    headlineTop = 856;
  }

  if (headline) {
    const hl = wrapText(headline, 40, 2);
    parts.push(hl.map((l, i) => `<text x="${PAD}" y="${headlineTop + i * 44}" font-size="34" font-weight="700" fill="${brand.text}">${esc(l)}</text>`).join("\n"));
  }
  parts.push(footerLine(PAD, H - 110, String(source ?? ""), brand));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${brand.font}">
<rect width="${W}" height="${H}" fill="${brand.bg}"/>
${parts.join("\n")}
</svg>`;
}

// ---------------------------------------------------------------------------
// 3. EXPLAINER SLIDE — presentation style, reserved for education and
//    research pieces (never news; news gets cards). Kicker + title + up to
//    four bullets + footer with progress.
// ---------------------------------------------------------------------------
export function buildExplainerSlideSvg({
  kicker = "EXPLAINER",
  title,
  bullets = [],
  footer = "",
  index = null,
  total = null,
  brand = BRAND,
}) {
  const W = 1200, H = 675, PAD = 64;
  const parts = [];

  parts.push(brandLockup(PAD, 70, brand));

  parts.push(`<text x="${PAD}" y="150" font-size="20" font-weight="800" letter-spacing="4" fill="${brand.accent}">${esc(kicker)}</text>`);

  const titleLines = wrapText(title, 34, 2);
  parts.push(titleLines.map((l, i) =>
    `<text x="${PAD}" y="${215 + i * 58}" font-size="48" font-weight="800" fill="${brand.text}">${esc(l)}</text>`
  ).join("\n"));

  let y = 215 + titleLines.length * 58 + 30;
  const shown = bullets.slice(0, 4);
  shown.forEach((b, i) => {
    const lines = wrapText(b, 72, 2);
    parts.push(`<rect x="${PAD}" y="${y - 17}" width="6" height="${lines.length * 30 + 4}" rx="3" fill="${brand.accent}"/>`);
    parts.push(lines.map((l, j) =>
      `<text x="${PAD + 24}" y="${y + j * 30}" font-size="24" fill="${j === 0 ? brand.text : brand.muted}">${esc(l)}</text>`
    ).join("\n"));
    y += lines.length * 30 + 26;
  });

  // Footer: progress dots + footer text.
  if (Number.isFinite(total) && total > 0) {
    const idx = Number.isFinite(index) ? Math.min(total - 1, Math.max(0, index)) : 0;
    const dots = Array.from({ length: total }, (_, i) =>
      `<circle cx="${PAD + 8 + i * 22}" cy="${H - 52}" r="5" fill="${i === idx ? brand.accent : brand.border}"/>`
    ).join("");
    parts.push(dots);
  }
  if (footer) {
    parts.push(`<text x="${W - PAD}" y="${H - 46}" text-anchor="end" font-size="15" fill="${brand.muted}">${esc(footer)}</text>`);
  }
  return svgRoot(W, H, parts.join("\n"), brand);
}

// ---------------------------------------------------------------------------
// 4. BAR CHART — horizontal, green/red by sign, value labels at bar ends.
//    Used for 24h change panels and any small ranked comparison.
// ---------------------------------------------------------------------------
export function buildBarChartSvg({
  title,
  subtitle = "",
  rows = [],            // [{ label, value, valueText? }]
  unit = "%",
  brand = BRAND,
}) {
  const W = 1200, H = 675, PAD = 64;
  const parts = [];
  const data = rows.slice(0, 8);
  const maxAbs = Math.max(1e-9, ...data.map((r) => Math.abs(Number(r.value) || 0)));

  parts.push(brandLockup(PAD, 70, brand));
  parts.push(`<text x="${PAD}" y="150" font-size="32" font-weight="800" fill="${brand.text}">${esc(title)}</text>`);
  if (subtitle) parts.push(`<text x="${PAD}" y="182" font-size="18" fill="${brand.muted}">${esc(subtitle)}</text>`);

  const top = 220, rowH = Math.min(64, (H - top - 80) / Math.max(1, data.length));
  const labelW = 170, barX = PAD + labelW + 16, barMaxW = W - PAD - barX - 110;
  const zeroX = barX + barMaxW / 2;

  data.forEach((r, i) => {
    const y = top + i * rowH;
    const v = Number(r.value) || 0;
    const w = (Math.abs(v) / maxAbs) * (barMaxW / 2);
    const tone = v >= 0 ? brand.green : brand.red;
    const barY = y + rowH / 2 - 12;
    parts.push(`<text x="${PAD}" y="${barY + 15}" font-size="19" font-weight="700" fill="${brand.text}">${esc(String(r.label).slice(0, 14))}</text>`);
    if (v >= 0) {
      parts.push(`<rect x="${zeroX}" y="${barY}" width="${w.toFixed(1)}" height="24" rx="4" fill="${tone}"/>`);
    } else {
      parts.push(`<rect x="${(zeroX - w).toFixed(1)}" y="${barY}" width="${w.toFixed(1)}" height="24" rx="4" fill="${tone}"/>`);
    }
    const vText = r.valueText != null ? r.valueText : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}${unit}`;
    const vTextX = v >= 0 ? zeroX + w + 10 : zeroX - w - 10;
    const anchor = v >= 0 ? "start" : "end";
    parts.push(`<text x="${vTextX.toFixed(1)}" y="${barY + 16}" text-anchor="${anchor}" font-size="18" font-weight="700" fill="${tone}">${esc(vText)}</text>`);
  });

  parts.push(`<line x1="${zeroX}" y1="${top - 10}" x2="${zeroX}" y2="${top + data.length * rowH}" stroke="${brand.border}" stroke-width="1"/>`);
  parts.push(`<text x="${W - PAD}" y="${H - 40}" text-anchor="end" font-size="14" fill="${brand.muted}">${esc(brand.name)}</text>`);
  return svgRoot(W, H, parts.join("\n"), brand);
}

// ---------------------------------------------------------------------------
// 5. STAT GRID — a headline stat per tile (2 columns × up to 3 rows), e.g.
//    "DEX volume 24h", "BTC fees", "Total TVL".
// ---------------------------------------------------------------------------
export function buildStatGridSvg({
  title,
  subtitle = "",
  stats = [],          // [{ label, value, sub?, tone? }]
  footer = "",
  brand = BRAND,
}) {
  const W = 1200, H = 675, PAD = 64;
  const parts = [];
  const shown = stats.slice(0, 6);
  const cols = 2;
  const rows = Math.ceil(shown.length / cols);
  const top = 210;
  const tileW = (W - PAD * 2 - 24) / cols;
  const tileH = Math.min(150, (H - top - 90) / Math.max(1, rows));

  parts.push(brandLockup(PAD, 70, brand));
  parts.push(`<text x="${PAD}" y="150" font-size="32" font-weight="800" fill="${brand.text}">${esc(title)}</text>`);
  if (subtitle) parts.push(`<text x="${PAD}" y="182" font-size="18" fill="${brand.muted}">${esc(subtitle)}</text>`);

  shown.forEach((s, i) => {
    const cx = PAD + (i % cols) * (tileW + 24);
    const cy = top + Math.floor(i / cols) * (tileH + 24);
    const tone = s.tone === "green" ? brand.green : s.tone === "red" ? brand.red : brand.accent;
    parts.push(`<rect x="${cx}" y="${cy}" width="${tileW}" height="${tileH}" rx="14" fill="${brand.panel}" stroke="${brand.border}" stroke-width="1"/>
<rect x="${cx}" y="${cy}" width="52" height="6" rx="3" fill="${tone}"/>
<text x="${cx + 24}" y="${cy + 44}" font-size="17" fill="${brand.muted}">${esc(String(s.label).slice(0, 40))}</text>
<text x="${cx + 24}" y="${cy + 94}" font-size="40" font-weight="800" fill="${brand.text}">${esc(String(s.value).slice(0, 18))}</text>`);
    if (s.sub) parts.push(`<text x="${cx + 24}" y="${cy + 124}" font-size="15" fill="${brand.muted}">${esc(String(s.sub).slice(0, 48))}</text>`);
  });

  if (footer) parts.push(`<text x="${W - PAD}" y="${H - 40}" text-anchor="end" font-size="14" fill="${brand.muted}">${esc(footer)}</text>`);
  return svgRoot(W, H, parts.join("\n"), brand);
}

// ---------------------------------------------------------------------------
// 6. LINE CHART — up to 4 series, normalised to the shared min/max, legend
//    chips on top. Used by the research desk (TVL/fee/hashrate trends) and
//    as the weekly article's data panel.
// ---------------------------------------------------------------------------
export function buildLineChartSvg({
  title,
  subtitle = "",
  series = [],          // [{ name, points: [number], color? }]
  valueFormatter = fmtUsdCompact,
  windowLabel = "",
  brand = BRAND,
}) {
  const W = 1200, H = 675, PAD = 64;
  const parts = [];
  const shown = series.filter((s) => Array.isArray(s.points) && s.points.length >= 2).slice(0, 4);
  const palette = [brand.accent, brand.blue, brand.green, brand.red];
  const top = 230, chartH = 300, chartW = W - PAD * 2;

  const all = shown.flatMap((s) => s.points).filter(Number.isFinite);
  const min = Math.min(...all), max = Math.max(...all);
  const span = max - min || 1;
  const len = Math.max(...shown.map((s) => s.points.length));

  parts.push(brandLockup(PAD, 70, brand));
  parts.push(`<text x="${PAD}" y="150" font-size="32" font-weight="800" fill="${brand.text}">${esc(title)}</text>`);
  if (subtitle) parts.push(`<text x="${PAD}" y="182" font-size="18" fill="${brand.muted}">${esc(subtitle)}</text>`);
  if (windowLabel) parts.push(`<text x="${PAD}" y="${top - 24}" font-size="15" fill="${brand.muted}">${esc(windowLabel)}</text>`);

  shown.forEach((s, i) => {
    const color = s.color || palette[i % palette.length];
    const pts = s.points.map((v, j) => {
      const px = PAD + (j / (s.points.length - 1)) * chartW;
      const py = top + chartH - ((v - min) / span) * (chartH - 20) - 10;
      return `${px.toFixed(1)},${py.toFixed(1)}`;
    });
    parts.push(`<polyline points="${pts.join(" ")}" fill="none" stroke="${color}" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"/>`);
    // Legend chip
    const lx = PAD + i * 190;
    parts.push(`<rect x="${lx}" y="${top - 44}" width="14" height="14" rx="4" fill="${color}"/>
<text x="${lx + 22}" y="${top - 32}" font-size="16" font-weight="700" fill="${brand.text}">${esc(String(s.name).slice(0, 12))}</text>`);
  });

  parts.push(`<line x1="${PAD}" y1="${top + chartH}" x2="${PAD + chartW}" y2="${top + chartH}" stroke="${brand.border}" stroke-width="1"/>
<text x="${PAD}" y="${top + chartH + 28}" font-size="15" fill="${brand.muted}">${esc(valueFormatter(min))}</text>
<text x="${PAD + chartW}" y="${top + chartH + 28}" text-anchor="end" font-size="15" fill="${brand.muted}">${esc(valueFormatter(max))}</text>
<text x="${W - PAD}" y="${H - 40}" text-anchor="end" font-size="14" fill="${brand.muted}">${esc(brand.name)}</text>`);
  return svgRoot(W, H, parts.join("\n"), brand);
}

// ---------------------------------------------------------------------------
// 7. ARTICLE COVER — 16:9 cover for long-form pieces (weekly recap, research
//    articles): kicker, big wrapped title, coin chips.
// ---------------------------------------------------------------------------
export function buildArticleCoverSvg({
  kicker = "RESEARCH",
  title,
  coins = [],
  footer = "",
  brand = BRAND,
}) {
  const W = 1200, H = 675, PAD = 64;
  const parts = [];

  parts.push(`<rect x="0" y="0" width="${W}" height="6" fill="${brand.accent}"/>`);
  parts.push(brandLockup(PAD, 84, brand));
  parts.push(`<text x="${PAD}" y="170" font-size="20" font-weight="800" letter-spacing="4" fill="${brand.accent}">${esc(kicker)}</text>`);

  const titleLines = wrapText(title, 36, 3);
  parts.push(titleLines.map((l, i) =>
    `<text x="${PAD}" y="${248 + i * 62}" font-size="52" font-weight="800" fill="${brand.text}">${esc(l)}</text>`
  ).join("\n"));

  let y = 248 + titleLines.length * 62 + 24;
  if (coins.length) {
    parts.push(chipRow(y, coins, brand));
    y += 58;
  }
  if (footer) parts.push(`<text x="${PAD}" y="${Math.max(y + 10, H - 60)}" font-size="16" fill="${brand.muted}">${esc(footer)}</text>`);
  return svgRoot(W, H, parts.join("\n"), brand);
}

// ---------------------------------------------------------------------------
// OPTIONAL PNG RENDERER
// ---------------------------------------------------------------------------
// Uses @resvg/resvg-js when installed. Resolution order: an explicitly passed
// requireFn (tests / scripts), then a require rooted at process.cwd() (the
// repo, or a scratch dir with node_modules), then a plain dynamic import.
// Returns Buffer of PNG bytes, or null when the library isn't available or
// anything fails — callers post text-only, never crash.
import { createRequire } from "module";
import path from "path";

export async function renderSvgToPng(svg, { scale = 2, requireFn = null } = {}) {
  try {
    let Resvg = null;
    const mod = requireFn
      ? requireFn("@resvg/resvg-js")
      : createRequire(path.join(process.cwd(), "render-card.js"))("@resvg/resvg-js");
    Resvg = mod.default || mod.Resvg || mod;
    const resvg = new Resvg(svg, {
      fitTo: { mode: "scale", value: scale },
      font: { loadSystemFonts: true, defaultFontFamily: "DejaVu Sans" },
      background: BRAND.bg,
    });
    return Buffer.from(resvg.render().asPng());
  } catch {
    return null;
  }
}

// Convenience: render and write next to nothing else. Returns the png path on
// success, null when the renderer is missing. The SVG is always written first
// so a failed PNG step still leaves a inspectable artefact beside it.
export async function writeCardPng(svg, outBase, { scale = 2, requireFn = null, writeFn, mkdirFn } = {}) {
  const wf = writeFn || (await import("fs")).writeFileSync;
  const mf = mkdirFn || (await import("fs")).mkdirSync;
  try { mf(path.dirname(outBase), { recursive: true }); } catch { /* exists */ }
  const png = await renderSvgToPng(svg, { scale, requireFn });
  if (!png) return null;
  const out = `${outBase}.png`;
  wf(out, png);
  return out;
}
