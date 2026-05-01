import sharp from 'sharp';
import { encodeAsWebp } from './screenshot-store.js';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Highlight {
  rect: Rect;
  number?: number;
}

export interface AnnotateOptions {
  highlights: Highlight[];
  viewportWidth: number;
  viewportHeight: number;
  isFirstStep?: boolean;
}

const HIGHLIGHT_COLOR = '#f97316';
const HIGHLIGHT_GLOW = 'rgba(249,115,22,0.3)';
const CIRCLE_RADIUS = 14;

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildSingleHighlightSvg(
  h: Highlight,
  offsetX: number,
  offsetY: number,
  scaleX: number,
  scaleY: number,
  canvasW: number,
  canvasH: number,
): string {
  const pad = 4 * scaleX;
  const r = h.rect;
  const ex = (r.x - offsetX) * scaleX;
  const ey = (r.y - offsetY) * scaleY;
  const ew = r.width * scaleX;
  const eh = r.height * scaleY;

  if (ew < 2 || eh < 2) return '';

  const rx = Math.max(0, ex - pad);
  const ry = Math.max(0, ey - pad);
  const rw = Math.min(canvasW - rx, ew + pad * 2);
  const rh = Math.min(canvasH - ry, eh + pad * 2);
  const radius = 6 * scaleX;
  const lw = 3 * scaleX;

  const parts: string[] = [];

  // Glow border
  parts.push(
    `<rect x="${rx}" y="${ry}" width="${rw}" height="${rh}" rx="${radius}" ry="${radius}" ` +
    `fill="none" stroke="${escapeXml(HIGHLIGHT_GLOW)}" stroke-width="${lw + 4 * scaleX}"/>`
  );
  // Solid border
  parts.push(
    `<rect x="${rx}" y="${ry}" width="${rw}" height="${rh}" rx="${radius}" ry="${radius}" ` +
    `fill="none" stroke="${HIGHLIGHT_COLOR}" stroke-width="${lw}"/>`
  );

  // Arrow — drawn on whichever side has the most room
  const spaceR = canvasW - (rx + rw);
  const spaceL = rx;
  const spaceT = ry;
  const spaceB = canvasH - (ry + rh);
  const best = Math.max(spaceR, spaceL, spaceT, spaceB);

  if (best >= 30 * scaleX) {
    const arrowLen = Math.min(65 * scaleX, best * 0.7);
    const arrowGap = 8 * scaleX;
    let tipX: number, tipY: number, startX: number, startY: number, cpX: number, cpY: number;

    if (best === spaceR) {
      tipX = rx + rw + arrowGap; tipY = ry + rh / 2;
      startX = tipX + arrowLen; startY = tipY - arrowLen * 0.7;
      cpX = startX; cpY = tipY;
    } else if (best === spaceL) {
      tipX = rx - arrowGap; tipY = ry + rh / 2;
      startX = tipX - arrowLen; startY = tipY - arrowLen * 0.7;
      cpX = startX; cpY = tipY;
    } else if (best === spaceT) {
      tipX = rx + rw / 2; tipY = ry - arrowGap;
      startX = tipX + arrowLen * 0.7; startY = tipY - arrowLen;
      cpX = tipX; cpY = startY;
    } else {
      tipX = rx + rw / 2; tipY = ry + rh + arrowGap;
      startX = tipX + arrowLen * 0.7; startY = tipY + arrowLen;
      cpX = tipX; cpY = startY;
    }

    parts.push(
      `<path d="M ${startX},${startY} Q ${cpX},${cpY} ${tipX},${tipY}" ` +
      `fill="none" stroke="${HIGHLIGHT_COLOR}" stroke-width="${lw}" stroke-linecap="round"/>`
    );

    const headLen = 12 * scaleX;
    const angle = Math.atan2(tipY - cpY, tipX - cpX);
    const p1x = tipX - headLen * Math.cos(angle - 0.45);
    const p1y = tipY - headLen * Math.sin(angle - 0.45);
    const p2x = tipX - headLen * Math.cos(angle + 0.45);
    const p2y = tipY - headLen * Math.sin(angle + 0.45);
    parts.push(
      `<polygon points="${tipX},${tipY} ${p1x},${p1y} ${p2x},${p2y}" fill="${HIGHLIGHT_COLOR}"/>`
    );
  }

  return parts.join('\n');
}

/** Compute candidate circle positions for a box, in preference order.
 *
 *  Primary candidates are the MIDPOINTS of each edge (outside), not corners.
 *  This matches the reference annotation style where each number floats beside
 *  the element on the side with the most open space.
 *  The inside-left / inside-right options are absolute last resorts.
 */
