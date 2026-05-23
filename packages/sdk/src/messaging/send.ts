import { sendMessage as sendMessageApi } from "../api/api.js";
import type { WeixinApiOptions } from "../api/api.js";
import { logger } from "../util/logger.js";
import { generateId } from "../util/random.js";
import type { MessageItem, SendMessageReq } from "../api/types.js";
import { MessageItemType, MessageState, MessageType } from "../api/types.js";
import type { UploadedFileInfo } from "../cdn/upload.js";

const WEIXIN_TEXT_CHUNK_LIMIT = 1800;

export function generateClientId(): string {
  return generateId("openclaw-weixin");
}

/**
 * Convert markdown-formatted model reply to plain text for Weixin delivery.
 * Preserves newlines; strips markdown syntax.
 */
export function markdownToPlainText(text: string): string {
  let result = text;
  // Code blocks: strip fences, keep code content
  result = result.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_, code: string) => code.trim());
  // Images: remove entirely
  result = result.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
  // Links: keep display text only
  result = result.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  // Tables: remove separator rows, then strip leading/trailing pipes and convert inner pipes to spaces
  result = result.replace(/^\|[\s:|-]+\|$/gm, "");
  result = result.replace(/^\|(.+)\|$/gm, (_, inner: string) =>
    inner.split("|").map((cell) => cell.trim()).join("  "),
  );
  // Strip inline markdown formatting
  result = result
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/_(.+?)_/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/`(.+?)`/g, "$1");
  return result;
}

function sliceTextChunk(text: string, start: number, maxLength: number): string {
  const remaining = text.slice(start);
  if (remaining.length <= maxLength) {
    return remaining;
  }

  const candidate = remaining.slice(0, maxLength);
  const newlineIndex = candidate.lastIndexOf("\n");
  if (newlineIndex >= Math.floor(maxLength * 0.4)) {
    return candidate.slice(0, newlineIndex).trimEnd();
  }

  const spaceIndex = candidate.lastIndexOf(" ");
  if (spaceIndex >= Math.floor(maxLength * 0.6)) {
    return candidate.slice(0, spaceIndex).trimEnd();
  }

  return candidate.trimEnd();
}

function splitTextForWeixin(text: string, maxLength = WEIXIN_TEXT_CHUNK_LIMIT): string[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return [];
  }

  const chunks: string[] = [];
  let cursor = 0;

  while (cursor < normalized.length) {
    while (cursor < normalized.length && /\s/.test(normalized[cursor])) {
      cursor += 1;
    }
    if (cursor >= normalized.length) {
      break;
    }

    const chunk = sliceTextChunk(normalized, cursor, maxLength);
    if (!chunk) {
      const fallback = normalized.slice(cursor, cursor + maxLength).trim();
      if (!fallback) {
        break;
      }
      chunks.push(fallback);
      cursor += fallback.length;
      continue;
    }

    chunks.push(chunk);
    cursor += chunk.length;
  }

  return chunks;
}

async function sendMessageRequest(params: {
  req: SendMessageReq;
  baseUrl: string;
  token?: string;
  timeoutMs?: number;
  label: string;
  to: string;
  clientId: string;
  itemType: MessageItem["type"];
  chunkIndex?: number;
  chunkCount?: number;
  textLength?: number;
}): Promise<void> {
  const { req, baseUrl, token, timeoutMs, label, to, clientId, itemType, chunkIndex, chunkCount, textLength } = params;
  const chunkSuffix =
    chunkIndex && chunkCount ? ` chunk=${chunkIndex}/${chunkCount}` : "";
  const textSuffix = typeof textLength === "number" ? ` textLength=${textLength}` : "";

  logger.info(
    `${label}: start to=${to} clientId=${clientId} itemType=${itemType}${chunkSuffix}${textSuffix}`,
  );

  try {
    const resp = await sendMessageApi({
      baseUrl,
      token,
      timeoutMs,
      body: req,
    });
    logger.info(
      `${label}: success to=${to} clientId=${clientId} itemType=${itemType}${chunkSuffix} ret=${resp.ret ?? 0} errmsg=${resp.errmsg ?? ""}`,
    );
  } catch (err) {
    logger.error(
      `${label}: failed to=${to} clientId=${clientId} itemType=${itemType}${chunkSuffix} err=${String(err)}`,
    );
    throw err;
  }
}


