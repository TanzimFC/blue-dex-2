import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createCanvas, GlobalFonts, loadImage, type SKRSContext2D } from '@napi-rs/canvas';
import type { Rarity, Variant } from '../types.js';
import { TIERS, effectiveDv, formatDv } from '../domain/value.js';

/**
 * Cards are DRAWN from catalogue data (name, DV, STRIKE, EGO, description, portrait), never stored as one PNG per card.
 * Size matches the original design: 457 x 640. Fonts ship in assets/fonts (Roboto Condensed, SIL OFL).
 */
export const CARD_W = 457;
export const CARD_H = 640;

let fontsReady = false;
export function initFonts(assetsDir: string): void {
  if (fontsReady) return;
  const dir = join(assetsDir, 'fonts');
  for (const [file, family] of [['RobotoCondensed-Bold.woff2', 'BDCondBold'], ['RobotoCondensed-Regular.woff2', 'BDCond']] as const) {
    const p = join(dir, file);
    if (existsSync(p)) GlobalFonts.registerFromPath(p, family);
  }
  fontsReady = true;
}
const BOLD = (px: number) => `${px}px BDCondBold, "Liberation Sans", Arial, sans-serif`;
const REG = (px: number) => `${px}px BDCond, "Liberation Sans", Arial, sans-serif`;

export interface CardRenderInput {
  name: string; edition: string; dv: number; tier: Rarity; strike: number; ego: number;
  /** e.g. "Team Z". */
  team?: string | null; description?: string; variant: Variant;
  /** absolute path of a portrait image, or null for the built-in placeholder */
  portraitPath?: string | null;
  ownerName?: string | null; designedBy?: string;
}

function roundRect(c: SKRSContext2D, x: number, y: number, w: number, h: number, r: number): void {
  c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
}

function fitText(c: SKRSContext2D, text: string, maxW: number, start: number, min: number, font: (px: number) => string): number {
  for (let px = start; px > min; px -= 1) { c.font = font(px); if (c.measureText(text).width <= maxW) return px; }
  return min;
}

function wrap(c: SKRSContext2D, text: string, maxW: number): string[] {
  const lines: string[] = []; let line = '';
  for (const word of text.split(/\s+/)) {
    const t = line ? `${line} ${word}` : word;
    if (c.measureText(t).width > maxW && line) { lines.push(line); line = word; } else line = t;
  }
  if (line) lines.push(line);
  return lines;
}

function ballIcon(c: SKRSContext2D, cx: number, cy: number, r: number): void {
  c.save(); c.fillStyle = '#fff'; c.strokeStyle = '#0b1220'; c.lineWidth = 2;
  c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.fill(); c.stroke();
  c.fillStyle = '#0b1220'; c.beginPath();
  for (let i = 0; i < 5; i++) { const a = -Math.PI / 2 + (i * 2 * Math.PI) / 5; const x = cx + Math.cos(a) * r * 0.38, y = cy + Math.sin(a) * r * 0.38; i ? c.lineTo(x, y) : c.moveTo(x, y); }
  c.closePath(); c.fill();
  c.lineWidth = 1.6; c.beginPath();
  for (let i = 0; i < 5; i++) { const a = -Math.PI / 2 + (i * 2 * Math.PI) / 5; c.moveTo(cx + Math.cos(a) * r * 0.38, cy + Math.sin(a) * r * 0.38); c.lineTo(cx + Math.cos(a) * r * 0.9, cy + Math.sin(a) * r * 0.9); }
  c.stroke(); c.restore();
}

function flameIcon(c: SKRSContext2D, cx: number, cy: number, r: number): void {
  c.save(); c.translate(cx, cy); c.scale(r / 22, r / 22);
  c.fillStyle = '#ff5a1f'; c.beginPath();
  c.moveTo(0, 22); c.bezierCurveTo(-20, 18, -20, -2, -6, -12); c.bezierCurveTo(-6, -4, -2, -2, 0, -8);
  c.bezierCurveTo(2, -16, 4, -20, 2, -24); c.bezierCurveTo(16, -14, 22, 6, 16, 14); c.bezierCurveTo(13, 20, 6, 22, 0, 22); c.closePath(); c.fill();
  c.fillStyle = '#ffd23f'; c.beginPath();
  c.moveTo(0, 22); c.bezierCurveTo(-9, 20, -10, 10, -3, 4); c.bezierCurveTo(-2, 8, 1, 8, 2, 3); c.bezierCurveTo(9, 9, 9, 19, 0, 22); c.closePath(); c.fill();
  c.restore();
}

function sparkle(c: SKRSContext2D, x: number, y: number, s: number): void {
  c.beginPath(); c.moveTo(x, y - s); c.quadraticCurveTo(x, y, x + s, y); c.quadraticCurveTo(x, y, x, y + s); c.quadraticCurveTo(x, y, x - s, y); c.quadraticCurveTo(x, y, x, y - s); c.fill();
}

