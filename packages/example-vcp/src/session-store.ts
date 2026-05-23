import fs from "node:fs/promises";

import type { ChatRequest } from "weixin-agent-sdk";

import type {
  ConversationState,
  SessionAppendInput,
  SessionStoreConfig,
  StoredVcpMessage,
  VcpContentPart,
  VcpMessage,
} from "./types.js";

/**
 * `SessionStore` 管的是“桥接侧轻历史”，不是完整数据库。
 * 它的目标是给 VCP 补上下文，但又要严格限制体积，避免微信多轮对话把请求越堆越大。
 */
const DEFAULT_EMPTY_USER_TEXT = "[用户发送了一条空消息]";
const MAX_STORED_MESSAGE_CHARS = 4000;
const DEFAULT_SESSION_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_MAX_SESSION_COUNT = 200;

function normalizeText(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

function clipText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `…${text.slice(text.length - maxChars + 1)}`;
}

function estimateMessagesChars(messages: StoredVcpMessage[]): number {
  return messages.reduce((sum, message) => sum + message.content.length, 0);
}

/**
 * 历史里只保留“可复用语义”，所以这里把附件二进制本体降级成一段可读摘要。
 * 这样既能提醒模型发生过什么，又不会把历史消息膨胀成不可控的大对象。
 */
function summarizeAttachment(input?: SessionAppendInput["attachmentSummary"]): string {
  if (!input) {
    return "";
  }

  const namePart = input.fileName ? `，文件名：${input.fileName}` : "";
  const mimePart = input.mimeType ? `，MIME：${input.mimeType}` : "";

  switch (input.type) {
    case "image":
      return `[用户附带了一张图片${namePart}${mimePart}]`;
    case "audio":
      return `[用户附带了一段音频${namePart}${mimePart}]`;
    case "video":
      return `[用户附带了一个视频${namePart}${mimePart}]`;
    case "file":
      return `[用户附带了一个文件${namePart}${mimePart}]`;
  }
}

/**
 * 历史中的 user 记录需要同时兼容三种情况：
 * 1. 纯文本
 * 2. 文本 + 附件摘要
 * 3. 只有附件、没有正文
 */
function buildStoredUserContent(input: SessionAppendInput): string {
  const text = normalizeText(input.userText);
  const attachmentSummary = summarizeAttachment(input.attachmentSummary);

  if (text && attachmentSummary) {
    return `${text}\n\n${attachmentSummary}`;
  }

  if (text) {
    return text;
  }

  if (attachmentSummary) {
    return attachmentSummary;
  }

  return DEFAULT_EMPTY_USER_TEXT;
}

/**
 * 当前轮发送给 VCP 的内容和“写回历史”的内容不是一回事：
 * - 图片会被转成 data URI，确保 VCP 这次请求真的能看到图像。
 * - 其他附件暂时只给文字提示，不直接内联二进制，避免桥接层把请求体做得过大。
 */
async function buildCurrentUserContent(request: ChatRequest): Promise<VcpMessage["content"]> {
  const text = normalizeText(request.text);
  const media = request.media;

  if (!media) {
    return text || DEFAULT_EMPTY_USER_TEXT;
  }

  if (media.type === "image") {
    const data = await fs.readFile(media.filePath);
    const base64 = data.toString("base64");
    const mimeType = media.mimeType || "image/jpeg";
    const parts: VcpContentPart[] = [];

    if (text) {
      parts.push({ type: "text", text });
    }

    parts.push({
      type: "image_url",
      image_url: { url: `data:${mimeType};base64,${base64}` },
    });

    return parts;
  }

  const fileNamePart = media.fileName ? `，文件名：${media.fileName}` : "";
  const mimeTypePart = media.mimeType ? `，MIME：${media.mimeType}` : "";
  const attachmentNotice = `[当前消息附带了一个${media.type}附件${fileNamePart}${mimeTypePart}。微信桥接当前版本不会把该二进制内容直接内联到 VCP 请求中，请基于文字上下文处理。]`;

  if (text) {
    return `${text}\n\n${attachmentNotice}`;
  }

  return attachmentNotice;
}

/**
 * 裁剪策略分两层：
 * 1. 先按轮数裁掉最老对话，保证多轮窗口稳定。
 * 2. 再按字符数继续收缩，必要时截断最早保留下来的那条消息尾部。
 * 系统提示始终尽量保留，不参与普通轮次的淘汰顺序。
 */
