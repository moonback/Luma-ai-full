/**
 * Camera geometry for fixture localisation. Stage frame (metres): x across (negative = jardin, audience left),
 * y upstage (0 = stage front edge), z up (0 = floor). Pinhole camera, square pixels, principal point at the image
 * centre. Calibration from clicked reference points (at least the 4 floor corners of the stage): homography → focal
 * length → pose, then Levenberg–Marquardt refinement of pose + focal on every reference point.
 */
export type Vec2 = [number, number];
export type Vec3 = [number, number, number];

export interface Camera {
  width: number;
  height: number;
  f: number; // focal length in pixels
  cx: number;
  cy: number;
  /** World → camera rotation (row-major 3×3). */
  R: number[];
  t: Vec3;
}

export interface Ref {
  world: Vec3;
  image: Vec2;
}

/* ---------------- Small linear algebra ---------------- */

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mulMat = (R: number[], v: Vec3): Vec3 => [R[0]! * v[0] + R[1]! * v[1] + R[2]! * v[2], R[3]! * v[0] + R[4]! * v[1] + R[5]! * v[2], R[6]! * v[0] + R[7]! * v[1] + R[8]! * v[2]];
const mulMatT = (R: number[], v: Vec3): Vec3 => [R[0]! * v[0] + R[3]! * v[1] + R[6]! * v[2], R[1]! * v[0] + R[4]! * v[1] + R[7]! * v[2], R[2]! * v[0] + R[5]! * v[1] + R[8]! * v[2]];

/** Solves A x = b (n×n) by Gauss–Jordan elimination with partial pivoting; null if singular. */
export function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[p]![c]!)) p = r;
    if (Math.abs(M[p]![c]!) < 1e-12) return null;
    [M[c], M[p]] = [M[p]!, M[c]!];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const k = M[r]![c]! / M[c]![c]!;
      for (let j = c; j <= n; j++) M[r]![j] = M[r]![j]! - k * M[c]![j]!;
    }
  }
  return M.map((row, i) => row[n]! / row[i]!);
}

/** Rodrigues: rotation vector → row-major matrix. */
export function rodrigues(r: Vec3): number[] {
  const th = norm(r);
  if (th < 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const [x, y, z] = scale(r, 1 / th);
  const c = Math.cos(th), s = Math.sin(th), C = 1 - c;
  return [c + x * x * C, x * y * C - z * s, x * z * C + y * s, y * x * C + z * s, c + y * y * C, y * z * C - x * s, z * x * C - y * s, z * y * C + x * s, c + z * z * C];
}

export function rotationVector(R: number[]): Vec3 {
  const th = Math.acos(Math.max(-1, Math.min(1, (R[0]! + R[4]! + R[8]! - 1) / 2)));
  if (th < 1e-9) return [0, 0, 0];
  const k = th / (2 * Math.sin(th));
  return [(R[7]! - R[5]!) * k, (R[2]! - R[6]!) * k, (R[3]! - R[1]!) * k];
}

/* ---------------- Projection ---------------- */

/** World point → pixel; null when behind the camera. */
export function project(cam: Camera, P: Vec3): Vec2 | null {
  const c = add(mulMat(cam.R, P), cam.t);
  if (c[2] <= 1e-6) return null;
  return [cam.cx + (cam.f * c[0]) / c[2], cam.cy + (cam.f * c[1]) / c[2]];
}

export function cameraCenter(cam: Camera): Vec3 {
  return scale(mulMatT(cam.R, cam.t), -1);
}

/** Viewing ray of a pixel (unit direction, world frame). */
export function pixelRay(cam: Camera, p: Vec2): { origin: Vec3; dir: Vec3 } {
  const d = mulMatT(cam.R, [(p[0] - cam.cx) / cam.f, (p[1] - cam.cy) / cam.f, 1]);
  return { origin: cameraCenter(cam), dir: scale(d, 1 / norm(d)) };
}

/** Intersection of a ray with the horizontal plane z = h; null when parallel or behind. */
export function intersectHeight(ray: { origin: Vec3; dir: Vec3 }, h: number): Vec3 | null {
  if (Math.abs(ray.dir[2]) < 1e-9) return null;
  const s = (h - ray.origin[2]) / ray.dir[2];
  return s > 0 ? add(ray.origin, scale(ray.dir, s)) : null;
}

/** Least-squares point closest to all rays; `spread` = RMS distance from the point to the rays (metres). */
export function triangulate(rays: { origin: Vec3; dir: Vec3 }[]): { point: Vec3; spread: number } | null {
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const b = [0, 0, 0];
  for (const { origin: o, dir: d } of rays) {
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        const m = (i === j ? 1 : 0) - d[i]! * d[j]!;
        A[i]![j] = A[i]![j]! + m;
        b[i] = b[i]! + m * o[j]!;
      }
    }
  }
  const x = solve(A, b);
  if (!x) return null;
  const point = x as Vec3;
  const dist = rays.map(({ origin, dir }) => {
    const v = sub(point, origin);
    return norm(sub(v, scale(dir, dot(v, dir))));
  });
  return { point, spread: Math.sqrt(dist.reduce((s, d) => s + d * d, 0) / dist.length) };
}

