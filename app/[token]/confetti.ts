// A short confetti burst on a full-screen canvas. No dependency; sized for phones
// (fewer pieces on small screens, pixel ratio capped at 2) and skipped entirely
// when the reader asked for reduced motion.
const COLORS = ["#1f5eff", "#1a7f37", "#f5a524", "#e5484d", "#8e4ec6", "#12a594"];
const DURATION = 3500;

export function confetti() {
  if (typeof window === "undefined") return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  canvas.style.cssText = "position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:1000";
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    canvas.remove();
    return;
  }

  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const width = window.innerWidth;
  const height = window.innerHeight;
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  ctx.scale(ratio, ratio);

  // two bursts from the bottom corners, aimed up and inwards
  const count = width < 600 ? 90 : 160;
  const pieces = Array.from({ length: count }, (_, i) => {
    const left = i % 2 === 0;
    const angle = (left ? -60 : -120) * (Math.PI / 180) + (Math.random() - 0.5) * 0.9;
    const speed = height * (0.022 + Math.random() * 0.014);
    return {
      x: left ? 0 : width,
      y: height,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      size: 6 + Math.random() * 6,
      spin: Math.random() * Math.PI,
      spinSpeed: (Math.random() - 0.5) * 0.3,
      color: COLORS[i % COLORS.length],
    };
  });

  // velocities are per 60 Hz frame; step scales them so 120 Hz phones run at the same speed
  const start = performance.now();
  let last = start;
  const frame = (now: number) => {
    const t = now - start;
    const step = Math.min((now - last) / (1000 / 60), 3);
    const drag = 0.985 ** step;
    last = now;
    ctx.clearRect(0, 0, width, height);
    ctx.globalAlpha = t > DURATION - 800 ? Math.max(0, (DURATION - t) / 800) : 1;
    for (const p of pieces) {
      p.vx *= drag;
      p.vy = p.vy * drag + 0.25 * step;
      p.x += p.vx * step;
      p.y += p.vy * step;
      p.spin += p.spinSpeed * step;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.spin);
      ctx.fillStyle = p.color;
      // cos of the spin squashes the piece so it looks like it's flipping
      ctx.fillRect(-p.size / 2, -p.size / 4, p.size, (p.size / 2) * Math.cos(p.spin));
      ctx.restore();
    }
    if (t < DURATION) requestAnimationFrame(frame);
    else canvas.remove();
  };
  requestAnimationFrame(frame);
}
