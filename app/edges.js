export const DETECTION_EDGE = 480;

const angleCount = 120;
const angleStep = Math.PI / angleCount;
const rhoStep = 1.5;
const cosines = Float32Array.from({ length: angleCount }, (_, index) => Math.cos(index * angleStep));
const sines = Float32Array.from({ length: angleCount }, (_, index) => Math.sin(index * angleStep));

function gradients({ data, width, height }) {
  const size = width * height;
  const light = new Uint8Array(size);
  const red = new Int16Array(size);
  const blue = new Int16Array(size);
  const strength = new Float32Array(size);
  const directionX = new Float32Array(size);
  const directionY = new Float32Array(size);
  for (let i = 0, offset = 0; i < size; i++, offset += 4) {
    const r = data[offset];
    const g = data[offset + 1];
    const b = data[offset + 2];
    light[i] = (54 * r + 183 * g + 19 * b) >> 8;
    red[i] = (r - g) * .65;
    blue[i] = (b - g) * .65;
  }
  const planes = [light, red, blue];
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const index = y * width + x;
      const top = index - width;
      const bottom = index + width;
      let largest = 0;
      let dx = 0;
      let dy = 0;
      // Pick the strongest luminance or color edge, including edges of similar brightness.
      for (const plane of planes) {
        const gx = plane[top + 1] + 2 * plane[index + 1] + plane[bottom + 1] -
          plane[top - 1] - 2 * plane[index - 1] - plane[bottom - 1];
        const gy = plane[bottom - 1] + 2 * plane[bottom] + plane[bottom + 1] -
          plane[top - 1] - 2 * plane[top] - plane[top + 1];
        const magnitude = gx * gx + gy * gy;
        if (magnitude > largest) {
          largest = magnitude;
          dx = gx;
          dy = gy;
        }
      }
      if (largest < 144) continue;
      const magnitude = Math.sqrt(largest);
      strength[index] = magnitude / 4;
      directionX[index] = dx / magnitude;
      directionY[index] = dy / magnitude;
    }
  }
  return { planes, strength, directionX, directionY, width, height };
}

function colorStep(planes, inner, outer) {
  return Math.max(Math.abs(planes[0][inner] - planes[0][outer]),
    Math.abs(planes[1][inner] - planes[1][outer]), Math.abs(planes[2][inner] - planes[2][outer]));
}

function findLines({ width, height, strength, directionX, directionY, planes }) {
  const midX = (width - 1) / 2;
  const midY = (height - 1) / 2;
  const radius = Math.ceil(Math.hypot(midX, midY) / rhoStep) + 1;
  const stride = 2 * radius + 1;
  const votes = new Float32Array(angleCount * stride);
  for (let y = 4; y < height - 4; y++) {
    for (let x = 4; x < width - 4; x++) {
      const index = y * width + x;
      const weight = strength[index];
      if (weight < 4) continue;
      const nx = directionX[index];
      const ny = directionY[index];
      const ax = Math.abs(nx);
      const ay = Math.abs(ny);
      const step = ay < .414 * ax ? 1 : ax < .414 * ay ? width : width + (nx * ny > 0 ? 1 : -1);
      if (weight < strength[index - step] || weight <= strength[index + step]) continue;
      // A page edge keeps a different color on each side. Thin printed rules usually do not.
      const reach = Math.round(4 * nx) + Math.round(4 * ny) * width;
      if (colorStep(planes, index + reach, index - reach) < 5) continue;
      const normal = Math.round(Math.atan2(ny, nx) / angleStep);
      // Allow for the pixel staircase along a diagonal edge in the reduced image.
      for (let offset = -12; offset <= 12; offset++) {
        const angle = (normal + offset + 2 * angleCount) % angleCount;
        const rho = cosines[angle] * (x - midX) + sines[angle] * (y - midY);
        votes[angle * stride + radius + Math.round(rho / rhoStep)] += 1 + Math.min(weight / 36, 1);
      }
    }
  }

  const peaks = [];
  const minimum = Math.max(13, Math.min(width, height) * .155);
  for (let angle = 0; angle < angleCount; angle++) {
    for (let bin = 1; bin < stride - 1; bin++) {
      const index = angle * stride + bin;
      const support = votes[index];
      if (support < minimum || support < votes[index - 1] || support < votes[index + 1]) continue;
      const nx = cosines[angle];
      const ny = sines[angle];
      const center = (bin - radius) * rhoStep;
      peaks.push({ nx, ny, center, rho: center + nx * midX + ny * midY, support });
    }
  }
  peaks.sort((a, b) => b.support - a.support);
  const lines = [];
  for (const peak of peaks) {
    let nearAngle = 0;
    let duplicate = false;
    for (const line of lines) {
      const dot = peak.nx * line.nx + peak.ny * line.ny;
      if (Math.abs(dot) > .976) nearAngle++;
      if (Math.abs(dot) > .995 && Math.abs(peak.center - Math.sign(dot) * line.center) < 5) {
        duplicate = true;
        break;
      }
    }
    if (!duplicate && nearAngle < 11) lines.push(peak);
    if (lines.length === 38) break;
  }
  return lines;
}