function circlePositionCandidates(
  rx: number,
  ry: number,
  rw: number,
  rh: number,
  cr: number,
  lw: number,
  canvasW: number,
  canvasH: number,
): Array<{ cx: number; cy: number; space: number }> {
  const gap = 4;

  // Each outside candidate carries the available canvas space in its direction.
  // Sorting by space descending keeps circles in open areas.
  const candidates: Array<{ cx: number; cy: number; space: number }> = [
    { cx: rx - cr - gap,       cy: ry + rh / 2,     space: rx },
    { cx: rx + rw + cr + gap,  cy: ry + rh / 2,     space: canvasW - (rx + rw) },
    { cx: rx + rw / 2,         cy: ry - cr - gap,   space: ry },
    { cx: rx + rw / 2,         cy: ry + rh + cr + gap, space: canvasH - (ry + rh) },
    // Inside options — last resort, space=0 so always sorted last
    { cx: rx + cr + lw,        cy: ry + rh / 2,     space: 0 },
    { cx: rx + rw - cr - lw,   cy: ry + rh / 2,     space: 0 },
  ];

  return candidates.map(({ cx, cy, space }) => ({
    cx: Math.min(canvasW - cr - 2, Math.max(cr + 2, cx)),
    cy: Math.min(canvasH - cr - 2, Math.max(cr + 2, cy)),
    space,
  }));
}

function circlesOverlap(
  ax: number, ay: number,
  bx: number, by: number,
  cr: number,
): boolean {
  const dx = ax - bx;
  const dy = ay - by;
  // Circles overlap if centres are closer than 2.2 × radius (small buffer)
  return Math.sqrt(dx * dx + dy * dy) < cr * 2.2;
}

/** Returns true if the circle centre falls inside (or within cr/3 pixels of) a box.
 *  We use a small margin rather than the full radius so that circles sitting just
 *  outside a neighbour's border are still accepted. */
function circleOverlapsBox(
  cx: number, cy: number,
  rx: number, ry: number, rw: number, rh: number,
  cr: number,
): boolean {
  const margin = cr * 0.33;
  return (
    cx >= rx - margin &&
    cx <= rx + rw + margin &&
    cy >= ry - margin &&
    cy <= ry + rh + margin
  );
}

function buildNumberedHighlightSvg(
  h: Highlight,
  offsetX: number,
  offsetY: number,
  scaleX: number,
  scaleY: number,
  canvasW: number,
  canvasH: number,
  /** Pre-resolved circle centre — caller handles collision avoidance. */
  circleX: number,
  circleY: number,
): string {
  const pad = 4 * scaleX;
  const r = h.rect;
  const ex = (r.x - offsetX) * scaleX;
  const ey = (r.y - offsetY) * scaleY;
  const ew = r.width * scaleX;
  const eh = r.height * scaleY;

  if (ew < 2 || eh < 2) return '';

  // Clamp the highlight box so it never extends outside the canvas.
  const rx = Math.max(0, ex - pad);
  const ry = Math.max(0, ey - pad);
  const rw = Math.min(canvasW - rx, ew + pad * 2);
  const rh = Math.min(canvasH - ry, eh + pad * 2);
  const radius = 6 * scaleX;
  const lw = 3 * scaleX;
  const cr = CIRCLE_RADIUS * scaleX;

  const parts: string[] = [];

  // Glow border
  parts.push(
    `<rect x="${rx}" y="${ry}" width="${rw}" height="${rh}" rx="${radius}" ry="${radius}" ` +
    `fill="none" stroke="${escapeXml(HIGHLIGHT_GLOW)}" stroke-width="${lw + 4 * scaleX}"/>`
  );
  // Solid border
  parts.push(
    `<rect x="${rx}" y="${ry}" width="${rw}" height="${rh}" rx="${radius}" ry="${radius}" ` +
    `fill="none" stroke="${HIGHLIGHT_COLOR}" stroke-width="${lw}"/>`
  );

  // Circle + number drawn last so they are always on top
  parts.push(
    `<circle cx="${circleX}" cy="${circleY}" r="${cr}" fill="${HIGHLIGHT_COLOR}"/>` +
    `<text x="${circleX}" y="${circleY}" dy="0.35em" text-anchor="middle" ` +
    `fill="white" font-size="${cr * 1.2}px" font-weight="bold" font-family="Arial, Helvetica, sans-serif">${h.number}</text>`
  );

  return parts.join('\n');
}

