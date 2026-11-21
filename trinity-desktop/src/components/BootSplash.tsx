import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { isTauriRuntime } from '../services/core-config';

/** The panel decides when the finale starts; this is the minimum dance first. */
const MIN_ORBIT_MS = 2800;
const MAX_WAIT_MS = 15000;

interface Sun {
  /** Semi-axes, in units of the visible half-height. */
  a: number;
  b: number;
  omega: number;
  tilt: number;
  phase: number;
  color: [number, number, number];
  trail: Array<[number, number]>;
}

/**
 * The animation floats on the desktop in a transparent window and keeps
 * orbiting until the hidden main panel reports that it is ready — the collapse
 * is not on a fixed clock, so a slow machine simply gets more laps.
 */
export function BootSplash({ onFinish }: { onFinish?: () => void }) {
  const [quake, setQuake] = useState(false);
  const [word, setWord] = useState(false);
  const [burst, setBurst] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const finishedRef = useRef(false);
  const finishRef = useRef(onFinish);
  const timers = useRef<number[]>([]);
  const startedMs = useRef(performance.now());
  const finaleAtRef = useRef<number | null>(null);

  finishRef.current = onFinish;

  const finish = (): void => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    finishRef.current?.();
  };

  /** Called by the main window (or the safety timer); starts the last act. */
  const beginFinale = (): void => {
    if (finaleAtRef.current !== null) return;

    const now = performance.now();
    const start = Math.max(now, startedMs.current + MIN_ORBIT_MS);
    finaleAtRef.current = start;

    const base = start - now;
    timers.current.push(
      window.setTimeout(() => setQuake(true), base + 300),
      window.setTimeout(() => setWord(true), base + 1100),
      window.setTimeout(() => setBurst(true), base + 1850),
      window.setTimeout(finish, base + 2070),
    );
  };

  useEffect(() => {
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

    const onKeyDown = (): void => finish();
    window.addEventListener('keydown', onKeyDown);

    if (reduce) {
      timers.current.push(
        window.setTimeout(() => setWord(true), 300),
        window.setTimeout(finish, 1200),
      );

      return () => {
        for (const id of timers.current) window.clearTimeout(id);
        window.removeEventListener('keydown', onKeyDown);
      };
    }

    let stopListening: (() => void) | null = null;
    let maxWait = 0;

    if (isTauriRuntime()) {
      void listen('trinity-main-ready', () => beginFinale()).then((stop) => {
        stopListening = stop;
      });
      maxWait = window.setTimeout(beginFinale, MAX_WAIT_MS);
    } else {
      // Browser preview has no main window to wait for.
      maxWait = window.setTimeout(beginFinale, 2500);
    }

    return () => {
      for (const id of timers.current) window.clearTimeout(id);
      timers.current = [];
      window.clearTimeout(maxWait);
      stopListening?.();
      window.removeEventListener('keydown', onKeyDown);
    };
    // finish/beginFinale only read refs and call stable setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const canvas = canvasRef.current;
    const ctx = canvas === null ? null : canvas.getContext('2d');
    if (canvas === null || ctx === null || reduce) return;

    let width = 0;
    let height = 0;
    let dpr = 1;
    let frame = 0;
    let alive = true;
    const startedAt = startedMs.current;

    const resize = (): void => {
      const rect = canvas.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      width = Math.max(1, rect.width);
      height = Math.max(1, rect.height);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    resize();
    window.addEventListener('resize', resize);

    const suns: Sun[] = [
      { a: 0.4, b: 0.26, omega: 7, tilt: 0.32, phase: 0, color: [255, 211, 130], trail: [] },
      { a: 0.56, b: 0.42, omega: -5.8, tilt: -0.64, phase: 2.2, color: [255, 128, 84], trail: [] },
      { a: 0.68, b: 0.38, omega: 4.8, tilt: 1.18, phase: 4.4, color: [156, 199, 255], trail: [] },
    ];

    const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

    const position = (sun: Sun, warped: number, contract: number): [number, number] => {
      const angle = warped * sun.omega + sun.phase;
      const tilt = sun.tilt + warped * 0.08;
      const breathe = 1 + 0.05 * Math.sin(warped * 0.37 + sun.phase);
      const ex = Math.cos(angle) * sun.a * breathe * contract;
      const ey = Math.sin(angle) * sun.b * breathe * contract;

      const wx = Math.cos(warped * 0.23 + sun.phase) * 0.05 * contract;
      const wy = Math.sin(warped * 0.19 + sun.phase * 1.7) * 0.045 * contract;

      return [
        ex * Math.cos(tilt) - ey * Math.sin(tilt) + wx,
        ex * Math.sin(tilt) + ey * Math.cos(tilt) + wy,
      ];
    };

    const draw = (now: number): void => {
      const t = (now - startedAt) / 1000;
      const finaleAt = finaleAtRef.current;
      const after = finaleAt === null ? 0 : Math.max(0, (now - finaleAt) / 1000);
      const finality = clamp01(after / 0.6);
      const warped = t + 1.4 * Math.pow(after, 1.5);
      const contract = 1 - 0.9 * Math.pow(finality, 1.15);

      const min = Math.min(width, height);
      const cx = width / 2;
      const cy = height * 0.48;
      const zoom = 0.96 + Math.min(1, t / 4) * 0.12;
      const scale = min * 0.62 * zoom;

      ctx.clearRect(0, 0, width, height);

      // Tremor: builds as the core forms and stays violent until the burst.
      const quake = clamp01((after - 0.3) / 0.4);
      const amp = 52 * quake * quake;

      ctx.save();
      ctx.translate(
        (Math.random() - 0.5) * 2 * amp,
        (Math.random() - 0.5) * 2 * amp,
      );

      for (const sun of suns) {
        const point = position(sun, warped, contract);
        sun.trail.push(point);
        if (sun.trail.length > 42) sun.trail.shift();
      }

      // World coordinates are centred on the scene, not on the canvas corner.
      ctx.save();
      ctx.translate(cx, cy);

      for (const sun of suns) {
        const points = sun.trail;
        const [r, g, b] = sun.color;

        for (let k = 1; k < points.length; k += 1) {
          const [ax, ay] = points[k - 1] as [number, number];
          const [bx, by] = points[k] as [number, number];
          const fade = k / points.length;

          // Source-over, not additive: the desktop underneath may be bright,
          // where additive light would wash straight out to white.
          ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${0.06 + fade * 0.72})`;
          ctx.lineWidth = 0.9 + fade * 3.2;
          ctx.beginPath();
          ctx.moveTo(ax * scale, ay * scale);
          ctx.lineTo(bx * scale, by * scale);
          ctx.stroke();
        }
      }

      for (const sun of suns) {
        const [wx, wy] = position(sun, warped, contract);
        const bx = wx * scale;
        const by = wy * scale;
        const [r, g, b] = sun.color;

        const haloR = min * 0.16;
        const halo = ctx.createRadialGradient(bx, by, 0, bx, by, haloR);
        halo.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0.42)`);
        halo.addColorStop(0.28, `rgba(${r}, ${g}, ${b}, 0.12)`);
        halo.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
        ctx.fillStyle = halo;
        ctx.beginPath();
        ctx.arc(bx, by, haloR, 0, Math.PI * 2);
        ctx.fill();

        const coreR = min * 0.032;
        const core = ctx.createRadialGradient(bx, by, 0, bx, by, coreR);
        core.addColorStop(0, 'rgba(255, 255, 255, 0.95)');
        core.addColorStop(0.16, `rgba(${r}, ${g}, ${b}, 1)`);
        core.addColorStop(0.62, `rgba(${r}, ${g}, ${b}, 0.85)`);
        core.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
        ctx.fillStyle = core;
        ctx.beginPath();
        ctx.arc(bx, by, coreR, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.restore();

      // The three are pulled into one white core, brightening until the burst.
      const coreIn = clamp01((after - 0.5) / 0.45);
      if (coreIn > 0.01) {
        const pulse = 1 + 0.05 * Math.sin(t * 38);
        const orbR = min * (0.015 + 0.1 * coreIn * coreIn) * pulse;

        const bloom = ctx.createRadialGradient(cx, cy, 0, cx, cy, orbR * 3.4);
        bloom.addColorStop(0, `rgba(255, 255, 255, ${0.95 * coreIn})`);
        bloom.addColorStop(0.18, `rgba(235, 244, 255, ${0.7 * coreIn})`);
        bloom.addColorStop(0.45, `rgba(170, 200, 255, ${0.28 * coreIn})`);
        bloom.addColorStop(1, 'rgba(120, 160, 255, 0)');
        ctx.fillStyle = bloom;
        ctx.beginPath();
        ctx.arc(cx, cy, orbR * 3.4, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = `rgba(255, 255, 255, ${coreIn})`;
        ctx.beginPath();
        ctx.arc(cx, cy, orbR, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.restore();
    };

    const loop = (now: number): void => {
      if (!alive) return;
      draw(now);
      frame = window.requestAnimationFrame(loop);
    };

    frame = window.requestAnimationFrame(loop);

    return () => {
      alive = false;
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', resize);
    };
  }, []);

  return (
    <div className="boot-splash is-window" role="presentation" onClick={finish}>
      <canvas className="boot-canvas" ref={canvasRef} />

      <div className="boot-word-wrap" data-quake={quake}>
        {word ? (
          <div className="boot-word">
            <div className="boot-title">TRINITY</div>
            <div className="boot-sub">CLAUDE · CODEX · DEEPSEEK</div>
          </div>
        ) : null}
      </div>

      {burst ? <div className="boot-burst" /> : null}

      <div className="boot-skip">点击或按任意键跳过</div>
    </div>
  );
}
