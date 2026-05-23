import type { ChatResponse } from "weixin-agent-sdk";

/**
 * 这份类型文件描述的是桥接内部的数据契约。
 * 它把整个链路拆成四层：
 * 1. 发往 VCP 的消息形状
 * 2. 存在桥接内存里的轻历史形状
 * 3. 解析后的助手结果形状
 * 4. 最终回到微信 SDK 的结果形状
 */
export type VcpRole = "system" | "user" | "assistant";

export type VcpTextPart = {
  type: "text";
  text: string;
};

export type VcpImagePart = {
  type: "image_url";
  image_url: {
    url: string;
  };
};

export type VcpContentPart = VcpTextPart | VcpImagePart;

export type VcpContent = string | VcpContentPart[];

export type VcpMessage = {
  role: VcpRole;
  content: VcpContent;
};

export type StoredVcpMessage = {
  role: VcpRole;
  content: string;
};

export type ConversationState = {
  conversationId: string;
  messages: StoredVcpMessage[];
  lastRequestId?: string;
  updatedAt: number;
};

export type VcpClientConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt?: string;
  forceToolView?: boolean;
  timeoutMs?: number;
  slowTaskMs?: number;
  longTaskKeywords?: string[];
};

export type VcpAgentOptions = VcpClientConfig & {
  maxTurns: number;
  maxChars: number;
};

export type SessionStoreConfig = {
  maxTurns: number;
  maxChars: number;
  systemPrompt?: string;
};

export type StructuredWechatMedia = {
  type: "image" | "video" | "file";
  url: string;
  fileName?: string;
};

export type StructuredWechatResult = {
  mode: "wechat_result";
  text?: string;
  media?: StructuredWechatMedia;
};

export type ToolTraceField = {
  key: string;
  value: string;
};

export type ParsedToolTrace =
  | {
      kind: "request";
      toolName: string;
      fields: ToolTraceField[];
    }
  | {
      kind: "result";
      toolName?: string;
      status?: string;
      fields: ToolTraceField[];
      body?: string;
    };

export type ParsedAssistantDiagnostics = {
  toolRequestCount: number;
  toolResultCount: number;
  mediaDetected: boolean;
  mediaSource?: "structured" | "answer_markdown" | "answer_data_uri" | "answer_url" | "tool_result_url";
  mediaType?: "image" | "video" | "file";
  mediaUrlPreview?: string;
};

export type ParsedAssistantResult =
  | {
      kind: "text";
      text: string;
      media?: StructuredWechatMedia;
      displayText?: string;
      historyText: string;
      toolTraces: ParsedToolTrace[];
      diagnostics: ParsedAssistantDiagnostics;
    }
  | {
      kind: "structured";
      result: StructuredWechatResult;
      displayText?: string;
      historyText: string;
      toolTraces: ParsedToolTrace[];
      diagnostics: ParsedAssistantDiagnostics;
    };

export type NormalizedWechatReply = ChatResponse;

export type InboundAttachmentSummary = {
  type: "image" | "audio" | "video" | "file";
  fileName?: string;
  mimeType?: string;
};

export type SessionAppendInput = {
  userText: string;
  attachmentSummary?: InboundAttachmentSummary;
};

export type VcpChatRequest = {
  messages: VcpMessage[];
  requestId: string;
};

export type VcpChatResult = {
  text: string;
  raw: unknown;
};