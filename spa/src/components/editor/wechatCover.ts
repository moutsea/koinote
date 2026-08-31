import type { WechatCoverRatio, WechatGeneratedCover } from "../../api";

export async function createDefaultWechatCover(
  title: string,
  ratio: WechatCoverRatio,
): Promise<WechatGeneratedCover | null> {
  const width = ratio === "1:1" ? 560 : 940;
  const height = ratio === "1:1" ? 560 : 400;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return null;

  const background = context.createLinearGradient(0, 0, width, height);
  background.addColorStop(0, "#f7f5ee");
  background.addColorStop(1, "#dcefe7");
  context.fillStyle = background;
  context.fillRect(0, 0, width, height);
  context.strokeStyle = "rgba(22, 101, 79, 0.18)";
  context.lineWidth = 2;
  context.strokeRect(18, 18, width - 36, height - 36);

  const logo = await loadWechatCoverLogo();
  const logoSize = ratio === "1:1" ? 128 : 104;
  const logoX = ratio === "1:1" ? (width - logoSize) / 2 : 58;
  const logoY = ratio === "1:1" ? 66 : (height - logoSize) / 2;
  if (logo) {
    context.drawImage(logo, logoX, logoY, logoSize, logoSize);
  } else {
    context.fillStyle = "#16654f";
    context.beginPath();
    context.arc(
      logoX + logoSize / 2,
      logoY + logoSize / 2,
      logoSize / 2,
      0,
      Math.PI * 2,
    );
    context.fill();
    context.fillStyle = "#f7f5ee";
    context.font = "700 42px system-ui, -apple-system, sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText("K", logoX + logoSize / 2, logoY + logoSize / 2 + 2);
  }

  const safeTitle = title.trim() || "Koinote";
  const titleSize = ratio === "1:1" ? 34 : 38;
  const titleMaxWidth =
    ratio === "1:1" ? width - 88 : width - logoX - logoSize - 88;
  const titleLines = wrapWechatCoverTitle(
    context,
    safeTitle,
    titleMaxWidth,
    titleSize,
    3,
  );
  context.fillStyle = "#163d31";
  context.font = `700 ${titleSize}px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  context.textBaseline = "middle";
  context.textAlign = ratio === "1:1" ? "center" : "left";
  const titleX = ratio === "1:1" ? width / 2 : logoX + logoSize + 42;
  const lineHeight = titleSize * 1.28;
  const titleCenterY = ratio === "1:1" ? 336 : height / 2;
  const firstLineY = titleCenterY - ((titleLines.length - 1) * lineHeight) / 2;
  titleLines.forEach((line, index) => {
    context.fillText(line, titleX, firstLineY + index * lineHeight);
  });

  context.fillStyle = "rgba(22, 101, 79, 0.7)";
  context.font =
    "600 14px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
  context.textAlign = ratio === "1:1" ? "center" : "left";
  context.fillText("KOINOTE", titleX, ratio === "1:1" ? 405 : height - 48);

  let dataUrl: string;
  try {
    dataUrl = canvas.toDataURL("image/jpeg", 0.9);
  } catch {
    return null;
  }
  const separator = dataUrl.indexOf(",");
  if (separator < 0) return null;
  return {
    base64: dataUrl.slice(separator + 1),
    mimeType: "image/jpeg",
    ratio,
    width,
    height,
  };
}

function loadWechatCoverLogo(): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    let settled = false;
    let timeout: number | undefined;
    const finish = (result: HTMLImageElement | null) => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) window.clearTimeout(timeout);
      resolve(result);
    };
    timeout = window.setTimeout(() => finish(null), 3000);
    image.onload = () => finish(image);
    image.onerror = () => finish(null);
    image.src = "/logo.png";
  });
}

function wrapWechatCoverTitle(
  context: CanvasRenderingContext2D,
  title: string,
  maxWidth: number,
  fontSize: number,
  maxLines: number,
): string[] {
  context.font = `700 ${fontSize}px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  const characters = Array.from(title);
  const lines: string[] = [];
  let offset = 0;
  while (offset < characters.length && lines.length < maxLines) {
    let line = "";
    while (offset < characters.length) {
      const candidate = line + characters[offset];
      if (line && context.measureText(candidate).width > maxWidth) break;
      line = candidate;
      offset += 1;
    }
    lines.push(line || characters[offset++] || "");
  }
  if (offset < characters.length && lines.length > 0) {
    let last = lines[lines.length - 1] ?? "";
    while (last && context.measureText(`${last}…`).width > maxWidth) {
      last = last.slice(0, -1);
    }
    lines[lines.length - 1] = `${last}…`;
  }
  return lines.length > 0 ? lines : ["Koinote"];
}
