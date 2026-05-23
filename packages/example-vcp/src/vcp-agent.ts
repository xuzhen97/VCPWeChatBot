import crypto from "node:crypto";

import type { Agent, ChatRequest, ChatResponse } from "weixin-agent-sdk";

import { logError, logInfo, logWarn } from "./debug-log.js";
import { normalizeWechatReply } from "./media-normalizer.js";
import { parseAssistantResult } from "./response-parser.js";
import { SessionStore } from "./session-store.js";
import type { InboundAttachmentSummary, VcpAgentOptions, VcpChatResult } from "./types.js";
import { VcpClient } from "./vcp-client.js";

/**
 * `VcpAgent` 是整个桥接包的总编排层。
 * 它站在微信 SDK 和 VCP 之间，负责拼上下文、发请求、识别慢任务、回执补发、以及把最终结果写回轻历史。
 */
const DEFAULT_LONG_TASK_KEYWORDS = [
  "新闻",
  "最新",
  "最近",
  "联网",
  "搜索",
  "查一下",
  "帮我查",
  "实时",
  "今日",
  "热点",
  "汇率",
  "股价",
  "天气",
  "比赛",
  "比分",
  "资讯",
  "web",
  "search",
  "browse",
  "news",
];

const SLOW_TASK_GATE = Symbol("slow-task-gate");

type ChatExecutionContext = {
  sessions: SessionStore;
  conversationId: string;
  requestId: string;
  request: ChatRequest;
  startedAt: number;
  isLikelyLongTask: boolean;
  slowTaskMs: number;
};

type InitialReplyStage =
  | {
      kind: "completed";
      result: VcpChatResult;
    }
  | {
      kind: "deferred";
    };

type SlowTaskGateHandle = {
  waitForGate: Promise<typeof SLOW_TASK_GATE>;
  cancel: () => void;
};

/**
 * 历史里不保存完整附件对象，只提取桥接真正需要的最小摘要。
 * 这样既方便写回上下文，也避免把 SDK 专有字段耦合进内部状态。
 */
function buildAttachmentSummary(request: ChatRequest): InboundAttachmentSummary | undefined {
  const media = request.media;
  if (!media) {
    return undefined;
  }

  return {
    type: media.type,
    fileName: media.fileName,
    mimeType: media.mimeType,
  };
}

/**
 * 这是一个非常轻量的慢任务启发式判断。
 * 它不决定是否真正执行，只帮助日志和超时分支更早知道当前请求像不像“联网查资料”这类长尾任务。
 */
function looksLikeLongTask(text: string, keywords: string[]): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return keywords.some((keyword) => normalized.includes(keyword.toLowerCase()));
}

/**
 * 这里把各种下游抛错统一折叠成“是否超时”这个判定，
 * 目的是让回执补发和同步兜底都能复用同一套失败分流逻辑。
 */
function isTimeoutError(error: unknown): error is Error {
  return error instanceof Error && /超时|timeout/i.test(error.message);
}

/**
 * 当慢任务超过首包等待阈值时，先立刻给微信回一条“已受理”的同步响应，
 * 避免调用方因为长时间无首包而误判桥接已经失效。
 */
function buildDeferredAcceptanceReply(requestId: string): ChatResponse {
  return {
    text: `这个请求还在处理中，我先回执。\n\n结果出来后会自动补发。\n\nrequestId: ${requestId}`,
  };
}

/**
 * 这是同步请求路径的超时兜底文案。
 * 适用于没有进入补发分支、但当前调用已经确认超时的场景。
 */
function buildImmediateTimeoutFallback(requestId: string): ChatResponse {
  return {
    text: `这次请求超时了。\n\n你可以直接重试一次，或者把问题拆短一点再发。\n\nrequestId: ${requestId}`,
  };
}

/**
 * 请求已经先回执成功，但真正的补发结果仍然可能失败。
 * 这里把“超时未回”和“执行报错”拆开描述，方便用户区分是等待不足还是链路本身出错。
 */
function buildFollowUpFailureReply(requestId: string, error: unknown): ChatResponse {
  if (isTimeoutError(error)) {
    return {
      text: `这个长任务已经受理，但后续结果在等待上限内还是没回来。\n\n你可以稍后重试，或把问题收窄一点再发。\n\nrequestId: ${requestId}`,
    };
  }

  const message = error instanceof Error ? error.message : "未知错误";
  return {
    text: `这个长任务已经受理，但后续补发失败了。\n\n原因：${message}\n\nrequestId: ${requestId}`,
  };
}