async function drawPortrait(c: SKRSContext2D, x: number, y: number, w: number, h: number, path: string | null | undefined, initials: string, tint: string): Promise<void> {
  c.save(); roundRect(c, x, y, w, h, 8); c.clip();
  let drawn = false;
  if (path && existsSync(path)) {
    try {
      const img = await loadImage(path);
      const k = Math.max(w / img.width, h / img.height);
      const dw = img.width * k, dh = img.height * k;
      // anchor slightly above centre so faces stay in frame on tall portraits
      c.drawImage(img, x + (w - dw) / 2, y + (h - dh) * 0.25, dw, dh); drawn = true;
    } catch { /* fall through to placeholder */ }
  }
  if (!drawn) {
    const g = c.createLinearGradient(x, y, x + w, y + h); g.addColorStop(0, '#1b3a8c'); g.addColorStop(1, tint);
    c.fillStyle = g; c.fillRect(x, y, w, h);
    c.fillStyle = 'rgba(8,16,48,0.55)';
    c.beginPath(); c.arc(x + w / 2, y + h * 0.42, h * 0.2, 0, Math.PI * 2); c.fill();
    c.beginPath(); c.ellipse(x + w / 2, y + h * 0.98, w * 0.3, h * 0.38, 0, Math.PI, 0); c.fill();
    c.fillStyle = 'rgba(255,255,255,0.14)'; c.font = BOLD(110); c.textAlign = 'center'; c.fillText(initials, x + w / 2, y + h * 0.64); c.textAlign = 'left';
  }
  c.restore();
}

export async function renderCard(i: CardRenderInput): Promise<Buffer> {
  const canvas = createCanvas(CARD_W, CARD_H); const c = canvas.getContext('2d');
  const tier = TIERS[i.tier]; const shiny = i.variant === 'shiny';
  const accent = shiny ? '#ffd700' : `#${tier.color.toString(16).padStart(6, '0')}`;

  // background + frame
  const bg = c.createLinearGradient(0, 0, 0, CARD_H); bg.addColorStop(0, '#12388f'); bg.addColorStop(0.55, '#0c2767'); bg.addColorStop(1, '#071840');
  c.fillStyle = bg; c.fillRect(0, 0, CARD_W, CARD_H);
  const glow = c.createRadialGradient(CARD_W / 2, 150, 20, CARD_W / 2, 150, 340); glow.addColorStop(0, 'rgba(70,120,255,0.35)'); glow.addColorStop(1, 'rgba(70,120,255,0)');
  c.fillStyle = glow; c.fillRect(0, 0, CARD_W, CARD_H);
  c.lineWidth = shiny ? 8 : 5; c.strokeStyle = accent; c.strokeRect(2.5, 2.5, CARD_W - 5, CARD_H - 5);

  // name (top-left) and DV (top-right, slanted like the original design)
  const dvShown = formatDv(effectiveDv(i.dv, i.variant));
  c.fillStyle = '#fff'; c.textBaseline = 'alphabetic';
  c.save(); c.transform(1, 0, -0.18, 1, 0, 0);
  c.font = BOLD(44); const dvW = c.measureText(dvShown).width; c.textAlign = 'right'; c.fillText(dvShown, CARD_W - 24 + 12, 56);
  c.font = BOLD(15); c.fillStyle = 'rgba(255,255,255,0.75)'; c.fillText('DV', CARD_W - 24 + 12 - dvW - 6, 56); c.restore();
  c.textAlign = 'left'; c.fillStyle = '#fff';
  const nameMax = CARD_W - 28 - dvW - 80;
  const px = fitText(c, i.name, nameMax, 36, 20, BOLD); c.font = BOLD(px); c.fillText(i.name, 28, 52);

  // portrait frame: taller when the card has no flavour text (base cards), so the art carries the card
  const hasText = !!i.description?.trim();
  const FX = 28, FY = 78, FW = 401, FH = hasText ? 222 : 300;
  c.fillStyle = '#fff'; roundRect(c, FX - 5, FY - 5, FW + 10, FH + 10, 12); c.fill();
  await drawPortrait(c, FX, FY, FW, FH, i.portraitPath, (i.name.match(/[A-Z]/g) ?? ['?']).slice(0, 2).join(''), accent);
  // tier pill (+ shiny marker, dormant while shiny is paused)
  c.font = BOLD(15); const label = shiny ? `SHINY  ${tier.label.toUpperCase()}` : tier.label.toUpperCase();
  const pw = c.measureText(label).width + 22;
  c.fillStyle = accent; roundRect(c, FX + 8, FY + 8, pw, 26, 13); c.fill();
  c.fillStyle = shiny ? '#3a2a00' : '#0b1220'; c.fillText(label, FX + 19, FY + 27);
  if (shiny) { c.fillStyle = 'rgba(255,236,150,0.95)'; sparkle(c, FX + FW - 30, FY + 34, 15); sparkle(c, FX + FW - 62, FY + 62, 9); sparkle(c, FX + FW - 22, FY + 80, 7); sparkle(c, FX + 40, FY + FH - 40, 10); }

  // info panel
  const PX = 28, PY = FY + FH + 16, PW = 401, PH = 552 - PY;
  c.fillStyle = 'rgba(0,0,0,0.30)'; roundRect(c, PX, PY, PW, PH, 6); c.fill();
  c.save(); c.globalAlpha = 0.16; c.translate(PX + PW / 2, PY + PH / 2 + 4); const k = Math.min(1, PH / 190); c.scale(k, k); c.strokeStyle = '#9cc2ff'; c.lineWidth = 6; c.beginPath();
  for (let n = 0; n < 6; n++) { const a = Math.PI / 6 + (n * Math.PI) / 3; const x = Math.cos(a) * 70, y = Math.sin(a) * 78; n ? c.lineTo(x, y) : c.moveTo(x, y); }
  c.closePath(); c.stroke(); c.fillStyle = '#9cc2ff'; c.font = BOLD(34); c.textAlign = 'center'; c.fillText('BL DEX', 0, 12); c.restore(); c.textAlign = 'left';

  if (!hasText) {
    c.fillStyle = accent; c.font = BOLD(15); c.fillText('TEAM', PX + 16, PY + 30);
    c.fillStyle = '#fff'; const tp = fitText(c, i.team ?? 'Blue Lock', PW - 32, 34, 18, BOLD); c.font = BOLD(tp); c.fillText(i.team ?? 'Blue Lock', PX + 16, PY + 30 + tp + 4);
    c.fillStyle = 'rgba(255,255,255,0.72)'; c.font = REG(18); c.fillText(i.edition === 'Base' ? 'Base Card' : i.edition, PX + 16, PY + PH - 18);
  } else {
    let ty = PY + 14;
    if (i.team) { c.font = BOLD(15); c.fillStyle = accent; c.fillText(`TEAM  ${i.team.toUpperCase()}`, PX + 14, ty + 12); ty += 26; }
    c.fillStyle = '#fff';
    let size = 25; let lines: string[] = [];
    for (; size >= 17; size--) { c.font = BOLD(size); lines = wrap(c, i.description!, PW - 28); if (lines.length * (size + 5) <= PH - (ty - PY) - 12) break; }
    c.font = BOLD(size);
    lines.forEach((l, n) => c.fillText(l, PX + 14, ty + size + n * (size + 5)));
  }

  // footer: credits left, STRIKE and EGO right
  c.fillStyle = 'rgba(0,0,0,0.38)'; c.fillRect(0, 566, CARD_W, CARD_H - 566);
  c.fillStyle = 'rgba(255,255,255,0.85)'; c.font = REG(14);
  c.fillText(`designed by ${i.designedBy ?? 'TanzimFC'}`, 14, 600); if (i.ownerName) c.fillText(`owner: ${i.ownerName.slice(0, 22)}`, 14, 620);
  ballIcon(c, 208, 604, 21); flameIcon(c, 330, 603, 21);
  c.fillStyle = 'rgba(255,255,255,0.7)'; c.font = BOLD(11); c.fillText('STRIKE', 234, 586); c.fillText('EGO', 356, 586);
  c.fillStyle = '#fff'; c.font = BOLD(38); c.fillText(String(i.strike), 234, 624); c.fillText(String(i.ego), 356, 624);
  return canvas.encode('png');
}

