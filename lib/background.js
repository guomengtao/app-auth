// lib/background.js — 统一的后台任务执行器
//
// 为什么需要它：Vercel 在响应返回后会冻结函数实例，直接 `promise.then(...)` 的「fire-and-forget」
// 有概率被中途掐断（写库/上报丢失）。`@vercel/functions` 的 `waitUntil` 能让平台保证任务跑完。
//
// 用法：`background.run(someAsyncTask())` —— 不要 await，调用方立刻继续。

var waitUntilFn = null;
try {
  var vf = require("@vercel/functions");
  if (vf && typeof vf.waitUntil === "function") waitUntilFn = vf.waitUntil;
} catch (e) {
  console.warn("[background] @vercel/functions 不可用，后台任务退化为 fire-and-forget");
}

function run(promise, label) {
  var p = Promise.resolve(promise).catch(function (e) {
    console.warn("[background] task failed" + (label ? " (" + label + ")" : "") + ":", e && e.message);
  });
  if (waitUntilFn) {
    try {
      waitUntilFn(p);
      return p;
    } catch (e) { /* 落到下面兜底 */ }
  }
  return p;
}

module.exports = { run: run, hasWaitUntil: Boolean(waitUntilFn) };
