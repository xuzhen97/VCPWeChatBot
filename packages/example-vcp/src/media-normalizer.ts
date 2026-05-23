import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { NormalizedWechatReply, ParsedAssistantResult } from "./types.js";

/**
 * 微信侧最终只接受“文本 + 媒体”这一小撮稳定形态。
 * 这个模块负责把解析后的 VCP 结果压缩成微信 SDK 能直接发送的结构。
 */
const OUTBOUND_MEDIA_DIR = path.join(os.tmpdir(), "openclaw", "example-vcp-outbound-media");
const OUTBOUND_MEDIA_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const OUTBOUND_MEDIA_CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
let lastCleanupAt = 0;

/**
 * 微信发送媒体时更适合落地成真实文件路径。
 * 所以当上游给的是 data URI，这里先转存成临时文件，再交给微信 SDK 发送。
 */
function persistDataUriToTempFile(dataUri: string): { filePath: string; mimeType: string } | null {
  const match = dataUri.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/i);
  if (!match) {
    return null;
  }

  const mimeType = match[1].toLowerCase();
  const base64 = match[2].replace(/\s+/g, "");
  const extension = mimeType.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "bin";
  const filePath = path.join(OUTBOUND_MEDIA_DIR, `reply-${Date.now()}-${Math.random().toString(16).slice(2)}.${extension}`);

  fs.mkdirSync(OUTBOUND_MEDIA_DIR, { recursive: true });
  fs.writeFileSync(filePath, Buffer.from(base64, "base64"));

  return { filePath, mimeType };
}

/**
 * 临时媒体目录只服务于当前桥接进程的短链路发送。
 * 所以这里采用“低频触发 + 按年龄清理”的保守策略，避免目录无限堆积。
 */
function cleanupOutboundMediaDir(now = Date.now()): void {
  if (now - lastCleanupAt < OUTBOUND_MEDIA_CLEANUP_INTERVAL_MS) {
    return;
  }

  lastCleanupAt = now;

  if (!fs.existsSync(OUTBOUND_MEDIA_DIR)) {
    return;
  }

  for (const entry of fs.readdirSync(OUTBOUND_MEDIA_DIR, { withFileTypes: true })) {
    if (!entry.isFile()) {
      continue;
    }

    const filePath = path.join(OUTBOUND_MEDIA_DIR, entry.name);

    try {
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs <= OUTBOUND_MEDIA_MAX_AGE_MS) {
        continue;
      }
      fs.rmSync(filePath, { force: true });
    } catch {
      // 清理失败时保持发送主流程继续，不把临时目录维护升级成用户可见错误。
    }
  }
}

/**
 * 这是微信侧最终发送前的最后一道归一层。
 * 文本优先取“适合展示”的内容；媒体则优先尝试把 data URI 转成实际文件，失败时再原样透传。
 */
export function normalizeWechatReply(result: ParsedAssistantResult): NormalizedWechatReply {
  cleanupOutboundMediaDir();
  const reply: NormalizedWechatReply = {};
  const text = result.kind === "text" ? result.displayText || result.text : result.displayText || result.result.text?.trim();

  if (text) {
    reply.text = text;
  }

  const candidate = result.kind === "structured" ? result.result.media : result.media;
  if (!candidate) {
    return reply;
  }

  if (candidate.url.startsWith("data:image/")) {
    const persisted = persistDataUriToTempFile(candidate.url);
    if (persisted) {
      reply.media = {
        type: "image",
        url: persisted.filePath,
        fileName: candidate.fileName,
      };
      return reply;
    }
  }

  reply.media = {
    type: candidate.type,
    url: candidate.url,
    fileName: candidate.fileName,
  };

  return reply;
}
