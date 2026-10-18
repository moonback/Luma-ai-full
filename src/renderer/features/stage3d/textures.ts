import * as THREE from 'three';

/** Procedural canvas textures (no image assets): soft light pool and a few generic gobo patterns. */

function canvasTexture(size: number, draw: (g: CanvasRenderingContext2D, s: number) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  draw(g, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function softDisc(g: CanvasRenderingContext2D, s: number): void {
  const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.55, 'rgba(255,255,255,0.85)');
  grad.addColorStop(0.85, 'rgba(255,255,255,0.25)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, s, s);
}

/** Generic gobo shapes cut out of the soft pool (index 1..n, wraps around). */
const GOBOS: ((g: CanvasRenderingContext2D, s: number) => void)[] = [
  (g, s) => { // dots
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      g.beginPath();
      g.arc(s / 2 + Math.cos(a) * s * 0.28, s / 2 + Math.sin(a) * s * 0.28, s * 0.07, 0, Math.PI * 2);
      g.fill();
    }
    g.beginPath();
    g.arc(s / 2, s / 2, s * 0.08, 0, Math.PI * 2);
    g.fill();
  },
  (g, s) => { // star
    g.beginPath();
    for (let i = 0; i < 10; i++) {
      const r = i % 2 ? s * 0.16 : s * 0.42;
      const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
      g.lineTo(s / 2 + Math.cos(a) * r, s / 2 + Math.sin(a) * r);
    }
    g.closePath();
    g.fill();
  },
  (g, s) => { // bars
    for (let i = 0; i < 5; i++) g.fillRect(s * (0.14 + i * 0.16), s * 0.1, s * 0.08, s * 0.8);
  },
  (g, s) => { // rings
    g.lineWidth = s * 0.06;
    for (const r of [0.12, 0.25, 0.38]) {
      g.beginPath();
      g.arc(s / 2, s / 2, s * r, 0, Math.PI * 2);
      g.stroke();
    }
  },
  (g, s) => { // breakup
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 26; i++) {
      g.beginPath();
      g.ellipse(s * (0.15 + rnd() * 0.7), s * (0.15 + rnd() * 0.7), s * (0.03 + rnd() * 0.07), s * (0.02 + rnd() * 0.05), rnd() * Math.PI, 0, Math.PI * 2);
      g.fill();
    }
  },
];

let cache: { pool: THREE.Texture; gobos: THREE.Texture[] } | null = null;

export function textures(): { pool: THREE.Texture; gobo: (index: number) => THREE.Texture } {
  if (!cache) {
    const pool = canvasTexture(256, softDisc);
    const gobos = GOBOS.map((draw) =>
      canvasTexture(256, (g, s) => {
        softDisc(g, s);
        // Keep light only inside the gobo shape.
        g.globalCompositeOperation = 'destination-in';
        g.fillStyle = '#fff';
        g.strokeStyle = '#fff';
        draw(g, s);
      }),
    );
    cache = { pool, gobos };
  }
  const c = cache;
  return { pool: c.pool, gobo: (i) => c.gobos[(i - 1) % c.gobos.length] ?? c.pool };
}

export function disposeTextures(): void {
  cache?.pool.dispose();
  cache?.gobos.forEach((t) => t.dispose());
  cache = null;
}