/**
 * 这个收口函数做三件事：
 * 1. 解析 VCP 文本，把工具痕迹、结构化媒体、展示文本拆出来。
 * 2. 归一成微信可发送结果。
 * 3. 仅在真正拿到助手结果后，把这一轮写回轻历史。
 */
function commitAssistantResult(params: {
  sessions: SessionStore;
  conversationId: string;
  requestId: string;
  request: ChatRequest;
  result: VcpChatResult;
}): ChatResponse {
  const parsed = parseAssistantResult(params.result.text);
  const reply = normalizeWechatReply(parsed);

  logInfo("assistant result normalized", {
    requestId: params.requestId,
    conversationId: params.conversationId,
    rawTextLength: params.result.text.length,
    displayTextLength: parsed.displayText?.length ?? 0,
    historyTextLength: parsed.historyText.length,
    toolRequestCount: parsed.diagnostics.toolRequestCount,
    toolResultCount: parsed.diagnostics.toolResultCount,
    mediaDetected: parsed.diagnostics.mediaDetected,
    mediaSource: parsed.diagnostics.mediaSource,
    mediaType: parsed.diagnostics.mediaType,
    mediaUrlPreview: parsed.diagnostics.mediaUrlPreview,
    toolCalls: parsed.toolTraces
      .filter((trace) => trace.kind === "request")
      .map((trace) => trace.toolName),
    failedTools: parsed.toolTraces
      .flatMap((trace) => {
        if (trace.kind !== "result" || !trace.status || /成功|success|ok/i.test(trace.status)) {
          return [];
        }

        return [{
          toolName: trace.toolName || "UnknownTool",
          status: trace.status,
          summary:
            trace.fields.find((field) => ["返回内容", "结果摘要", "错误信息", "可访问URL"].includes(field.key))?.value?.slice(0, 200) ||
            trace.body?.slice(0, 200) ||
            "",
        }];
      }),
  });

  params.sessions.commitSuccessfulTurn({
    conversationId: params.conversationId,
    requestId: params.requestId,
    userInput: {
      userText: params.request.text,
      attachmentSummary: buildAttachmentSummary(params.request),
    },
    assistantText: parsed.historyText,
  });

  return reply;
}

/**
 * 同步成功出口只做一件事：
 * 在真正拿到 VCP 结果后统一完成解析、日志和轻历史提交。
 */
function buildSuccessfulReply(context: ChatExecutionContext, result: VcpChatResult): ChatResponse {
  const reply = commitAssistantResult({
    sessions: context.sessions,
    conversationId: context.conversationId,
    requestId: context.requestId,
    request: context.request,
    result,
  });

  logInfo("agent chat succeeded", {
    requestId: context.requestId,
    conversationId: context.conversationId,
    elapsedMs: Date.now() - context.startedAt,
    replyHasText: Boolean(reply.text),
    replyHasMedia: Boolean(reply.media),
    deferred: false,
  });

  return reply;
}

/**
 * 补发成功出口和同步成功出口共享同一份结果提交逻辑，
 * 差异只体现在日志语义：这里明确标记它来自“先回执、后补发”的分支。
 */
function buildDeferredFollowUp(context: ChatExecutionContext, requestPromise: Promise<VcpChatResult>): Promise<ChatResponse> {
  return requestPromise
    .then((result) => {
      const reply = commitAssistantResult({
        sessions: context.sessions,
        conversationId: context.conversationId,
        requestId: context.requestId,
        request: context.request,
        result,
      });

      logInfo("agent deferred follow-up succeeded", {
        requestId: context.requestId,
        conversationId: context.conversationId,
        elapsedMs: Date.now() - context.startedAt,
        replyHasText: Boolean(reply.text),
        replyHasMedia: Boolean(reply.media),
      });

      return reply;
    })
    .catch((error) => {
      logError("agent deferred follow-up failed", error, {
        requestId: context.requestId,
        conversationId: context.conversationId,
        elapsedMs: Date.now() - context.startedAt,
      });
      return buildFollowUpFailureReply(context.requestId, error);
    });
}

function createSlowTaskGate(slowTaskMs: number): SlowTaskGateHandle {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const waitForGate = new Promise<typeof SLOW_TASK_GATE>((resolve) => {
    timeoutId = setTimeout(() => resolve(SLOW_TASK_GATE), slowTaskMs);
  });

  return {
    waitForGate,
    cancel: () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
      }
    },
  };
}

