import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/postcss";
import { copyFile, mkdir, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import type { PluginOption, ProxyOptions } from "vite";

const rootDir = dirname(fileURLToPath(import.meta.url));

/**
 * KaTeX 的 CSS 用相对路径引字体（`url(fonts/KaTeX_*.woff2)`）。
 * 产物 CSS 落在 /assets/ 下，这些相对路径便解析为 /assets/fonts/，
 * 但 Vite 不会自动把 node_modules 里的字体搬过去 —— 不处理就全部 404，
 * 公式会退化成后备字体，看起来"能显示但不对"。
 *
 * 从 node_modules 复制而非提交进 public/：包升级时字体自动跟着变，
 * 不会留下一份静默过期的副本。
 */
function copyKatexFonts(): PluginOption {
  return {
    name: "koinote:copy-katex-fonts",
    apply: "build",
    async closeBundle() {
      const source = resolve(rootDir, "node_modules/katex/dist/fonts");
      const target = resolve(rootDir, "spa/dist/assets/fonts");
      try {
        await mkdir(target, { recursive: true });
        const files = await readdir(source);
        // 只搬 woff2：现代浏览器全支持，且是 CSS 里的首选格式。
        // woff/ttf 会 404，但浏览器已用 woff2 渲染完成，不影响显示。
        const woff2 = files.filter((f) => f.endsWith(".woff2"));
        await Promise.all(
          woff2.map((f) => copyFile(join(source, f), join(target, f))),
        );
        console.log(`[katex] 已复制 ${woff2.length} 个字体到 assets/fonts`);
      } catch (err) {
        // 字体缺失不该让构建失败，但必须喊出来
        console.warn("[katex] 字体复制失败，公式将使用后备字体:", err);
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, rootDir, "");
  const backendURL =
    env.BACKEND_URL ||
    env.VITE_BACKEND_URL ||
    `http://localhost:${env.BACKEND_PORT || "8080"}`;
  const internalToken = env.BACKEND_INTERNAL_TOKEN || "";

  // dev 时把 /api、/health 转发到本地 Go 后端；剥掉外部可伪造的鉴权头，
  // 需要时补上后端内部令牌，模拟生产环境下 Worker 的行为。
  const backendProxy: ProxyOptions = {
    target: backendURL,
    changeOrigin: false,
    configure(proxy) {
      proxy.on("proxyReq", (proxyReq) => {
        proxyReq.removeHeader("x-auth-user-id");
        proxyReq.removeHeader("x-koinote-internal-token");
        if (internalToken) {
          proxyReq.setHeader("x-koinote-internal-token", internalToken);
        }
      });
    },
  };

  // 图片上传只存在于 Worker（R2 绑定在那儿），Go 后端没有这个端点。
  // 本地把 /api/images 与 /images 转给 wrangler dev，这样 5273 也能测上传，
  // 不必切到 8788 去换取 HMR。wrangler 没起时这两条会连接被拒。
  const workerProxy: ProxyOptions = {
    target: env.WORKER_URL || "http://localhost:8788",
    changeOrigin: false,
  };

  return {
    root: "spa",
    publicDir: resolve(rootDir, "public"),
    plugins: [react(), copyKatexFonts()],
    css: {
      transformer: "postcss",
      postcss: {
        plugins: [tailwindcss()],
      },
    },
    resolve: {
      alias: {
        "@spa": resolve(rootDir, "spa/src"),
      },
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
      rollupOptions: {
        output: {
          // 把不常变动的框架底子拆成独立 vendor chunk：
          // 业务代码更新时，用户浏览器仍能命中 vendor 缓存，无需重下框架。
          manualChunks: {
            "react-vendor": ["react", "react-dom"],
            "router-vendor": ["@tanstack/react-router", "@tanstack/react-query"],
          },
        },
      },
    },
    server: {
      // 端口由 .env 的 DEV_PORT 统一控制，需与 APP_URL / OAuth 回调地址保持一致。
      // strictPort 必须开：端口被占时宁可启动失败，也不能静默递增——
      // 否则 provider 按登记的端口回跳会打到空端口，报错还查不出来。
      port: Number(env.DEV_PORT || 5273),
      strictPort: true,
      // Vite 按最长前缀优先匹配，所以 /api/images 会胜过 /api。
      // 图片相关两条转给 wrangler（Worker 才有 R2 绑定），其余仍走 Go 后端。
      proxy: {
        "/api/images": workerProxy,
        "/images": workerProxy,
        "/api": backendProxy,
        "/health": backendProxy,
      },
    },
  };
});
