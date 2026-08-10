/**
 * 微信导出前处理图片地址：绝对化，并判断是否公网可达。
 *
 * 为什么必须绝对化：未配 IMAGE_PUBLIC_BASE 时 Worker 返回的是相对地址
 * `/images/<key>`（见 worker/images.ts 的 publicURL）。相对地址写进剪贴板后，
 * 由谁来补全域名是不确定的 —— 取决于剪贴板的 HTML 里有没有 SourceURL、
 * 目标编辑器怎么解析。与其依赖这个行为，不如自己补成绝对地址：产物确定，
 * 且能在补全之后立刻判断这个地址到底通不通。
 *
 * 为什么还要判可达：补全用的是当前页面的源。本地开发时那就是 localhost，
 * 微信的服务器抓不到 —— 但粘贴的那一刻不会报错，要等文章预览时才看到裂图。
 * 这个判断把它提前到点「复制」的时候。
 *
 * 注意 isLocalHost 不是安全边界（真正的 SSRF 防护在 worker/ssrf.ts，那里要防
 * 十进制 IP、DNS rebinding 之类的绕过）。这里只是给用户的提示，覆盖开发环境
 * 实际会出现的几种地址就够了 —— 判漏的代价是少一条提示，不是漏一个洞。
 */

/** 私网与回环网段。169.254 是 link-local，容器/虚拟机里常见 */
function isPrivateIPv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const octets = parts.map((p) => Number(p));
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = octets;
  if (a === 127 || a === 0) return true;
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

/** 这个主机名是不是只在本机 / 内网可达 */
export function isLocalHost(host: string): boolean {
  const value = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!value) return true;
  if (value === "localhost" || value === "::1" || value === "::") return true;
  // 内网后缀：mDNS 的 .local、Docker/K8s 常用的 .internal
  if (/\.(local|internal|localhost|lan|home)$/.test(value)) return true;
  return isPrivateIPv4(value);
}

/**
 * 把 src 补成绝对地址。
 *
 * data: 与 blob: 原样返回：前者本来就自带内容不需要域名，后者只在本页面存活
 * （补域名也换不来可达性，而它是否出现在这里另说 —— 粘贴路径会先转存成上传）。
 * 解析失败也原样返回，宁可留一个原地址，也不要把 src 改成空串把图弄丢。
 */
export function absolutizeSrc(src: string, origin: string): string {
  const value = src.trim();
  if (!value) return value;
  if (/^(?:data|blob):/i.test(value)) return value;
  try {
    return new URL(value, origin).href;
  } catch {
    return value;
  }
}

/** 微信的服务器能不能抓到这个地址 */
export function isReachableByWechat(absoluteSrc: string): boolean {
  const value = absoluteSrc.trim();
  if (!value) return false;
  // data: 自带内容，不需要抓取。微信是否接受未经证实，但它不属于"抓不到"
  if (/^data:/i.test(value)) return true;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    // 到这一步还是相对地址，说明 absolutizeSrc 没解析成功 —— 微信无从抓取
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return !isLocalHost(url.hostname);
}

export type ImageAudit = {
  total: number;
  /** 改写成绝对地址的张数 */
  absolutized: number;
  /** 公网抓不到的张数。> 0 时粘到微信里会是裂图 */
  unreachable: number;
  /** 抓不到的那些地址的主机名，去重。用来在提示里说清楚是哪儿 */
  unreachableHosts: string[];
};

/**
 * 就地改写 root 里所有 img 的 src，并统计可达性。
 *
 * 用 getAttribute 而不是 img.src：后者返回浏览器解析过的绝对地址，那就分不清
 * 原本写的是相对还是绝对 —— absolutized 的计数会失真。
 */
export function auditWechatImages(root: HTMLElement, origin: string): ImageAudit {
  const images = Array.from(root.querySelectorAll<HTMLElement>("img"));
  const audit: ImageAudit = {
    total: images.length,
    absolutized: 0,
    unreachable: 0,
    unreachableHosts: [],
  };
  const hosts = new Set<string>();

  for (const img of images) {
    const original = img.getAttribute("src") ?? "";
    const absolute = absolutizeSrc(original, origin);
    if (absolute !== original) {
      img.setAttribute("src", absolute);
      audit.absolutized++;
    }
    if (!isReachableByWechat(absolute)) {
      audit.unreachable++;
      try {
        hosts.add(new URL(absolute).hostname || absolute);
      } catch {
        hosts.add(absolute);
      }
    }
  }

  audit.unreachableHosts = [...hosts];
  return audit;
}