/**
 * 这一步只负责决定“首包是否来得及”。
 * - 先拿到结果：走同步成功出口
 * - 先撞到慢任务阈值：切到回执补发出口
 *
 * 这里显式保留 gate 句柄，避免首包已经返回后仍残留无意义的慢任务定时器。
 */
async function waitInitialReplyStage(context: ChatExecutionContext, requestPromise: Promise<VcpChatResult>): Promise<InitialReplyStage> {
  const gate = createSlowTaskGate(context.slowTaskMs);

  try {
    const firstStage = await Promise.race([
      requestPromise,
      gate.waitForGate,
    ] as const);

    if (firstStage === SLOW_TASK_GATE) {
      return {
        kind: "deferred",
      };
    }

    return {
      kind: "completed",
      result: firstStage,
    };
  } finally {
    gate.cancel();
  }
}

/**
 * 首包阶段的失败只区分两类：
 * - 普通报错：继续抛出，让上层按失败处理
 * - 同步等待超时：返回明确的同步兜底文案
 */
function handleInitialFailure(context: ChatExecutionContext, error: unknown): ChatResponse {
  const elapsedMs = Date.now() - context.startedAt;
  if (!isTimeoutError(error)) {
    logError("agent chat failed", error, {
      requestId: context.requestId,
      conversationId: context.conversationId,
      elapsedMs,
      isLikelyLongTask: context.isLikelyLongTask,
    });
    throw error;
  }

  logWarn("agent chat timeout fallback", {
    requestId: context.requestId,
    conversationId: context.conversationId,
    elapsedMs,
    isLikelyLongTask: context.isLikelyLongTask,
    slowTaskMs: context.slowTaskMs,
  });

  return buildImmediateTimeoutFallback(context.requestId);
}

export class VcpAgent implements Agent {
  private readonly sessions: SessionStore;
  private readonly client: VcpClient;
  private readonly slowTaskMs: number;
  private readonly longTaskKeywords: string[];

  constructor(options: VcpAgentOptions) {
    this.sessions = new SessionStore({
      maxTurns: options.maxTurns,
      maxChars: options.maxChars,
      systemPrompt: options.systemPrompt,
    });
    this.client = new VcpClient(options);
    this.slowTaskMs = options.slowTaskMs ?? Math.min(options.timeoutMs ?? 300_000, 12_000);
    this.longTaskKeywords = options.longTaskKeywords?.length
      ? options.longTaskKeywords
      : DEFAULT_LONG_TASK_KEYWORDS;
  }

  clearSession(conversationId: string): void {
    this.sessions.clear(conversationId);
  }

  /**
   * `chat` 是桥接主链路。
   * 数据流顺序是：微信请求 → 轻历史拼装 → VCP 请求 → 慢任务分流 → 结果解析归一 → 写回历史 / 补发。
   */
  async chat(request: ChatRequest): Promise<ChatResponse> {
    const requestId = crypto.randomUUID();
    const messages = await this.sessions.buildRequestMessages(request);
    const startedAt = Date.now();
    const isLikelyLongTask = looksLikeLongTask(request.text, this.longTaskKeywords);
    const context: ChatExecutionContext = {
      sessions: this.sessions,
      conversationId: request.conversationId,
      requestId,
      request,
      startedAt,
      isLikelyLongTask,
      slowTaskMs: this.slowTaskMs,
    };

    logInfo("agent chat received", {
      requestId,
      conversationId: request.conversationId,
      hasMedia: Boolean(request.media),
      mediaType: request.media?.type,
      textLength: request.text.length,
      messageCount: messages.length,
      isLikelyLongTask,
    });

    const requestPromise = this.client.chat({
      messages,
      requestId,
    });

    try {
      const initialStage = await waitInitialReplyStage(context, requestPromise);

      if (initialStage.kind === "completed") {
        return buildSuccessfulReply(context, initialStage.result);
      }

      logWarn("agent chat switched to deferred follow-up", {
        requestId,
        conversationId: request.conversationId,
        elapsedMs: Date.now() - startedAt,
        slowTaskMs: this.slowTaskMs,
        isLikelyLongTask,
      });

      return {
        ...buildDeferredAcceptanceReply(requestId),
        followUp: buildDeferredFollowUp(context, requestPromise),
      };
    } catch (error) {
      return handleInitialFailure(context, error);
    }
  }
}
