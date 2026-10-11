import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkles } from 'lucide-react';

const colors = ['#9577aa', '#c4acd6', '#3f6550', '#7fae86', '#e8b04a', '#f08a6b', '#7cb4d9'];
const duration = 4200;

type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: string;
  size: number;
  /** Seconds the particle has been alive; it fades out towards `life`. */
  age: number;
  life: number;
  gravity: number;
  drag: number;
} & (
  | {
      kind: 'confetti';
      shape: 'rect' | 'circle';
      rotation: number;
      spin: number;
      tilt: number;
      /** Paper flutters down slowly instead of dropping like a stone. */
      fall: number;
    }
  | { kind: 'spark'; px: number; py: number }
);

const random = (min: number, max: number) => min + Math.random() * (max - min);
const pick = <T,>(items: T[]) => items[Math.floor(Math.random() * items.length)]!;

function confettiCannon(x: number, height: number, direction: 1 | -1, count: number) {
  return Array.from({ length: count }, (): Particle => {
    // Shoot upwards and towards the middle, peaking between 10% and 65% of the screen height.
    const angle = (-90 + direction * random(10, 38)) * (Math.PI / 180);
    const speed = random(1.6, 2.9) * height;
    return {
      kind: 'confetti',
      shape: Math.random() < 0.7 ? 'rect' : 'circle',
      x,
      y: height,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      color: pick(colors),
      size: random(6, 11),
      age: 0,
      life: random(3.2, 4.1),
      gravity: 600,
      drag: 2,
      fall: random(100, 170),
      rotation: random(0, Math.PI * 2),
      spin: random(-12, 12),
      tilt: random(0, Math.PI * 2),
    };
  });
}

function firework(x: number, y: number, count: number, radius: number) {
  const color = pick(colors);
  return Array.from({ length: count }, (_, index): Particle => {
    const angle = (index / count) * Math.PI * 2 + random(-0.08, 0.08);
    // With this drag, a spark travels about speed / drag before it stops.
    const speed = random(0.65, 1) * radius * 2.2;
    return {
      kind: 'spark',
      x,
      y,
      px: x,
      py: y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      color: Math.random() < 0.25 ? '#e8b04a' : color,
      size: random(1.8, 2.8),
      age: 0,
      life: random(0.9, 1.4),
      gravity: 160,
      drag: 2.2,
    };
  });
}

function draw(context: CanvasRenderingContext2D, particle: Particle) {
  const fade = Math.max(
    0,
    1 - Math.max(0, particle.age - particle.life * 0.6) / (particle.life * 0.4),
  );
  context.globalAlpha = fade;
  context.fillStyle = context.strokeStyle = particle.color;
  if (particle.kind === 'spark') {
    context.lineWidth = particle.size;
    context.lineCap = 'round';
    context.beginPath();
    context.moveTo(particle.px, particle.py);
    context.lineTo(particle.x, particle.y);
    context.stroke();
    return;
  }
  context.save();
  context.translate(particle.x, particle.y);
  context.rotate(particle.rotation);
  // Squash one axis to suggest a paper strip flipping through the air.
  context.scale(1, Math.cos(particle.tilt));
  if (particle.shape === 'rect')
    context.fillRect(-particle.size / 2, -particle.size / 4, particle.size, particle.size / 2);
  else {
    context.beginPath();
    context.arc(0, 0, particle.size / 2.6, 0, Math.PI * 2);
    context.fill();
  }
  context.restore();
}

/** A short confetti and fireworks show with a level badge. It never blocks input. */
export function LevelUpCelebration({ level, onDone }: { level: number; onDone: () => void }) {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  useEffect(() => {
    const done = window.setTimeout(() => onDoneRef.current(), duration);
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context || window.matchMedia('(prefers-reduced-motion: reduce)').matches)
      return () => window.clearTimeout(done);
    let width = 0,
      height = 0;
    const resize = () => {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    };
    resize();
    window.addEventListener('resize', resize);
    // Phones get fewer particles and smaller bursts than large desktop screens.
    const density = Math.min(1, Math.max(0.55, width / 1200));
    const radius = Math.min(200, Math.max(95, Math.min(width, height) * 0.26));
    const particles: Particle[] = [];
    const launches = [
      ...[0, 0.45].map((at, wave) => ({
        at,
        launch: () => {
          const count = Math.round((wave ? 45 : 75) * density);
          particles.push(
            ...confettiCannon(0, height, 1, count),
            ...confettiCannon(width, height, -1, count),
          );
        },
      })),
      ...Array.from({ length: width < 700 ? 4 : 6 }, (_, index) => {
        const x = random(0.15, 0.85) * width,
          y = random(0.12, 0.42) * height;
        return {
          at: 0.15 + index * 0.34,
          launch: () => particles.push(...firework(x, y, Math.round(42 * density + 14), radius)),
        };
      }),
    ].sort((a, b) => a.at - b.at);
    let elapsed = 0,
      previous = performance.now(),
      frame = 0;
    const tick = (now: number) => {
      // Clamp long frames, e.g. after the tab was in the background.
      const dt = Math.min(0.05, (now - previous) / 1000);
      previous = now;
      elapsed += dt;
      while (launches.length && launches[0]!.at <= elapsed) launches.shift()!.launch();
      context.clearRect(0, 0, width, height);
      for (let index = particles.length - 1; index >= 0; index--) {
        const particle = particles[index]!;
        particle.age += dt;
        if (particle.age >= particle.life || particle.y > height + 40) {
          particles.splice(index, 1);
          continue;
        }
        const drag = Math.exp(-particle.drag * dt);
        particle.vx *= drag;
        particle.vy = particle.vy * drag + particle.gravity * dt;
        if (particle.kind === 'confetti') particle.vy = Math.min(particle.vy, particle.fall);
        if (particle.kind === 'spark') {
          particle.px = particle.x - particle.vx * 0.045;
          particle.py = particle.y - particle.vy * 0.045;
        } else {
          particle.rotation += particle.spin * dt;
          particle.tilt += particle.spin * 0.6 * dt;
          // Let slow confetti sway as it drifts down.
          particle.vx += Math.sin(particle.tilt) * 30 * dt;
        }
        particle.x += particle.vx * dt;
        particle.y += particle.vy * dt;
        draw(context, particle);
      }
      context.globalAlpha = 1;
      if (particles.length || launches.length) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      window.clearTimeout(done);
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', resize);
    };
  }, []);
  return (
    <div className="level-up">
      <canvas ref={canvasRef} className="level-up-canvas" aria-hidden="true" />
      <div className="level-up-card" role="status">
        <span className="level-up-kicker">
          <Sparkles size={16} aria-hidden="true" />
          {t('levelUp')}
        </span>
        <strong>{t('level', { level })}</strong>
        <span className="level-up-message">{t('levelUpMessage')}</span>
      </div>
    </div>
  );
}