/** Build a SendMessageReq containing a single text message. */
function buildTextMessageReq(params: {
  to: string;
  text: string;
  contextToken?: string;
  clientId: string;
}): SendMessageReq {
  const { to, text, contextToken, clientId } = params;
  const item_list: MessageItem[] = text
    ? [{ type: MessageItemType.TEXT, text_item: { text } }]
    : [];
  return {
    msg: {
      from_user_id: "",
      to_user_id: to,
      client_id: clientId,
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      item_list: item_list.length ? item_list : undefined,
      context_token: contextToken ?? undefined,
    },
  };
}

/** Build a SendMessageReq from a text payload. */
function buildSendMessageReq(params: {
  to: string;
  contextToken?: string;
  text: string;
  clientId: string;
}): SendMessageReq {
  const { to, contextToken, text, clientId } = params;
  return buildTextMessageReq({ to, text, contextToken, clientId });
}

/**
 * Send a plain text message downstream.
 * contextToken is required for all reply sends; missing it breaks conversation association.
 */
export async function sendMessageWeixin(params: {
  to: string;
  text: string;
  opts: WeixinApiOptions & { contextToken?: string };
}): Promise<{ messageId: string }> {
  const { to, text, opts } = params;
  if (!opts.contextToken) {
    logger.error(`sendMessageWeixin: contextToken missing, refusing to send to=${to}`);
    throw new Error("sendMessageWeixin: contextToken is required");
  }

  const chunks = splitTextForWeixin(text);
  if (chunks.length === 0) {
    logger.warn(`sendMessageWeixin: empty text after normalization, refusing to send to=${to}`);
    throw new Error("sendMessageWeixin: text is empty after normalization");
  }

  logger.info(
    `sendMessageWeixin: prepared to=${to} chunkCount=${chunks.length} originalTextLength=${text.length} maxChunkLength=${WEIXIN_TEXT_CHUNK_LIMIT} hasContextToken=${Boolean(opts.contextToken)}`,
  );

  let lastClientId = "";
  for (const [index, chunk] of chunks.entries()) {
    lastClientId = generateClientId();
    const req = buildSendMessageReq({
      to,
      contextToken: opts.contextToken,
      text: chunk,
      clientId: lastClientId,
    });

    await sendMessageRequest({
      req,
      baseUrl: opts.baseUrl,
      token: opts.token,
      timeoutMs: opts.timeoutMs,
      label: "sendMessageWeixin",
      to,
      clientId: lastClientId,
      itemType: MessageItemType.TEXT,
      chunkIndex: index + 1,
      chunkCount: chunks.length,
      textLength: chunk.length,
    });
  }

  return { messageId: lastClientId };
}

/**
 * Send one or more MessageItems (optionally preceded by a text caption) downstream.
 * Each item is sent as its own request so that item_list always has exactly one entry.
 */
async function sendMediaItems(params: {
  to: string;
  text: string;
  mediaItem: MessageItem;
  opts: WeixinApiOptions & { contextToken?: string };
  label: string;
}): Promise<{ messageId: string }> {
  const { to, text, mediaItem, opts, label } = params;

  const textChunks = splitTextForWeixin(text);
  let lastClientId = "";

  for (const [index, chunk] of textChunks.entries()) {
    lastClientId = generateClientId();
    const req = buildTextMessageReq({
      to,
      text: chunk,
      contextToken: opts.contextToken,
      clientId: lastClientId,
    });

    await sendMessageRequest({
      req,
      baseUrl: opts.baseUrl,
      token: opts.token,
      timeoutMs: opts.timeoutMs,
      label,
      to,
      clientId: lastClientId,
      itemType: MessageItemType.TEXT,
      chunkIndex: index + 1,
      chunkCount: textChunks.length,
      textLength: chunk.length,
    });
  }

  lastClientId = generateClientId();
  const req: SendMessageReq = {
    msg: {
      from_user_id: "",
      to_user_id: to,
      client_id: lastClientId,
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      item_list: [mediaItem],
      context_token: opts.contextToken ?? undefined,
    },
  };

  await sendMessageRequest({
    req,
    baseUrl: opts.baseUrl,
    token: opts.token,
    timeoutMs: opts.timeoutMs,
    label,
    to,
    clientId: lastClientId,
    itemType: mediaItem.type,
  });

  logger.debug(`${label}: success to=${to} clientId=${lastClientId}`);
  return { messageId: lastClientId };
}