function trimMessages(messages: StoredVcpMessage[], config: SessionStoreConfig): StoredVcpMessage[] {
  const hasSystem = messages[0]?.role === "system";
  const systemMessage = hasSystem ? messages[0] : undefined;
  const body = hasSystem ? messages.slice(1) : [...messages];
  const maxMessageCount = Math.max(config.maxTurns, 0) * 2;

  while (body.length > maxMessageCount) {
    body.shift();
  }

  const merge = (): StoredVcpMessage[] => (systemMessage ? [systemMessage, ...body] : [...body]);

  while (estimateMessagesChars(merge()) > config.maxChars && body.length > 1) {
    body.shift();
  }

  while (estimateMessagesChars(merge()) > config.maxChars && body.length > 0) {
    const first = body[0];
    const overflow = estimateMessagesChars(merge()) - config.maxChars;

    if (overflow <= 0) {
      break;
    }

    if (first.content.length <= overflow + 8) {
      body.shift();
      continue;
    }

    body[0] = {
      ...first,
      content: clipText(first.content, first.content.length - overflow),
    };
  }

  return merge();
}

function isExpiredSession(state: ConversationState, now: number, ttlMs: number): boolean {
  return now - state.updatedAt > ttlMs;
}

function pickOldestConversationId(sessions: Map<string, ConversationState>): string | undefined {
  let oldest: ConversationState | undefined;

  for (const state of sessions.values()) {
    if (!oldest || state.updatedAt < oldest.updatedAt) {
      oldest = state;
    }
  }

  return oldest?.conversationId;
}

/**
 * 这是一个纯内存会话仓。
 * 作用域只覆盖当前进程生命周期，适合示例桥接；重启后历史自然清空，不承诺持久化恢复。
 */
export class SessionStore {
  private readonly sessions = new Map<string, ConversationState>();
  private readonly sessionTtlMs = DEFAULT_SESSION_TTL_MS;
  private readonly maxSessionCount = DEFAULT_MAX_SESSION_COUNT;

  constructor(private readonly config: SessionStoreConfig) {}

  clear(conversationId: string): void {
    this.sessions.delete(conversationId);
  }

  /**
   * 给本轮请求拼装 VCP 消息序列：
   * 历史部分来自内存缓存，当前轮内容按媒体类型做专门编码。
   */
  async buildRequestMessages(request: ChatRequest): Promise<VcpMessage[]> {
    const state = this.getOrCreateState(request.conversationId);
    const currentContent = await buildCurrentUserContent(request);

    return [
      ...state.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      {
        role: "user",
        content: currentContent,
      },
    ];
  }

  /**
   * 只有当一轮对话真正拿到助手结果后，才会写回历史。
   * 这样可以避免超时、失败、或仅回执未完成的请求污染上下文。
   */
  commitSuccessfulTurn(params: {
    conversationId: string;
    requestId: string;
    userInput: SessionAppendInput;
    assistantText: string;
  }): void {
    this.cleanupSessions();
    const state = this.getOrCreateState(params.conversationId);
    const nextMessages = trimMessages(
      [
        ...state.messages,
        {
          role: "user",
          content: clipText(buildStoredUserContent(params.userInput), MAX_STORED_MESSAGE_CHARS),
        },
        {
          role: "assistant",
          content: clipText(normalizeText(params.assistantText) || "[助手返回了空结果]", MAX_STORED_MESSAGE_CHARS),
        },
      ],
      this.config,
    );

    this.sessions.set(params.conversationId, {
      conversationId: params.conversationId,
      messages: nextMessages,
      lastRequestId: params.requestId,
      updatedAt: Date.now(),
    });
  }

  /**
   * 会话是按 `conversationId` 惰性创建的。
   * 首次进入时只灌入系统提示，后续再逐轮追加 user / assistant 对话。
   */
  private getOrCreateState(conversationId: string): ConversationState {
    this.cleanupSessions();
    const existing = this.sessions.get(conversationId);
    if (existing) {
      return existing;
    }

    const messages: StoredVcpMessage[] = [];
    const systemPrompt = normalizeText(this.config.systemPrompt || "");

    if (systemPrompt) {
      messages.push({ role: "system", content: systemPrompt });
    }

    const created: ConversationState = {
      conversationId,
      messages,
      updatedAt: Date.now(),
    };

    this.sessions.set(conversationId, created);
    this.enforceSessionCapacity();
    return created;
  }

  /**
   * 示例桥接是纯内存态，所以这里用两层轻量回收保护常驻进程：
   * - 先按空闲时长清掉过期会话
   * - 再按容量上限淘汰最久未更新的会话
   */
  private cleanupSessions(now = Date.now()): void {
    for (const [conversationId, state] of this.sessions.entries()) {
      if (isExpiredSession(state, now, this.sessionTtlMs)) {
        this.sessions.delete(conversationId);
      }
    }

    this.enforceSessionCapacity();
  }

  private enforceSessionCapacity(): void {
    while (this.sessions.size > this.maxSessionCount) {
      const oldestConversationId = pickOldestConversationId(this.sessions);
      if (!oldestConversationId) {
        break;
      }

      this.sessions.delete(oldestConversationId);
    }
  }
}