function intersection(a, b) {
  const determinant = a.nx * b.ny - a.ny * b.nx;
  if (Math.abs(determinant) < .3) return null;
  return [(a.rho * b.ny - a.ny * b.rho) / determinant, (a.nx * b.rho - a.rho * b.nx) / determinant];
}

function shape(points, width, height) {
  if (points.some((point) => !point || point[0] < 1 || point[0] > width - 2 || point[1] < 1 || point[1] > height - 2)) return null;
  let area = 0;
  const vectors = points.map(([x, y], i) => {
    const [nextX, nextY] = points[(i + 1) % 4];
    area += x * nextY - y * nextX;
    return [nextX - x, nextY - y];
  });
  const fraction = Math.abs(area) / (2 * width * height);
  if (fraction < .075 || fraction > .965) return null;
  const lengths = vectors.map(([x, y]) => Math.hypot(x, y));
  if (Math.min(...lengths) < Math.max(16, Math.min(width, height) * .105)) return null;
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    const [x, y] = vectors[i];
    const [nextX, nextY] = vectors[j];
    if (Math.sign(area) * (x * nextY - y * nextX) < .39 * lengths[i] * lengths[j]) return null;
    const opposite = lengths[(i + 2) % 4];
    if (lengths[i] < .43 * opposite) return null;
  }
  if (area < 0) points.reverse();
  let first = 0;
  for (let i = 1; i < 4; i++) {
    if (points[i][0] / width + points[i][1] / height < points[first][0] / width + points[first][1] / height) first = i;
  }
  return { points: points.slice(first).concat(points.slice(0, first)), fraction };
}

function candidates(lines, width, height) {
  const pairs = [];
  const minDistance = Math.min(width, height) * .12;
  for (let i = 0; i < lines.length; i++) {
    const a = lines[i];
    for (let j = i + 1; j < lines.length; j++) {
      const b = lines[j];
      const dot = a.nx * b.nx + a.ny * b.ny;
      if (Math.abs(dot) < .81 || Math.abs(a.center - Math.sign(dot) * b.center) < minDistance) continue;
      const nx = a.nx + Math.sign(dot) * b.nx;
      const ny = a.ny + Math.sign(dot) * b.ny;
      const length = Math.hypot(nx, ny);
      pairs.push({ a, b, nx: nx / length, ny: ny / length });
    }
  }
  const quads = [];
  for (let i = 0; i < pairs.length; i++) {
    const a = pairs[i];
    for (let j = i + 1; j < pairs.length; j++) {
      const b = pairs[j];
      if (Math.abs(a.nx * b.nx + a.ny * b.ny) > .72) continue;
      const quad = shape([intersection(a.a, b.a), intersection(a.b, b.a), intersection(a.b, b.b), intersection(a.a, b.b)], width, height);
      if (!quad) continue;
      const supports = [a.a.support, a.b.support, b.a.support, b.b.support];
      const priority = Math.sqrt(quad.fraction) +
        .6 * supports.reduce((sum, value) => sum + value, 0) / (width + height) +
        .5 * Math.min(...supports) / Math.min(width, height);
      quads.push({ ...quad, priority });
    }
  }
  return quads.sort((a, b) => b.priority - a.priority);
}

