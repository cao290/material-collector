/**
 * 验证码辅助（滑块拼图）
 *
 * 调研结论（2026-10-26）：
 * - MediaCrawler 等主流开源项目**不自动破解**抖音滑块，靠真实浏览器+登录态+代理池规避，验证时人工介入
 * - 字节滑块除缺口位置外还校验鼠标轨迹/时间/设备指纹，纯 OCR 识别缺口无法通过
 *
 * 实测关键（2026-10-26）：抖音验证码渲染在 **iframe** 里
 * （src 含 rmc.bytedance.com/verifycenter 或 verify.zijieapi.com），
 * 顶层文档 body 只有几个字节 → 必须穿透 iframe 才能探测到。
 *
 * 本模块只做「合规辅助」：
 * 1. 检测验证码（含 iframe 内），把页面搬到用户面前
 * 2. 抓取滑块图和背景图，算缺口位置给出视觉参考
 * 3. 不自动拖动（字节校验轨迹），不接打码平台
 */

/**
 * 在页面里探测验证码，支持跨 frame（同源 iframe 可访问 document）。
 * 注意：本脚本在**顶层文档**执行，通过 window.frames 尝试访问子 frame。
 */
export const CAPTCHA_PROBE_SCRIPT = String.raw`
(function () {
  var out = {
    found: false,
    kind: '',
    frameUrl: '',
    rect: null,
    sliderRect: null,
    bgSrc: '',
    sliderSrc: '',
    tip: '',
    source: ''
  };

  var HINTS = [
    '#captcha_container', '.captcha_verify_container', '[class*="captcha_verify"]',
    '[class*="captcha-container"]', '[id*="captcha"]', '.captcha', '[class*="vc-captcha"]',
    '[class*="verify-wrap"]', '[class*="captcha-body"]'
  ];

  function visible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    if (r.width < 80 || r.height < 60) return false;
    var st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
    return true;
  }

  // 在给定 document 里找验证码容器
  function scanDoc(doc, frameUrl) {
    for (var i = 0; i < HINTS.length; i++) {
      var list;
      try { list = doc.querySelectorAll(HINTS[i]); } catch (e) { continue; }
      for (var j = 0; j < list.length; j++) {
        var el = list[j];
        if (!visible(el)) continue;
        return { el: el, doc: doc, frameUrl: frameUrl };
      }
    }
    // 兜底：找含验证文案的容器
    try {
      var all = doc.querySelectorAll('div, section, form');
      for (var k = 0; k < all.length; k++) {
        var t = (all[k].innerText || '').trim();
        if (!t || t.length > 300) continue;
        if (!/请完成下列验证|按住左边按钮拖动|拖动完成上方拼图|请拖动滑块|验证后继续/.test(t)) continue;
        if (!visible(all[k])) continue;
        return { el: all[k], doc: doc, frameUrl: frameUrl };
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  // 1) 顶层文档
  var hit = scanDoc(document, location.href);

  // 2) 子 frame（同源才可访问）
  if (!hit) {
    var frames = [];
    try { frames = [].slice.call(window.frames); } catch (e) { frames = []; }
    for (var fi = 0; fi < frames.length && !hit; fi++) {
      var fdoc = null;
      var furl = '';
      try {
        fdoc = frames[fi].document;
        furl = frames[fi].location.href;
      } catch (e) { continue; } // 跨域，跳过
      if (fdoc) hit = scanDoc(fdoc, furl);
    }
  }

  // 3) 还没找到：检查有没有验证相关 iframe（哪怕访问不了内容，也说明存在验证）
  if (!hit) {
    var iframes = document.querySelectorAll('iframe');
    for (var ii = 0; ii < iframes.length; ii++) {
      var src = iframes[ii].src || '';
      if (/verifycenter|verify\.zijieapi|captcha/i.test(src)) {
        var ir = iframes[ii].getBoundingClientRect();
        out.found = true;
        out.kind = 'iframe';
        out.frameUrl = src;
        if (ir.width > 50 && ir.height > 50) {
          out.rect = { x: Math.round(ir.x), y: Math.round(ir.y), w: Math.round(ir.width), h: Math.round(ir.height) };
        }
        out.tip = '验证码在 iframe 内（需在面板中直接操作）';
        return JSON.stringify(out);
      }
    }
    return JSON.stringify(out);
  }

  var el = hit.el;
  var doc = hit.doc;
  var r = el.getBoundingClientRect();
  out.found = true;
  out.frameUrl = hit.frameUrl || '';
  out.rect = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  out.tip = (el.innerText || '').replace(/\s+/g, ' ').slice(0, 100);

  // 类型判断
  if (/按住左边按钮拖动|拖动完成上方拼图|请拖动滑块|滑动验证/.test(out.tip)) out.kind = 'slide';
  else if (/旋转|转到正方向/.test(out.tip)) out.kind = 'rotate';
  else if (/依次点击|按顺序点击/.test(out.tip)) out.kind = 'click';
  else out.kind = 'unknown';

  // 背景图/滑块图：canvas 优先
  try {
    var canvases = el.querySelectorAll('canvas');
    if (canvases.length >= 2) {
      out.bgSrc = canvases[0].toDataURL('image/png');
      out.sliderSrc = canvases[1].toDataURL('image/png');
      out.source = 'canvas';
    } else if (canvases.length === 1) {
      out.bgSrc = canvases[0].toDataURL('image/png');
      out.source = 'canvas1';
    }
  } catch (e) { /* 跨域 canvas */ }

  if (!out.bgSrc) {
    try {
      var imgs = [].slice.call(el.querySelectorAll('img')).filter(function (im) {
        var ir2 = im.getBoundingClientRect();
        return ir2.width > 50 && ir2.height > 30;
      });
      if (imgs.length) {
        out.bgSrc = imgs[0].src || '';
        if (imgs[1]) out.sliderSrc = imgs[1].src || '';
        out.source = 'img';
      }
    } catch (e) { /* ignore */ }
  }

  // 拖动按钮位置
  try {
    var handle = el.querySelector('[class*="slider"], [class*="btn"], [class*="handle"], [class*="bar"]');
    if (handle) {
      var hr = handle.getBoundingClientRect();
      if (hr.width > 10 && hr.height > 10) {
        out.sliderRect = { x: Math.round(hr.x), y: Math.round(hr.y), w: Math.round(hr.width), h: Math.round(hr.height) };
      }
    }
  } catch (e) { /* ignore */ }

  return JSON.stringify(out);
})()
`;

