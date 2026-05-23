import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Agent, ChatRequest, ChatResponse } from "../agent/interface.js";
import { sendTyping } from "../api/api.js";
import type { WeixinMessage, MessageItem } from "../api/types.js";
import { MessageItemType, TypingStatus } from "../api/types.js";
import { downloadRemoteImageToTemp } from "../cdn/upload.js";
import { downloadMediaFromItem } from "../media/media-download.js";
import { getExtensionFromMime } from "../media/mime.js";
import { logger } from "../util/logger.js";

import { setContextToken, bodyFromItemList, isMediaItem } from "./inbound.js";
import { sendWeixinErrorNotice } from "./error-notice.js";
import { sendWeixinMediaFile } from "./send-media.js";
import { markdownToPlainText, sendMessageWeixin } from "./send.js";
import { handleSlashCommand } from "./slash-commands.js";

const MEDIA_TEMP_DIR = path.join(os.tmpdir(), "weixin-agent/media");

/** Save a buffer to a temporary file, returning the file path. */
async function saveMediaBuffer(
  buffer: Buffer,
  contentType?: string,
  subdir?: string,
  _maxBytes?: number,
  originalFilename?: string,
): Promise<{ path: string }> {
  const dir = path.join(MEDIA_TEMP_DIR, subdir ?? "");
  await fs.mkdir(dir, { recursive: true });
  let ext = ".bin";
  if (originalFilename) {
    ext = path.extname(originalFilename) || ".bin";
  } else if (contentType) {
    ext = getExtensionFromMime(contentType);
  }
  const name = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}${ext}`;
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, buffer);
  return { path: filePath };
}

/** Dependencies for processOneMessage. */
export type ProcessMessageDeps = {
  accountId: string;
  agent: Agent;
  baseUrl: string;
  cdnBaseUrl: string;
  token?: string;
  typingTicket?: string;
  log: (msg: string) => void;
  errLog: (msg: string) => void;
};

/** Extract raw text from item_list (for slash command detection). */
function extractTextBody(itemList?: MessageItem[]): string {
  if (!itemList?.length) return "";
  for (const item of itemList) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text != null) {
      return String(item.text_item.text);
    }
  }
  return "";
}

async function sendAgentResponse(params: {
  response: ChatResponse;
  to: string;
  contextToken?: string;
  baseUrl: string;
  token?: string;
  cdnBaseUrl: string;
  receivedAt: number;
}): Promise<void> {
  const { response, to, contextToken, baseUrl, token, cdnBaseUrl, receivedAt } = params;

  if (response.media) {
    let filePath: string;
    const mediaUrl = response.media.url;
    if (mediaUrl.startsWith("http://") || mediaUrl.startsWith("https://")) {
      filePath = await downloadRemoteImageToTemp(
        mediaUrl,
        path.join(MEDIA_TEMP_DIR, "outbound"),
      );
    } else {
      filePath = path.isAbsolute(mediaUrl) ? mediaUrl : path.resolve(mediaUrl);
    }
    logger.info(
      `processOneMessage: sending media reply to=${to} elapsedMs=${Date.now() - receivedAt} mediaType=${response.media.type}`,
    );
    await sendWeixinMediaFile({
      filePath,
      to,
      text: response.text ? markdownToPlainText(response.text) : "",
      opts: { baseUrl, token, contextToken },
      cdnBaseUrl,
    });
    logger.info(
      `processOneMessage: media reply sent to=${to} totalElapsedMs=${Date.now() - receivedAt}`,
    );
    return;
  }

  if (response.text) {
    const plainText = markdownToPlainText(response.text);
    logger.info(
      `processOneMessage: sending text reply to=${to} elapsedMs=${Date.now() - receivedAt} textLength=${plainText.length}`,
    );
    await sendMessageWeixin({
      to,
      text: plainText,
      opts: { baseUrl, token, contextToken },
    });
    logger.info(
      `processOneMessage: text reply sent to=${to} totalElapsedMs=${Date.now() - receivedAt}`,
    );
    return;
  }

  logger.warn(`processOneMessage: empty agent response to=${to} elapsedMs=${Date.now() - receivedAt}`);
}

async function deliverFollowUpChain(params: {
  response: ChatResponse;
  to: string;
  contextToken?: string;
  baseUrl: string;
  token?: string;
  cdnBaseUrl: string;
  receivedAt: number;
}): Promise<void> {
  const { response, to, contextToken, baseUrl, token, cdnBaseUrl, receivedAt } = params;

  if (!response.followUp) {
    return;
  }

  logger.info(`processOneMessage: awaiting followUp to=${to} elapsedMs=${Date.now() - receivedAt}`);
  const nextResponse = await response.followUp;
  logger.info(
    `processOneMessage: followUp resolved to=${to} elapsedMs=${Date.now() - receivedAt} hasText=${Boolean(nextResponse.text)} hasMedia=${Boolean(nextResponse.media)} hasNestedFollowUp=${Boolean(nextResponse.followUp)}`,
  );

  await sendAgentResponse({
    response: nextResponse,
    to,
    contextToken,
    baseUrl,
    token,
    cdnBaseUrl,
    receivedAt,
  });

  await deliverFollowUpChain({
    response: nextResponse,
    to,
    contextToken,
    baseUrl,
    token,
    cdnBaseUrl,
    receivedAt,
  });
}

/** Find the first downloadable media item from a message. */
function findMediaItem(itemList?: MessageItem[]): MessageItem | undefined {
  if (!itemList?.length) return undefined;

  const hasDownloadableMedia = (m?: { encrypt_query_param?: string; full_url?: string }) =>
    m?.encrypt_query_param || m?.full_url;

  // Direct media: IMAGE > VIDEO > FILE > VOICE (skip voice with transcription)
  const direct =
    itemList.find(
      (i) => i.type === MessageItemType.IMAGE && hasDownloadableMedia(i.image_item?.media),
    ) ??
    itemList.find(
      (i) => i.type === MessageItemType.VIDEO && hasDownloadableMedia(i.video_item?.media),
    ) ??
    itemList.find(
      (i) => i.type === MessageItemType.FILE && hasDownloadableMedia(i.file_item?.media),
    ) ??
    itemList.find(
      (i) =>
        i.type === MessageItemType.VOICE &&
        hasDownloadableMedia(i.voice_item?.media) &&
        !i.voice_item?.text,
    );
  if (direct) return direct;

  // Quoted media: check ref_msg
  const refItem = itemList.find(
    (i) =>
      i.type === MessageItemType.TEXT &&
      i.ref_msg?.message_item &&
      isMediaItem(i.ref_msg.message_item),
  );
  return refItem?.ref_msg?.message_item ?? undefined;
}

/**
 * Process a single inbound message:
 *   slash command check → download media → call agent → send reply.
 */
export async function processOneMessage(
  full: WeixinMessage,
  deps: ProcessMessageDeps,
): Promise<void> {
  const receivedAt = Date.now();
  const textBody = extractTextBody(full.item_list);

  // --- Slash commands ---
  if (textBody.startsWith("/")) {
    const conversationId = full.from_user_id ?? "";
    const slashResult = await handleSlashCommand(
      textBody,
      {
        to: conversationId,
        contextToken: full.context_token,
        baseUrl: deps.baseUrl,
        token: deps.token,
        accountId: deps.accountId,
        log: deps.log,
        errLog: deps.errLog,
        onClear: () => deps.agent.clearSession?.(conversationId),
      },
      receivedAt,
      full.create_time_ms,
    );
    if (slashResult.handled) return;
  }

  // --- Store context token ---
  const contextToken = full.context_token;
  if (contextToken) {
    setContextToken(deps.accountId, full.from_user_id ?? "", contextToken);
  }

  // --- Download media ---
  let media: ChatRequest["media"];
  const mediaItem = findMediaItem(full.item_list);
  if (mediaItem) {
    try {
      const downloaded = await downloadMediaFromItem(mediaItem, {
        cdnBaseUrl: deps.cdnBaseUrl,
        saveMedia: saveMediaBuffer,
        log: deps.log,
        errLog: deps.errLog,
        label: "inbound",
      });
      if (downloaded.decryptedPicPath) {
        media = { type: "image", filePath: downloaded.decryptedPicPath, mimeType: "image/*" };
      } else if (downloaded.decryptedVideoPath) {
        media = { type: "video", filePath: downloaded.decryptedVideoPath, mimeType: "video/mp4" };
      } else if (downloaded.decryptedFilePath) {
        media = {
          type: "file",
          filePath: downloaded.decryptedFilePath,
          mimeType: downloaded.fileMediaType ?? "application/octet-stream",
        };
      } else if (downloaded.decryptedVoicePath) {
        media = {
          type: "audio",
          filePath: downloaded.decryptedVoicePath,
          mimeType: downloaded.voiceMediaType ?? "audio/wav",
        };
      }
    } catch (err) {
      logger.error(`media download failed: ${String(err)}`);
    }
  }

  // --- Build ChatRequest ---
  const request: ChatRequest = {
    conversationId: full.from_user_id ?? "",
    text: bodyFromItemList(full.item_list),
    media,
  };

  // --- Typing indicator (start + periodic refresh) ---
  const to = full.from_user_id ?? "";
  let typingTimer: ReturnType<typeof setInterval> | undefined;
  const startTyping = () => {
    if (!deps.typingTicket) return;
    sendTyping({
      baseUrl: deps.baseUrl,
      token: deps.token,
      body: {
        ilink_user_id: to,
        typing_ticket: deps.typingTicket,
        status: TypingStatus.TYPING,
      },
    }).catch(() => {});
  };
  if (deps.typingTicket) {
    startTyping();
    typingTimer = setInterval(startTyping, 10_000);
  }

  // --- Call agent & send reply ---
  try {
    const response = await deps.agent.chat(request);
    const elapsedSinceInbound = Date.now() - receivedAt;

    logger.info(
      `processOneMessage: agent completed to=${to} elapsedMs=${elapsedSinceInbound} hasText=${Boolean(response.text)} hasMedia=${Boolean(response.media)} hasFollowUp=${Boolean(response.followUp)} contextToken=${contextToken ? "present" : "missing"}`,
    );

    await sendAgentResponse({
      response,
      to,
      contextToken,
      baseUrl: deps.baseUrl,
      token: deps.token,
      cdnBaseUrl: deps.cdnBaseUrl,
      receivedAt,
    });

    if (response.followUp) {
      void deliverFollowUpChain({
        response,
        to,
        contextToken,
        baseUrl: deps.baseUrl,
        token: deps.token,
        cdnBaseUrl: deps.cdnBaseUrl,
        receivedAt,
      }).catch((followUpError) => {
        logger.error(
          `processOneMessage: followUp delivery failed: ${followUpError instanceof Error ? followUpError.stack ?? followUpError.message : JSON.stringify(followUpError)}`,
        );
        void sendWeixinErrorNotice({
          to,
          contextToken,
          message: `⚠️ 后续补发失败：${followUpError instanceof Error ? followUpError.message : JSON.stringify(followUpError)}`,
          baseUrl: deps.baseUrl,
          token: deps.token,
          errLog: deps.errLog,
        });
      });
    }
  } catch (err) {
    logger.error(`processOneMessage: agent or send failed: ${err instanceof Error ? err.stack ?? err.message : JSON.stringify(err)}`);
    void sendWeixinErrorNotice({
      to,
      contextToken,
      message: `⚠️ 处理消息失败：${err instanceof Error ? err.message : JSON.stringify(err)}`,
      baseUrl: deps.baseUrl,
      token: deps.token,
      errLog: deps.errLog,
    });
  } finally {
    // --- Typing indicator (cancel) ---
    if (typingTimer) clearInterval(typingTimer);
    if (deps.typingTicket) {
      sendTyping({
        baseUrl: deps.baseUrl,
        token: deps.token,
        body: {
          ilink_user_id: to,
          typing_ticket: deps.typingTicket,
          status: TypingStatus.CANCEL,
        },
      }).catch(() => {});
    }
  }
}