/* ---------------- Calibration ---------------- */

/** Homography (world floor XY → image) by DLT with h33 = 1 (least squares for > 4 points). */
export function homography(world: Vec2[], image: Vec2[]): number[] | null {
  const A: number[][] = Array.from({ length: 8 }, () => new Array<number>(8).fill(0));
  const b = new Array<number>(8).fill(0);
  world.forEach(([X, Y], i) => {
    const [u, v] = image[i]!;
    const rows: [number[], number][] = [[[X, Y, 1, 0, 0, 0, -u * X, -u * Y], u], [[0, 0, 0, X, Y, 1, -v * X, -v * Y], v]];
    for (const [r, y] of rows) for (let p = 0; p < 8; p++) {
      for (let q = 0; q < 8; q++) A[p]![q] = A[p]![q]! + r[p]! * r[q]!;
      b[p] = b[p]! + r[p]! * y;
    }
  });
  const h = solve(A, b);
  return h ? [...h, 1] : null;
}

function reprojection(cam: Camera, refs: Ref[]): number[] {
  const r: number[] = [];
  for (const ref of refs) {
    const p = project(cam, ref.world);
    if (!p) { r.push(1e3, 1e3); continue; }
    r.push(p[0] - ref.image[0], p[1] - ref.image[1]);
  }
  return r;
}

/** Levenberg–Marquardt with a numerical Jacobian (small problems: ≤ 7 parameters). */
function levenberg(p0: number[], residuals: (p: number[]) => number[], iterations = 100): number[] {
  let p = [...p0], r = residuals(p), cost = r.reduce((s, x) => s + x * x, 0), lambda = 1e-3;
  for (let it = 0; it < iterations && cost > 1e-12; it++) {
    const J = p.map((_, k) => {
      const step = Math.max(1e-7, Math.abs(p[k]!) * 1e-6);
      const q = [...p];
      q[k] = q[k]! + step;
      return residuals(q).map((x, i) => (x - r[i]!) / step);
    });
    const n = p.length;
    const JtJ = Array.from({ length: n }, (_, a) => Array.from({ length: n }, (_, c) => J[a]!.reduce((s, x, i) => s + x * J[c]![i]!, 0)));
    const Jtr = J.map((col) => col.reduce((s, x, i) => s + x * r[i]!, 0));
    let improved = false;
    for (let tries = 0; tries < 12 && !improved; tries++) {
      const M = JtJ.map((row, a) => row.map((x, c) => (a === c ? x * (1 + lambda) + 1e-12 : x)));
      const d = solve(M, Jtr.map((x) => -x));
      if (d) {
        const q = p.map((x, k) => x + d[k]!);
        const rq = residuals(q);
        const cq = rq.reduce((s, x) => s + x * x, 0);
        if (cq < cost) {
          improved = cost - cq > 1e-14 * cost;
          p = q; r = rq; cost = cq;
          lambda = Math.max(1e-12, lambda / 10);
          break;
        }
      }
      lambda *= 10;
    }
    if (!improved) break;
  }
  return p;
}

export interface Calibration {
  camera: Camera;
  /** RMS reprojection error of the reference points (pixels). */
  rms: number;
}

/**
 * Calibrates from reference points. At least 4 must lie on the floor (z = 0, e.g. the stage corners); others (marks
 * on a truss at a known height) improve the fit. `focalPx` overrides the focal estimate (a fronto-parallel view makes
 * it unobservable from the floor homography alone).
 */