/**
 * 用 Node 侧解析：从 base64 图里找滑块缺口（边缘检测，纯 JS 实现，不依赖 Python）
 * 简化算法：在背景图上滑动滑块模板，找灰度差异最小的位置
 * @returns {number} 缺口左边缘 x 像素，失败返回 -1
 */
export function findGapOffset(bgGray, sliderGray, bgW, bgH, slW, slH) {
  if (!bgGray || !sliderGray) return -1;
  let bestX = -1;
  let bestScore = Infinity;
  const maxX = Math.max(0, bgW - slW);
  const step = 2; // 步长，兼顾速度
  const sx0 = Math.floor(slW * 0.1);
  const sy0 = Math.floor(slH * 0.1);
  const sx1 = Math.ceil(slW * 0.9);
  const sy1 = Math.ceil(slH * 0.9);

  for (let x = 0; x <= maxX; x += step) {
    let score = 0;
    let count = 0;
    for (let y = sy0; y < sy1; y += 3) {
      for (let px = sx0; px < sx1; px += 3) {
        const bgIdx = (y * bgW + (x + px)) * 4;
        const slIdx = (y * slW + px) * 4;
        if (sliderGray[slIdx + 3] < 128) continue;
        score += Math.abs(bgGray[bgIdx] - sliderGray[slIdx]);
        count += 1;
      }
    }
    if (!count) continue;
    const avg = score / count;
    if (avg < bestScore) {
      bestScore = avg;
      bestX = x;
    }
  }
  return bestX;
}
