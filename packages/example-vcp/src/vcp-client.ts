import { logError, logInfo } from "./debug-log.js";
import type { VcpChatRequest, VcpChatResult, VcpClientConfig } from "./types.js";

/**
 * 这里只关心桥接层真正会读取到的最小响应形状。
 * 目的不是完整复刻 VCP 的全部协议，而是把这里会消费的字段显式化，降低后续接入变更时的心智负担。
 */
type VcpCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
  error?: {
    message?: string;
  };
};

/**
 * VCP 的 `content` 可能是字符串、分片数组，或者对象。
 * 这里不做业务决策，只把“返回体长什么样”压缩成日志摘要，便于排查协议漂移。
 */
function summarizeContentShape(content: unknown): Record<string, unknown> {
  if (typeof content === "string") {
    return {
      contentShape: "string",
      contentLength: content.length,
    };
  }

  if (Array.isArray(content)) {
    return {
      contentShape: "array",
      contentItemCount: content.length,
      contentItemTypes: content.slice(0, 8).map((item) => {
        if (!item || typeof item !== "object") {
          return typeof item;
        }
        const type = Reflect.get(item, "type");
        return typeof type === "string" ? type : "object";
      }),
    };
  }

  if (content && typeof content === "object") {
    return {
      contentShape: "object",
      contentKeys: Object.keys(content as Record<string, unknown>).slice(0, 12),
    };
  }

  return {
    contentShape: typeof content,
  };
}

/**
 * 统一把外部传入的基础地址收敛到两个正式聊天端点之一。
 * 这样上层只维护 `baseUrl + forceToolView` 这两个输入，不需要在别处手动拼路由。
 */
function resolveChatEndpoint(baseUrl: string, forceToolView: boolean): string {
  const url = new URL(baseUrl);
  const route = forceToolView ? "/v1/chatvcp/completions" : "/v1/chat/completions";

  if (url.pathname.endsWith("/v1/chat/completions") || url.pathname.endsWith("/v1/chatvcp/completions")) {
    url.pathname = route;
    return url.toString();
  }

  url.pathname = route;
  return url.toString();
}

/**
 * 把 VCP 返回的多种 `content` 形态收敛成纯文本。
 * 这是桥接层的“文本出口”，后面的解析、入历史、回微信都依赖它的结果。
 */
function extractAssistantText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .flatMap((item) => {
        if (!item || typeof item !== "object") {
          return [];
        }

        const text = Reflect.get(item, "text");
        return typeof text === "string" ? [text] : [];
      })
      .join("");
  }

  if (content && typeof content === "object") {
    const text = Reflect.get(content, "text");
    if (typeof text === "string") {
      return text;
    }
  }

  return "";
}

/**
 * 失败时优先抽取服务端已经给出的业务错误信息。
 * 只有响应体不可解析时，才退回到“状态码 + 原始文本”的兜底描述。
 */
function parseErrorMessage(status: number, rawText: string): string {
  if (!rawText.trim()) {
    return `VCP 请求失败，状态码 ${status}`;
  }

  try {
    const parsed = JSON.parse(rawText) as {
      error?: { message?: string };
      message?: string;
    };
    const fromNested = parsed.error?.message;
    const fromRoot = parsed.message;
    return fromNested || fromRoot || `VCP 请求失败，状态码 ${status}`;
  } catch {
    return `VCP 请求失败，状态码 ${status}: ${rawText}`;
  }
}

/**
 * `VcpClient` 只负责一件事：把桥接层整理好的消息投递给 VCP，并把返回值压缩成统一结果。
 * 它不关心微信、不关心会话历史，只处理 HTTP 边界、超时和响应解包。
 */
export class VcpClient {
  private readonly endpoint: string;
  private readonly timeoutMs: number;

  constructor(private readonly config: VcpClientConfig) {
    this.endpoint = resolveChatEndpoint(config.baseUrl, config.forceToolView === true);
    this.timeoutMs = config.timeoutMs ?? 300_000;
  }

  /**
   * 这是一次完整的 VCP 请求生命周期：发请求、等结果、解包文本、记录日志、处理超时。
   * 返回值刻意保持很薄，只把后续桥接层真正需要的文本和原始包体带出去。
   */
  async chat(request: VcpChatRequest): Promise<VcpChatResult> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    logInfo("vcp request started", {
      requestId: request.requestId,
      endpoint: this.endpoint,
      model: this.config.model,
      messageCount: request.messages.length,
      timeoutMs: this.timeoutMs,
    });

    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: request.messages,
          stream: false,
          requestId: request.requestId,
        }),
        signal: controller.signal,
      });

      const rawText = await response.text();

      logInfo("vcp response received", {
        requestId: request.requestId,
        status: response.status,
        ok: response.ok,
        bodyLength: rawText.length,
      });

      if (!response.ok) {
        throw new Error(parseErrorMessage(response.status, rawText));
      }

      const parsed = JSON.parse(rawText) as VcpCompletionResponse;
      const content = parsed.choices?.[0]?.message?.content;
      const text = extractAssistantText(content);

      logInfo("vcp response parsed", {
        requestId: request.requestId,
        outputTextLength: text.length,
        ...summarizeContentShape(content),
      });

      return {
        text,
        raw: parsed,
      };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        const timeoutError = new Error(`VCP 请求超时，超过 ${this.timeoutMs}ms`);
        logError("vcp request timeout", timeoutError, {
          requestId: request.requestId,
          timeoutMs: this.timeoutMs,
          endpoint: this.endpoint,
        });
        throw timeoutError;
      }

      logError("vcp request failed", error, {
        requestId: request.requestId,
        endpoint: this.endpoint,
      });
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}