/**
 * "Who's that?" image: the portrait, pixelated so the character cannot be recognised, or a neutral placeholder.
 * Both variants use the SAME image, so nothing about shininess can ever leak through the spawn art.
 */
export async function renderSpawnArt(portraitPath: string | null | undefined): Promise<Buffer> {
  const S = 512; const canvas = createCanvas(S, S); const c = canvas.getContext('2d');
  const g = c.createLinearGradient(0, 0, S, S); g.addColorStop(0, '#12388f'); g.addColorStop(1, '#071840'); c.fillStyle = g; c.fillRect(0, 0, S, S);
  let drawn = false;
  if (portraitPath && existsSync(portraitPath)) {
    try {
      const img = await loadImage(portraitPath);
      const small = createCanvas(18, 18); const sc = small.getContext('2d');
      const k = Math.max(18 / img.width, 18 / img.height);
      sc.drawImage(img, (18 - img.width * k) / 2, (18 - img.height * k) * 0.25, img.width * k, img.height * k);
      c.imageSmoothingEnabled = false; c.drawImage(small, 0, 0, 18, 18, 0, 0, S, S);
      c.fillStyle = 'rgba(4,10,30,0.45)'; c.fillRect(0, 0, S, S); drawn = true;
    } catch { /* placeholder below */ }
  }
  if (!drawn) {
    c.fillStyle = 'rgba(4,10,30,0.7)'; c.beginPath(); c.arc(S / 2, S * 0.38, 95, 0, Math.PI * 2); c.fill(); c.beginPath(); c.ellipse(S / 2, S * 1.02, 190, 250, 0, Math.PI, 0); c.fill();
  }
  c.fillStyle = 'rgba(255,255,255,0.9)'; c.font = BOLD(150); c.textAlign = 'center'; c.fillText('?', S / 2, S * 0.62);
  return canvas.encode('png');
}