/**
 * Send an image message downstream using a previously uploaded file.
 * Optionally include a text caption as a separate TEXT item before the image.
 *
 * ImageItem fields:
 *   - media.encrypt_query_param: CDN download param
 *   - media.aes_key: AES key, base64-encoded
 *   - mid_size: original ciphertext file size
 */
export async function sendImageMessageWeixin(params: {
  to: string;
  text: string;
  uploaded: UploadedFileInfo;
  opts: WeixinApiOptions & { contextToken?: string };
}): Promise<{ messageId: string }> {
  const { to, text, uploaded, opts } = params;
  if (!opts.contextToken) {
    logger.error(`sendImageMessageWeixin: contextToken missing, refusing to send to=${to}`);
    throw new Error("sendImageMessageWeixin: contextToken is required");
  }
  logger.debug(
    `sendImageMessageWeixin: to=${to} filekey=${uploaded.filekey} fileSize=${uploaded.fileSize} aeskey=present`,
  );

  const imageItem: MessageItem = {
    type: MessageItemType.IMAGE,
    image_item: {
      media: {
        encrypt_query_param: uploaded.downloadEncryptedQueryParam,
        aes_key: Buffer.from(uploaded.aeskey).toString("base64"),
        encrypt_type: 1,
      },
      mid_size: uploaded.fileSizeCiphertext,
    },
  };

  return sendMediaItems({ to, text, mediaItem: imageItem, opts, label: "sendImageMessageWeixin" });
}

/**
 * Send a video message downstream using a previously uploaded file.
 * VideoItem: media (CDN ref), video_size (ciphertext bytes).
 * Includes an optional text caption sent as a separate TEXT item first.
 */
export async function sendVideoMessageWeixin(params: {
  to: string;
  text: string;
  uploaded: UploadedFileInfo;
  opts: WeixinApiOptions & { contextToken?: string };
}): Promise<{ messageId: string }> {
  const { to, text, uploaded, opts } = params;
  if (!opts.contextToken) {
    logger.error(`sendVideoMessageWeixin: contextToken missing, refusing to send to=${to}`);
    throw new Error("sendVideoMessageWeixin: contextToken is required");
  }

  const videoItem: MessageItem = {
    type: MessageItemType.VIDEO,
    video_item: {
      media: {
        encrypt_query_param: uploaded.downloadEncryptedQueryParam,
        aes_key: Buffer.from(uploaded.aeskey).toString("base64"),
        encrypt_type: 1,
      },
      video_size: uploaded.fileSizeCiphertext,
    },
  };

  return sendMediaItems({ to, text, mediaItem: videoItem, opts, label: "sendVideoMessageWeixin" });
}

/**
 * Send a file attachment downstream using a previously uploaded file.
 * FileItem: media (CDN ref), file_name, len (plaintext bytes as string).
 * Includes an optional text caption sent as a separate TEXT item first.
 */
export async function sendFileMessageWeixin(params: {
  to: string;
  text: string;
  fileName: string;
  uploaded: UploadedFileInfo;
  opts: WeixinApiOptions & { contextToken?: string };
}): Promise<{ messageId: string }> {
  const { to, text, fileName, uploaded, opts } = params;
  if (!opts.contextToken) {
    logger.error(`sendFileMessageWeixin: contextToken missing, refusing to send to=${to}`);
    throw new Error("sendFileMessageWeixin: contextToken is required");
  }
  const fileItem: MessageItem = {
    type: MessageItemType.FILE,
    file_item: {
      media: {
        encrypt_query_param: uploaded.downloadEncryptedQueryParam,
        aes_key: Buffer.from(uploaded.aeskey).toString("base64"),
        encrypt_type: 1,
      },
      file_name: fileName,
      len: String(uploaded.fileSize),
    },
  };

  return sendMediaItems({ to, text, mediaItem: fileItem, opts, label: "sendFileMessageWeixin" });
}
