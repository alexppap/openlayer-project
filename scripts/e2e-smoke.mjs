// scripts/e2e-smoke.mjs — 页面冒烟测试（无框架、无 shell 拼接，跨平台，Node 18+ 全局 fetch）
// 运行前置：先 pnpm build 产出 dist/（本脚本只做 preview + fetch 断言，不负责构建）。
// 运行：node scripts/e2e-smoke.mjs
//
// 步骤：
//   1) 用 vite 编程 API preview() 基于 dist/ 启动预览服务器（host 127.0.0.1 + port 0，
//      由系统分配空闲端口，避免固定端口冲突，strictPort 无需启用）；
//   2) fetch 首页，断言 HTTP 200、HTML 包含应用挂载根节点 id="app"；
//   3) 从 HTML 提取全部带 src 的 <script> 入口，逐个 fetch，断言请求成功（2xx，非 404）；
//   4) 任何断言失败：console.error 打印原因并 process.exit(1)；结束前关闭服务器。
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { preview } from 'vite';

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST_DIR = join(PROJECT_ROOT, 'dist');
const SCRIPT_SRC_RE = /<script\b[^>]*\bsrc="([^"]+)"[^>]*>/gi;

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

// 关闭 preview 服务器（PreviewServer 无便捷 close，统一走底层 httpServer.close 回调）
const closeServer = (previewServer) =>
  new Promise((resolve, reject) => {
    previewServer.httpServer.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });

const main = async () => {
  if (!existsSync(DIST_DIR)) {
    fail(`页面冒烟失败：未找到 dist/（${DIST_DIR}），请先执行 pnpm build 再运行本脚本`);
  }

  const previewServer = await preview({
    root: PROJECT_ROOT,
    preview: { host: '127.0.0.1', port: 0 },
  });
  const { port } = previewServer.httpServer.address();
  const baseUrl = `http://127.0.0.1:${port}/`;

  try {
    // 断言 1：首页 HTTP 200
    const pageResponse = await fetch(baseUrl);
    assert.equal(
      pageResponse.status,
      200,
      `首页 ${baseUrl} HTTP 状态应为 200，实际为 ${pageResponse.status}`,
    );
    console.log(`  ✔ 首页可访问：HTTP 200（${baseUrl}）`);

    // 断言 2：HTML 包含应用挂载根节点 <div id="app">
    const html = await pageResponse.text();
    assert.ok(
      html.includes('id="app"'),
      '首页 HTML 应包含应用挂载根节点 <div id="app">，实际内容未命中',
    );
    console.log('  ✔ HTML 包含应用挂载根节点（id="app"）');

    // 断言 3：HTML 引用的全部 JS 入口均能请求成功（2xx，非 404）
    // 注意：vite preview 默认 appType 'spa' 对未命中路径做 history fallback（回退 index.html 返回 200），
    // 入口缺失时状态码不会是 404，因此额外断言 Content-Type 为 JS，防止被 fallback 骗过。
    const scriptSources = [...html.matchAll(SCRIPT_SRC_RE)].map((match) => match[1]);
    assert.ok(
      scriptSources.length > 0,
      '首页 HTML 应至少引用一个带 src 的 <script> 入口，实际未找到',
    );
    for (const src of scriptSources) {
      const scriptUrl = new URL(src, baseUrl).href;
      const scriptResponse = await fetch(scriptUrl);
      assert.ok(
        scriptResponse.ok,
        `JS 入口 ${scriptUrl} 应请求成功（2xx），实际 HTTP ${scriptResponse.status}`,
      );
      const contentType = scriptResponse.headers.get('content-type') ?? '';
      assert.ok(
        /javascript/i.test(contentType),
        `JS 入口 ${scriptUrl} 响应 Content-Type 应为 JS（实际「${contentType}」，疑似被 SPA fallback 回退为 HTML）`,
      );
      // 消费响应体，释放连接
      await scriptResponse.text();
      console.log(`  ✔ JS 入口可访问：${src}（HTTP ${scriptResponse.status}，${contentType}）`);
    }

    console.log(`\n页面冒烟全部通过（node scripts/e2e-smoke.mjs）`);
  } finally {
    // 无论断言成败，结束前关闭预览服务器
    await closeServer(previewServer);
  }
};

main().catch((error) => {
  console.error('页面冒烟失败：', error);
  process.exit(1);
});
