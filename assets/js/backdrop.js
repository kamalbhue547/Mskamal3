// A subtle animated "constellation" behind the page: drifting dots joined by
// faint lines when they are close. It is purely decorative (the canvas is
// aria-hidden) and is deliberately well-behaved:
//   - respects prefers-reduced-motion (draws one still frame instead),
//   - pauses while the tab is hidden,
//   - caps the device pixel ratio and the number of dots,
//   - follows theme changes without being re-created.

const LINK_DISTANCE = 150;
const MAX_PIXEL_RATIO = 2;

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{ random?: () => number }} [options]
 * @returns {{ stop: () => void }}
 */
export function startBackdrop(canvas, { random = Math.random } = {}) {
  const doc = canvas.ownerDocument;
  const win = doc.defaultView;
  const context = canvas.getContext?.('2d');
  if (!context || !win) return { stop() {} };

  const reducedMotion = win.matchMedia?.('(prefers-reduced-motion: reduce)');
  let width = 0;
  let height = 0;
  const nodes = [];
  let frame = 0;
  let resizeTimer = 0;
  let color = '139, 123, 255';

  const readColor = () => {
    const value = win.getComputedStyle(doc.documentElement).getPropertyValue('--backdrop-rgb').trim();
    if (value) color = value;
  };

  const spawn = () => ({
    x: random() * width,
    y: random() * height,
    vx: (random() - 0.5) * 0.35,
    vy: (random() - 0.5) * 0.35,
    radius: 0.8 + random() * 1.4,
  });

  function draw() {
    context.clearRect(0, 0, width, height);
    context.lineWidth = 1;
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const distance = Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y);
        if (distance >= LINK_DISTANCE) continue;
        context.strokeStyle = `rgba(${color}, ${(1 - distance / LINK_DISTANCE) * 0.35})`;
        context.beginPath();
        context.moveTo(nodes[i].x, nodes[i].y);
        context.lineTo(nodes[j].x, nodes[j].y);
        context.stroke();
      }
    }
    context.fillStyle = `rgba(${color}, 0.7)`;
    for (const node of nodes) {
      context.beginPath();
      context.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
      context.fill();
    }
  }

  function step() {
    for (const node of nodes) {
      node.x += node.vx;
      node.y += node.vy;
      if (node.x < 0 || node.x > width) node.vx *= -1;
      if (node.y < 0 || node.y > height) node.vy *= -1;
    }
  }

  function loop() {
    step();
    draw();
    frame = win.requestAnimationFrame(loop);
  }

  const play = () => {
    if (!frame && !reducedMotion?.matches && !doc.hidden) frame = win.requestAnimationFrame(loop);
  };
  const pause = () => {
    if (frame) win.cancelAnimationFrame(frame);
    frame = 0;
  };

  function resize() {
    const ratio = Math.min(win.devicePixelRatio || 1, MAX_PIXEL_RATIO);
    width = win.innerWidth;
    height = win.innerHeight;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);

    const target = Math.max(14, Math.min(70, Math.round((width * height) / 24_000)));
    while (nodes.length < target) nodes.push(spawn());
    nodes.length = Math.min(nodes.length, target);
    for (const node of nodes) {
      node.x = Math.min(node.x, width);
      node.y = Math.min(node.y, height);
    }
    draw();
  }

  const onResize = () => {
    win.clearTimeout(resizeTimer);
    resizeTimer = win.setTimeout(resize, 120);
  };
  const onVisibility = () => (doc.hidden ? pause() : play());
  const onMotionChange = () => {
    if (reducedMotion.matches) {
      pause();
      draw();
    } else {
      play();
    }
  };
  const themeObserver = win.MutationObserver
    ? new win.MutationObserver(() => {
        readColor();
        if (!frame) draw();
      })
    : null;

  themeObserver?.observe(doc.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  doc.addEventListener('visibilitychange', onVisibility);
  reducedMotion?.addEventListener?.('change', onMotionChange);
  win.addEventListener('resize', onResize);

  readColor();
  resize();
  play();

  return {
    stop() {
      pause();
      win.clearTimeout(resizeTimer);
      themeObserver?.disconnect();
      doc.removeEventListener('visibilitychange', onVisibility);
      reducedMotion?.removeEventListener?.('change', onMotionChange);
      win.removeEventListener('resize', onResize);
    },
  };
}