export function calibrate(refs: Ref[], width: number, height: number, focalPx?: number): Calibration {
  const floor = refs.filter((r) => Math.abs(r.world[2]) < 1e-6);
  if (floor.length < 4) throw new Error('Il faut au moins 4 points au sol (les coins du plateau)');
  const cx = width / 2, cy = height / 2;
  const H = homography(floor.map((r) => [r.world[0], r.world[1]]), floor.map((r) => [r.image[0] - cx, r.image[1] - cy]));
  if (!H) throw new Error('Points de référence dégénérés (alignés ?)');
  const [h11, h12, h13, h21, h22, h23, h31, h32, h33] = H as [number, number, number, number, number, number, number, number, number];
  let f = focalPx ?? 0;
  if (!f) {
    // ω = diag(1/f², 1/f², 1): h1ᵀωh2 = 0 and h1ᵀωh1 = h2ᵀωh2, least squares in x = 1/f².
    const a1 = h11 * h12 + h21 * h22, b1 = h31 * h32;
    const a2 = h11 * h11 + h21 * h21 - h12 * h12 - h22 * h22, b2 = h31 * h31 - h32 * h32;
    const x = -(a1 * b1 + a2 * b2) / (a1 * a1 + a2 * a2);
    f = x > 0 ? 1 / Math.sqrt(x) : width;
    if (!Number.isFinite(f) || f < width * 0.3 || f > width * 6) f = width; // degenerate: ≈ 53° horizontal field of view
  }
  const Kinv = (v: Vec3): Vec3 => [v[0] / f, v[1] / f, v[2]];
  let r1 = Kinv([h11, h21, h31]), r2 = Kinv([h12, h22, h32]);
  let lambda = 2 / (norm(r1) + norm(r2));
  let t = scale(Kinv([h13, h23, h33]), lambda);
  if (t[2] < 0) { lambda = -lambda; t = scale(t, -1); }
  r1 = scale(r1, lambda);
  r2 = scale(r2, lambda);
  // Gram–Schmidt to a proper rotation.
  const e1 = scale(r1, 1 / norm(r1));
  const r2o = sub(r2, scale(e1, dot(r2, e1)));
  const e2 = scale(r2o, 1 / norm(r2o));
  const e3 = cross(e1, e2);
  const R0 = [e1[0], e2[0], e3[0], e1[1], e2[1], e3[1], e1[2], e2[2], e3[2]];
  const cam = (p: number[]): Camera => ({ width, height, cx, cy, f: focalPx ?? p[6]!, R: rodrigues([p[0]!, p[1]!, p[2]!]), t: [p[3]!, p[4]!, p[5]!] });
  const p0 = [...rotationVector(R0), ...t, f];
  const p = levenberg(focalPx ? p0.slice(0, 6) : p0, (q) => reprojection(cam(q), refs));
  const camera = cam(p);
  const r = reprojection(camera, refs);
  return { camera, rms: Math.sqrt(r.reduce((s, x) => s + x * x, 0) / refs.length) };
}

/** Stage corners on the floor, in the click order used by the UI. */
export function stageCorners(width: number, depth: number): { label: string; world: Vec3 }[] {
  return [
    { label: 'Avant jardin (bord du plateau, à gauche vu de la salle)', world: [-width / 2, 0, 0] },
    { label: 'Avant cour (bord du plateau, à droite vu de la salle)', world: [width / 2, 0, 0] },
    { label: 'Fond cour', world: [width / 2, depth, 0] },
    { label: 'Fond jardin', world: [-width / 2, depth, 0] },
  ];
}

/** Synthetic camera looking from `eye` at `target` (tests and previews). */
export function lookAt(eye: Vec3, target: Vec3, width: number, height: number, hfovDeg: number): Camera {
  const fwd = sub(target, eye);
  const zc = scale(fwd, 1 / norm(fwd));
  let xc = cross(zc, [0, 0, 1]); // image x to the right
  xc = scale(xc, 1 / norm(xc));
  const yc = cross(zc, xc); // image y down
  const R = [...xc, ...yc, ...zc];
  const f = width / 2 / Math.tan((hfovDeg * Math.PI) / 360);
  return { width, height, f, cx: width / 2, cy: height / 2, R, t: scale(mulMat(R, eye), -1) };
}
