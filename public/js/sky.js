'use strict';
// 首页与登录页共用的动态星空画布：只依赖浏览器原生 API，可独立加载、不引用其他脚本。
(function () {
  var canvas = null;
  var ctx = null;
  var W = 0;
  var H = 0;
  var dpr = 1;
  var linkLen = 120;
  var particles = [];
  var meteors = [];
  var raf = null;
  var resizeTimer = null;
  var lastTime = 0;
  var nextMeteorAt = 0;
  var reduced = false;
  var active = false;

  function rand(a, b) { return a + Math.random() * (b - a); }

  function pickRgb() {
    var r = Math.random();
    if (r < 0.8) return '240,232,210';  // 暖白
    if (r < 0.95) return '212,169,90';  // 金
    return '224,84,63';                 // 朱红
  }

  function makeParticle() {
    return {
      x: Math.random() * W,
      y: Math.random() * H,
      r: rand(0.6, 1.8) * dpr,
      vx: rand(-0.08, 0.08) * dpr,
      vy: rand(-0.08, 0.08) * dpr,
      phase: Math.random() * Math.PI * 2,
      speed: rand(0.6, 1.6),
      rgb: pickRgb(),
    };
  }

  function measure() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = Math.round(window.innerWidth * dpr);
    H = Math.round(window.innerHeight * dpr);
    canvas.width = W;
    canvas.height = H;
    var count = Math.max(40, Math.min(110, Math.round(window.innerWidth * window.innerHeight / 14000)));
    particles = [];
    for (var i = 0; i < count; i++) particles.push(makeParticle());
    linkLen = (window.innerWidth < 600 ? 80 : 120) * dpr;
  }

  function step(dt) {
    var k = dt / 16.7;
    for (var i = 0; i < particles.length; i++) {
      var p = particles[i];
      p.x += p.vx * k;
      p.y += p.vy * k;
      if (p.x < 0) p.x += W; else if (p.x > W) p.x -= W;
      if (p.y < 0) p.y += H; else if (p.y > H) p.y -= H;
    }
  }

  function spawnMeteor(now) {
    var dx = rand(0.6, 1), dy = rand(0.35, 0.7);
    var len = Math.sqrt(dx * dx + dy * dy);
    meteors.push({
      x: rand(0.15, 0.85) * W,
      y: rand(-0.05, 0.1) * H,
      dx: dx / len,
      dy: dy / len,
      born: now,
      life: 800,
    });
  }

  function drawMeteors(now) {
    for (var i = meteors.length - 1; i >= 0; i--) {
      var m = meteors[i];
      var t = (now - m.born) / m.life;
      if (t >= 1) { meteors.splice(i, 1); continue; }
      var travel = t * Math.max(W, H) * 0.55;
      var hx = m.x + m.dx * travel;
      var hy = m.y + m.dy * travel;
      var tx = hx - m.dx * 120 * dpr;
      var ty = hy - m.dy * 120 * dpr;
      var g = ctx.createLinearGradient(hx, hy, tx, ty);
      g.addColorStop(0, 'rgba(255,240,210,.9)');
      g.addColorStop(1, 'rgba(255,240,210,0)');
      ctx.globalAlpha = Math.sin(Math.PI * t);
      ctx.lineWidth = 1.6 * dpr;
      ctx.strokeStyle = g;
      ctx.beginPath();
      ctx.moveTo(hx, hy);
      ctx.lineTo(tx, ty);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  function draw(now) {
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);
    var i, j, p, q, dx, dy, d, a;
    for (i = 0; i < particles.length; i++) {
      p = particles[i];
      a = 0.25 + (Math.sin(now * 0.001 * p.speed + p.phase) * 0.5 + 0.5) * 0.65;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(' + p.rgb + ',' + a.toFixed(3) + ')';
      ctx.fill();
    }
    ctx.lineWidth = 0.6 * dpr;
    for (i = 0; i < particles.length; i++) {
      p = particles[i];
      for (j = i + 1; j < particles.length; j++) {
        q = particles[j];
        dx = p.x - q.x;
        dy = p.y - q.y;
        d = Math.sqrt(dx * dx + dy * dy);
        if (d > 0 && d < linkLen) {
          ctx.strokeStyle = 'rgba(212,169,90,' + ((1 - d / linkLen) * 0.16).toFixed(3) + ')';
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(q.x, q.y);
          ctx.stroke();
        }
      }
    }
    if (!reduced) drawMeteors(now);
  }

  function frame(now) {
    raf = null;
    if (!active || document.hidden) return;
    var dt = Math.min(now - lastTime, 50);
    lastTime = now;
    step(dt);
    draw(now);
    if (now >= nextMeteorAt) {
      spawnMeteor(now);
      nextMeteorAt = now + rand(7000, 14000);
    }
    raf = window.requestAnimationFrame(frame);
  }

  function onVisibility() {
    if (document.hidden) {
      if (raf !== null) { window.cancelAnimationFrame(raf); raf = null; }
    } else if (active && !reduced && raf === null) {
      lastTime = performance.now();
      nextMeteorAt = lastTime + rand(7000, 14000);
      raf = window.requestAnimationFrame(frame);
    }
  }

  function onResize() {
    if (resizeTimer !== null) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      resizeTimer = null;
      if (!active || !canvas) return;
      measure();
      if (reduced) draw(0);
    }, 150);
  }

  function start(cv) {
    if (!cv) return;
    if (active && canvas === cv) return;  // 幂等：同一画布已在画就直接返回
    if (active) stop();
    canvas = cv;
    ctx = canvas.getContext('2d');
    if (!ctx) { canvas = null; return; }
    reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    meteors = [];
    measure();
    active = true;
    window.addEventListener('resize', onResize);
    document.addEventListener('visibilitychange', onVisibility);
    if (reduced) { draw(0); return; }  // 只画一帧静态星空与连线，不出流星
    lastTime = performance.now();
    nextMeteorAt = lastTime + rand(7000, 14000);
    raf = window.requestAnimationFrame(frame);
  }

  function stop() {
    active = false;
    if (raf !== null) { window.cancelAnimationFrame(raf); raf = null; }
    if (resizeTimer !== null) { clearTimeout(resizeTimer); resizeTimer = null; }
    window.removeEventListener('resize', onResize);
    document.removeEventListener('visibilitychange', onVisibility);
    if (ctx && W) ctx.clearRect(0, 0, W, H);
    meteors = [];
    canvas = null;
    ctx = null;
  }

  window.Sky = { start: start, stop: stop };
})();