export async function annotateScreenshot(
  rawImageBuffer: Buffer,
  options: AnnotateOptions,
): Promise<Buffer> {
  const { highlights, viewportWidth, viewportHeight } = options;

  if (highlights.length === 0) {
    return encodeAsWebp(rawImageBuffer, 85);
  }

  const metadata = await sharp(rawImageBuffer).metadata();
  const imgW = metadata.width!;
  const imgH = metadata.height!;

  const scaleX = imgW / viewportWidth;
  const scaleY = imgH / viewportHeight;

  // Always annotate the full screenshot — no cropping.
  const canvasW = imgW;
  const canvasH = imgH;
  const offsetX = 0;
  const offsetY = 0;

  const isNumbered = highlights.some((h) => h.number != null);

  if (!isNumbered) {
    // Single-highlight path — no collision resolution needed.
    const svgParts = highlights.map((h) =>
      buildSingleHighlightSvg(h, offsetX, offsetY, scaleX, scaleY, canvasW, canvasH)
    );
    const svgOverlay = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasW}" height="${canvasH}">${svgParts.join('')}</svg>`
    );
    const composited = await sharp(rawImageBuffer)
      .composite([{ input: svgOverlay, top: 0, left: 0 }])
      .png()
      .toBuffer();
    return encodeAsWebp(composited, 85);
  }

  // ── Numbered highlights: two-pass layout ──────────────────────────────────
  // Pass 1: compute each highlight's box and candidate circle positions.
  // Pass 2: greedily assign positions, sorting each highlight's candidates to
  //         prefer corners that point AWAY from the centroid of the other
  //         highlights — this naturally spreads circles toward empty space.

  const pad  = 4 * scaleX;
  const lw   = 3 * scaleX;
  const cr   = CIRCLE_RADIUS * scaleX;

  interface BoxedHighlight {
    highlight: Highlight;
    rx: number; ry: number; rw: number; rh: number;
    candidates: Array<{ cx: number; cy: number; space: number }>;
  }

  const boxed: BoxedHighlight[] = highlights.map((h) => {
    const r   = h.rect;
    const ex  = (r.x - offsetX) * scaleX;
    const ey  = (r.y - offsetY) * scaleY;
    const ew  = r.width  * scaleX;
    const eh  = r.height * scaleY;
    const rx  = Math.max(0, ex - pad);
    const ry  = Math.max(0, ey - pad);
    const rw  = Math.min(canvasW - rx, ew + pad * 2);
    const rh  = Math.min(canvasH - ry, eh + pad * 2);
    return {
      highlight: h,
      rx, ry, rw, rh,
      candidates: circlePositionCandidates(rx, ry, rw, rh, cr, lw, canvasW, canvasH),
    };
  });

  // Greedy assignment: for each highlight, pick the candidate with the most
  // available canvas space that doesn't collide with already-placed circles or
  // with other highlight boxes.
  const placed: Array<{ cx: number; cy: number }> = [];

  for (let i = 0; i < boxed.length; i++) {
    const b = boxed[i];

    // Sort by available space descending so circles land in the most open area.
    // Inside candidates (space=0) always fall last.
    const ordered = [...b.candidates].sort((a, c) => c.space - a.space);

    let chosen = ordered[0];
    for (const c of ordered) {
      const collidesCircle = placed.some((p) => circlesOverlap(c.cx, c.cy, p.cx, p.cy, cr));
      const collidesBox = boxed.some((other, j) =>
        j !== i && circleOverlapsBox(c.cx, c.cy, other.rx, other.ry, other.rw, other.rh, cr)
      );
      if (!collidesCircle && !collidesBox) {
        chosen = c;
        break;
      }
    }
    placed.push(chosen);
  }

  // Build SVG with resolved positions.
  const svgParts: string[] = boxed.map((b, i) =>
    buildNumberedHighlightSvg(
      b.highlight, offsetX, offsetY, scaleX, scaleY, canvasW, canvasH,
      placed[i].cx, placed[i].cy,
    )
  );

  const svgOverlay = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasW}" height="${canvasH}">${svgParts.join('')}</svg>`
  );

  // Composite to PNG first so the bytes are guaranteed-decodable, then encode
  // through the magic-byte-checked WebP path. Avoids sharp ever silently
  // emitting TIFF/JPEG when the chained operations include `.composite()`.
  const composited = await sharp(rawImageBuffer)
    .composite([{ input: svgOverlay, top: 0, left: 0 }])
    .png()
    .toBuffer();
  return encodeAsWebp(composited, 85);
}