function sideEvidence(frame, start, end) {
  const { width, height, strength, directionX, directionY, planes } = frame;
  const [x0, y0] = start;
  const dx = end[0] - x0;
  const dy = end[1] - y0;
  const length = Math.hypot(dx, dy);
  const nx = -dy / length;
  const ny = dx / length;
  const samples = Math.min(38, Math.max(12, Math.round(length / 6)));
  const pixel = (x, y) => {
    const col = Math.min(width - 1, Math.max(0, Math.round(x)));
    const row = Math.min(height - 1, Math.max(0, Math.round(y)));
    return row * width + col;
  };
  let hits = 0;
  let contrast = 0;
  let brightness = 0;
  let polarity = 0;
  let sumT = 0;
  let sumT2 = 0;
  let sumOffset = 0;
  let sumProduct = 0;
  for (let i = 0; i < samples; i++) {
    const t = .07 + .86 * (i + .5) / samples;
    const x = x0 + t * dx;
    const y = y0 + t * dy;
    let position = 0;
    let strongest = 0;
    let index = -1;
    for (let shift = -4; shift <= 4; shift++) {
      const current = pixel(x + nx * shift, y + ny * shift);
      const aligned = Math.abs(nx * directionX[current] + ny * directionY[current]);
      const rank = strength[current] * aligned - .4 * Math.abs(shift);
      if (aligned > .8 && strength[current] >= 4 && rank > strongest) {
        strongest = rank;
        position = shift;
        index = current;
      }
    }
    if (index < 0) continue;
    const inner = pixel(x + nx * (position + 5), y + ny * (position + 5));
    const outer = pixel(x + nx * (position - 5), y + ny * (position - 5));
    const step = colorStep(planes, inner, outer);
    if (step < 5 || strength[index] < step * .22) continue;
    hits++;
    contrast += Math.min(1, step / 35);
    brightness += planes[0][inner] / 255;
    polarity += Math.sign(planes[0][inner] - planes[0][outer]);
    const offset = ((index % width) - x) * nx + (Math.floor(index / width) - y) * ny;
    sumT += t;
    sumT2 += t * t;
    sumOffset += offset;
    sumProduct += t * offset;
  }
  const variance = hits * sumT2 - sumT * sumT;
  const slope = variance > 1e-6 ? (hits * sumProduct - sumT * sumOffset) / variance : 0;
  const intercept = hits ? (sumOffset - slope * sumT) / hits : 0;
  const fitX = -dy - slope * ny;
  const fitY = dx + slope * nx;
  const fitLength = Math.hypot(fitX, fitY);
  const fx = fitX / fitLength;
  const fy = fitY / fitLength;
  const rho = fx * (x0 + nx * intercept) + fy * (y0 + ny * intercept);
  return {
    coverage: hits / samples,
    contrast: hits ? contrast / hits : 0,
    light: hits ? brightness / hits : 0,
    polarity: hits ? polarity / hits : 0,
    line: { nx: fx, ny: fy, rho }
  };
}

function distance(a, b) {
  // Compare the best cyclic alignment so a nearly diagonal corner does not change the distance.
  let best = Infinity;
  for (let offset = 0; offset < 4; offset++) {
    const squared = a.reduce((sum, [x, y], i) => {
      const [otherX, otherY] = b[(i + offset) % 4];
      return sum + (x - otherX) ** 2 + (y - otherY) ** 2;
    }, 0);
    best = Math.min(best, squared);
  }
  return Math.sqrt(best / 4);
}

export function findDocumentQuad(image) {
  const { width, height } = image;
  if (Math.min(width, height) < 32) return null;
  const frame = gradients(image);
  const lines = findLines(frame);
  if (lines.length < 4) return null;
  const checked = [];
  const accepted = [];
  for (const candidate of candidates(lines, width, height)) {
    if (checked.some((points) => distance(points, candidate.points) < 4)) continue;
    checked.push(candidate.points);
    const sides = candidate.points.map((point, index) => sideEvidence(frame, point, candidate.points[(index + 1) % 4]));
    const mean = (key) => sides.reduce((sum, side) => sum + side[key], 0) / 4;
    const minimum = Math.min(...sides.map((side) => side.coverage));
    const coverage = mean("coverage");
    const light = mean("light");
    const polarity = mean("polarity");
    const darkInset = light < .45 && polarity < -.65;
    if (minimum >= .44 && coverage >= .67 && !darkInset) {
      const score = .51 * coverage + .21 * minimum + .13 * mean("contrast") +
        .20 * Math.sqrt(candidate.fraction) + .08 * light + .045 * polarity;
      const refined = shape(sides.map((side, index) => intersection(sides[(index + 3) % 4].line, side.line)), width, height);
      const points = refined && distance(refined.points, candidate.points) < 7 ? refined.points : candidate.points;
      accepted.push({ points, score });
    }
    if (checked.length === 88) break;
  }
  accepted.sort((a, b) => b.score - a.score);
  const best = accepted[0];
  if (!best) return null;
  const ambiguous = accepted.some((other) => best.score - other.score < .035 &&
    distance(best.points, other.points) > Math.min(width, height) * .13);
  if (ambiguous) return null;
  return best.points.map(([x, y]) => [x / (width - 1), y / (height - 1)]);
}
