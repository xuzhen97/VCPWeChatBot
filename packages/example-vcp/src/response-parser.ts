import type {
  ParsedAssistantDiagnostics,
  ParsedAssistantResult,
  ParsedToolTrace,
  StructuredWechatMedia,
  StructuredWechatResult,
  ToolTraceField,
} from "./types.js";

/**
 * 这个解析器站在“VCP 原始回答”与“微信可发送结果”之间。
 * 它的职责不是生成业务答案，而是把混杂的工具调用痕迹、结构化 JSON、媒体链接、展示文本和历史文本拆成稳定层次。
 */
const TOOL_REQUEST_START = "<<<[TOOL_REQUEST]>>>";
const TOOL_REQUEST_END = "<<<[END_TOOL_REQUEST]>>>";
const TOOL_RESULT_REGEX = /\[\[VCP调用结果信息汇总:([\s\S]*?)\]\]/g;
const TOOL_REQUEST_REGEX = /<<<\[TOOL_REQUEST\]>>>([\s\S]*?)<<<\[END_TOOL_REQUEST\]>>>/g;
const MARKDOWN_IMAGE_REGEX = /!\[[^\]]*\]\((data:[^)]+|https?:\/\/[^)\s]+)\)/i;
const DATA_URI_IMAGE_REGEX = /data:(image\/[a-zA-Z0-9.+-]+);base64,[a-zA-Z0-9+/=\s]+/i;
const REMOTE_MEDIA_URL_REGEX = /https?:\/\/[^\s"'<>]+\.(png|jpe?g|gif|webp|bmp|svg|mp4|mov|avi|mkv|pdf|docx?|xlsx?|pptx?|zip)(?:\?[^\s"'<>]*)?/i;
const MAX_DISPLAY_FIELD_LENGTH = 220;
const MAX_DISPLAY_BODY_LENGTH = 280;
const MAX_HISTORY_FALLBACK_LENGTH = 360;
const MAX_DISPLAY_FIELDS = 4;
const TOOL_REQUEST_HIDDEN_KEYS = new Set(["archery", "ink", "river", "vref"]);

function normalizeLineBreaks(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

function cleanupText(text: string): string {
  return normalizeLineBreaks(text)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function squashInline(text: string): string {
  return cleanupText(text).replace(/\s*\n\s*/g, " ").replace(/\s{2,}/g, " ").trim();
}

function clipText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function clipInline(text: string, maxLength: number): string {
  return clipText(squashInline(text), maxLength);
}

/**
 * 优先识别“显式结构化结果”。
 * 只要回答体满足 `wechat_result` 协议，后续就走结构化分支，不再依赖模糊文本推断。
 */
function tryParseJson(text: string): StructuredWechatResult | null {
  try {
    const parsed = JSON.parse(text) as Partial<StructuredWechatResult>;

    if (parsed.mode !== "wechat_result") {
      return null;
    }

    const textField = typeof parsed.text === "string" ? parsed.text.trim() || undefined : undefined;
    const media = parsed.media;

    if (!media && !textField) {
      return null;
    }

    if (!media) {
      return {
        mode: "wechat_result",
        text: textField,
      };
    }

    if (
      typeof media !== "object" ||
      media === null ||
      (media.type !== "image" && media.type !== "video" && media.type !== "file") ||
      typeof media.url !== "string" ||
      !media.url.trim()
    ) {
      return null;
    }

    return {
      mode: "wechat_result",
      text: textField,
      media: {
        type: media.type,
        url: media.url.trim(),
        fileName: typeof media.fileName === "string" ? media.fileName : undefined,
      },
    };
  } catch {
    return null;
  }
}

function extractJsonCandidate(text: string): string | null {
  const trimmed = cleanupText(text);
  if (!trimmed) {
    return null;
  }

  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    return trimmed;
  }

  const fencedMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim();
  }

  return null;
}

type ExtractedBlock = {
  kind: "request" | "result";
  start: number;
  end: number;
  body: string;
};

/**
 * 工具调用块和工具结果块会混在同一段回答里。
 * 这里先把它们切成带坐标的块，后面才能一边移除，一边保留解析后的痕迹摘要。
 */
function collectBlocks(text: string): ExtractedBlock[] {
  const blocks: ExtractedBlock[] = [];

  for (const match of text.matchAll(TOOL_REQUEST_REGEX)) {
    if (match.index == null) {
      continue;
    }

    blocks.push({
      kind: "request",
      start: match.index,
      end: match.index + match[0].length,
      body: match[1]?.trim() || "",
    });
  }

  for (const match of text.matchAll(TOOL_RESULT_REGEX)) {
    if (match.index == null) {
      continue;
    }

    blocks.push({
      kind: "result",
      start: match.index,
      end: match.index + match[0].length,
      body: match[1]?.trim() || "",
    });
  }

  return blocks.sort((left, right) => left.start - right.start);
}

function stripToolBlocks(text: string, blocks: ExtractedBlock[]): string {
  if (blocks.length === 0) {
    return text;
  }

  let cursor = 0;
  let output = "";

  for (const block of blocks) {
    if (block.start > cursor) {
      output += text.slice(cursor, block.start);
    }
    cursor = Math.max(cursor, block.end);
  }

  if (cursor < text.length) {
    output += text.slice(cursor);
  }

  return output;
}

function restoreEscapedLiterals(text: string): string {
  return text
    .replaceAll("<<<[TOOL_REQUEST_ESCAPE]>>>", TOOL_REQUEST_START)
    .replaceAll("<<<[END_TOOL_REQUEST_ESCAPE]>>>", TOOL_REQUEST_END)
    .replaceAll("「始ESCAPE」", "「始」")
    .replaceAll("「末ESCAPE」", "「末」");
}

function skipWhitespace(content: string, index: number): number {
  let cursor = index;
  while (cursor < content.length && /\s/.test(content[cursor])) {
    cursor += 1;
  }
  return cursor;
}

function skipWhitespaceAndCommas(content: string, index: number): number {
  let cursor = index;
  while (cursor < content.length && /[\s,]/.test(content[cursor])) {
    cursor += 1;
  }
  return cursor;
}

/**
 * 工具请求使用的是 VCP 自定义块语法，不是标准 JSON。
 * 这里按字段名 + `「始」「末」` 分隔符逐段扫描，目的是在不执行任何工具的前提下恢复参数摘要。
 */
function scanToolRequestFields(blockContent: string): ToolTraceField[] {
  const fields: ToolTraceField[] = [];
  let cursor = 0;

  while (cursor < blockContent.length) {
    cursor = skipWhitespaceAndCommas(blockContent, cursor);
    if (cursor >= blockContent.length) {
      break;
    }

    const keyMatch = /^[\w_]+/.exec(blockContent.slice(cursor));
    if (!keyMatch) {
      cursor += 1;
      continue;
    }

    const key = keyMatch[0];
    cursor += key.length;
    cursor = skipWhitespace(blockContent, cursor);

    if (blockContent[cursor] !== ":") {
      continue;
    }

    cursor += 1;
    cursor = skipWhitespace(blockContent, cursor);

    let startMarker = "";
    let endMarker = "";

    if (blockContent.startsWith("「始ESCAPE」", cursor)) {
      startMarker = "「始ESCAPE」";
      endMarker = "「末ESCAPE」";
    } else if (blockContent.startsWith("「始」", cursor)) {
      startMarker = "「始」";
      endMarker = "「末」";
    } else {
      continue;
    }

    cursor += startMarker.length;
    const endIndex = blockContent.indexOf(endMarker, cursor);
    if (endIndex === -1) {
      break;
    }

    const rawValue = blockContent.slice(cursor, endIndex);
    fields.push({
      key,
      value: startMarker === "「始ESCAPE」" ? restoreEscapedLiterals(rawValue) : rawValue,
    });

    cursor = endIndex + endMarker.length;
    cursor = skipWhitespace(blockContent, cursor);
    if (blockContent[cursor] === ",") {
      cursor += 1;
    }
  }

  return fields;
}

function parseToolRequest(blockContent: string): ParsedToolTrace {
  const fields = scanToolRequestFields(blockContent);
  const toolName = fields.find((field) => field.key === "tool_name")?.value?.trim() || "UnknownTool";

  return {
    kind: "request",
    toolName,
    fields: fields.filter((field) => field.key !== "tool_name" && !TOOL_REQUEST_HIDDEN_KEYS.has(field.key)),
  };
}

/**
 * 工具结果块更像是一段“半结构化清单”。
 * 这里先拆 key-value，再把剩余正文聚合到 body，便于后面生成展示摘要和历史回写兜底文本。
 */
function parseToolResult(blockContent: string): ParsedToolTrace {
  const lines = normalizeLineBreaks(blockContent)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const fields: ToolTraceField[] = [];
  const bodyLines: string[] = [];
  let currentField: ToolTraceField | null = null;

  for (const line of lines) {
    const kvMatch = line.match(/^-\s*([^:：]+)\s*[:：]\s*(.*)$/);
    if (kvMatch) {
      currentField = {
        key: kvMatch[1].trim(),
        value: kvMatch[2].trim(),
      };
      fields.push(currentField);
      continue;
    }

    if (currentField) {
      currentField.value = cleanupText(`${currentField.value}\n${line}`);
      continue;
    }

    bodyLines.push(line);
  }

  const toolName = fields.find((field) => field.key === "工具名称")?.value?.trim() || undefined;
  const status = fields.find((field) => field.key === "执行状态")?.value?.trim() || undefined;

  return {
    kind: "result",
    toolName,
    status,
    fields: fields.filter((field) => field.key !== "工具名称" && field.key !== "执行状态"),
    body: cleanupText(bodyLines.join("\n")) || undefined,
  };
}

function buildToolRequestDisplay(trace: Extract<ParsedToolTrace, { kind: "request" }>, index: number): string {
  const lines = [`【工具调用 ${index}】${trace.toolName}`];
  const visibleFields = trace.fields.slice(0, MAX_DISPLAY_FIELDS);

  for (const field of visibleFields) {
    lines.push(`- ${field.key}: ${clipInline(field.value, MAX_DISPLAY_FIELD_LENGTH)}`);
  }

  if (trace.fields.length > visibleFields.length) {
    lines.push(`- 其余参数 ${trace.fields.length - visibleFields.length} 项已省略`);
  }

  return lines.join("\n");
}

function pickResultSummaryFields(fields: ToolTraceField[]): ToolTraceField[] {
  const priority = ["返回内容", "可访问URL", "结果摘要", "文件名", "保存路径"];
  const selected: ToolTraceField[] = [];

  for (const key of priority) {
    const field = fields.find((item) => item.key === key);
    if (field) {
      selected.push(field);
    }
  }

  for (const field of fields) {
    if (selected.includes(field)) {
      continue;
    }
    selected.push(field);
    if (selected.length >= MAX_DISPLAY_FIELDS) {
      break;
    }
  }

  return selected.slice(0, MAX_DISPLAY_FIELDS);
}

function buildToolResultDisplay(trace: Extract<ParsedToolTrace, { kind: "result" }>, index: number): string {
  const title = trace.toolName || "UnknownTool";
  const statusPart = trace.status ? ` · ${trace.status}` : "";
  const lines = [`【工具返回 ${index}】${title}${statusPart}`];
  const visibleFields = pickResultSummaryFields(trace.fields);

  for (const field of visibleFields) {
    const limit = field.key === "返回内容" ? MAX_DISPLAY_BODY_LENGTH : MAX_DISPLAY_FIELD_LENGTH;
    lines.push(`- ${field.key}: ${clipInline(field.value, limit)}`);
  }

  if (trace.body) {
    lines.push(`- 摘要: ${clipInline(trace.body, MAX_DISPLAY_BODY_LENGTH)}`);
  }

  if (trace.fields.length > visibleFields.length) {
    lines.push(`- 其余结果字段 ${trace.fields.length - visibleFields.length} 项已省略`);
  }

  return lines.join("\n");
}

function buildToolDisplayText(traces: ParsedToolTrace[]): string {
  let requestIndex = 0;
  let resultIndex = 0;

  return traces
    .map((trace) => {
      if (trace.kind === "request") {
        requestIndex += 1;
        return buildToolRequestDisplay(trace, requestIndex);
      }

      resultIndex += 1;
      return buildToolResultDisplay(trace, resultIndex);
    })
    .filter(Boolean)
    .join("\n\n");
}

function buildMediaSummary(media?: StructuredWechatMedia): string {
  if (!media) {
    return "";
  }

  const fileName = media.fileName ? `，文件名：${media.fileName}` : "";
  return `[助手返回了一个${media.type}媒体结果${fileName}]`;
}

function buildHistoryFallbackFromTraces(traces: ParsedToolTrace[]): string {
  for (let index = traces.length - 1; index >= 0; index -= 1) {
    const trace = traces[index];
    if (trace.kind !== "result") {
      continue;
    }

    const toolName = trace.toolName || "工具";
    const status = trace.status ? `，状态：${trace.status}` : "";
    const contentField = trace.fields.find((field) => field.key === "返回内容");
    const urlField = trace.fields.find((field) => field.key === "可访问URL");
    const summarySource = contentField?.value || urlField?.value || trace.body || "已返回结果";
    return clipText(`${toolName}${status}。${clipInline(summarySource, MAX_HISTORY_FALLBACK_LENGTH)}`, MAX_HISTORY_FALLBACK_LENGTH);
  }

  const lastRequest = [...traces].reverse().find((trace) => trace.kind === "request");
  if (lastRequest) {
    return `${lastRequest.toolName} 已执行。`;
  }

  return "";
}

function buildHistoryText(answerText: string, mediaSummary: string, traces: ParsedToolTrace[]): string {
  const parts: string[] = [];

  if (answerText) {
    parts.push(answerText);
  } else {
    const fallback = buildHistoryFallbackFromTraces(traces);
    if (fallback) {
      parts.push(fallback);
    }
  }

  if (mediaSummary) {
    parts.push(mediaSummary);
  }

  return cleanupText(parts.join("\n\n")) || "[助手返回了空结果]";
}

/**
 * 仅凭 URL 后缀推断媒体类型，属于展示层启发式逻辑。
 * 它不追求绝对准确，只为微信发送时选出最合适的媒体通道。
 */
function inferMediaTypeFromUrl(url: string): StructuredWechatMedia["type"] {
  const lower = url.toLowerCase();
  if (/\.(mp4|mov|avi|mkv)(?:[?#].*)?$/.test(lower)) {
    return "video";
  }
  if (/\.(png|jpe?g|gif|webp|bmp|svg)(?:[?#].*)?$/.test(lower) || lower.startsWith("data:image/")) {
    return "image";
  }
  return "file";
}

/**
 * 文本答案里可能直接夹带 markdown 图片、data URI，或者远程媒体链接。
 * 这里做的是“弱结构推断”，只有在没有显式结构化结果时才介入。
 */
function extractMediaFromAnswerText(answerText: string): {
  media?: StructuredWechatMedia;
  source?: ParsedAssistantDiagnostics["mediaSource"];
} {
  const markdownImageMatch = answerText.match(MARKDOWN_IMAGE_REGEX);
  if (markdownImageMatch?.[1]) {
    const url = markdownImageMatch[1].trim();
    return {
      media: {
        type: inferMediaTypeFromUrl(url),
        url,
      },
      source: url.startsWith("data:image/") ? "answer_markdown" : "answer_url",
    };
  }

  const dataUriMatch = answerText.match(DATA_URI_IMAGE_REGEX);
  if (dataUriMatch?.[0]) {
    return {
      media: {
        type: "image",
        url: dataUriMatch[0].replace(/\s+/g, ""),
      },
      source: "answer_data_uri",
    };
  }

  const remoteUrlMatch = answerText.match(REMOTE_MEDIA_URL_REGEX);
  if (remoteUrlMatch?.[0]) {
    const url = remoteUrlMatch[0].trim();
    return {
      media: {
        type: inferMediaTypeFromUrl(url),
        url,
      },
      source: "answer_url",
    };
  }

  return {};
}

/**
 * 如果正文里没有媒体，再退一步从工具结果摘要里找可访问 URL。
 * 这能兼容“工具负责产出文件，助手正文只给一句说明”的场景。
 */
function extractMediaFromToolTraces(traces: ParsedToolTrace[]): {
  media?: StructuredWechatMedia;
  source?: ParsedAssistantDiagnostics["mediaSource"];
} {
  for (let index = traces.length - 1; index >= 0; index -= 1) {
    const trace = traces[index];
    if (trace.kind !== "result") {
      continue;
    }

    const candidateFields = trace.fields.filter((field) =>
      ["可访问URL", "返回内容", "结果摘要", "文件名"].includes(field.key),
    );

    for (const field of candidateFields) {
      const urlMatch = field.value.match(DATA_URI_IMAGE_REGEX) || field.value.match(REMOTE_MEDIA_URL_REGEX);
      if (!urlMatch?.[0]) {
        continue;
      }

      const url = urlMatch[0].replace(/\s+/g, "").trim();
      return {
        media: {
          type: inferMediaTypeFromUrl(url),
          url,
          fileName: trace.fields.find((item) => item.key === "文件名")?.value?.trim() || undefined,
        },
        source: "tool_result_url",
      };
    }
  }

  return {};
}

function buildDiagnostics(params: {
  traces: ParsedToolTrace[];
  media?: StructuredWechatMedia;
  mediaSource?: ParsedAssistantDiagnostics["mediaSource"];
}): ParsedAssistantDiagnostics {
  return {
    toolRequestCount: params.traces.filter((trace) => trace.kind === "request").length,
    toolResultCount: params.traces.filter((trace) => trace.kind === "result").length,
    mediaDetected: Boolean(params.media),
    mediaSource: params.mediaSource,
    mediaType: params.media?.type,
    mediaUrlPreview: params.media?.url ? clipInline(params.media.url, 160) : undefined,
  };
}

type ParsedMessageCore = {
  normalizedText: string;
  strippedText: string;
  answerText: string;
  structured: StructuredWechatResult | null;
  toolTraces: ParsedToolTrace[];
};

type ResolvedParsedMedia = {
  finalMedia?: StructuredWechatMedia;
  mediaSource?: ParsedAssistantDiagnostics["mediaSource"];
};

type ParsedTextProjection = {
  displayText?: string;
  historyText: string;
  diagnostics: ParsedAssistantDiagnostics;
};

function parseMessageCore(text: string): ParsedMessageCore {
  const normalizedText = normalizeLineBreaks(text).trim();
  const blocks = collectBlocks(normalizedText);
  const toolTraces = blocks.map((block) => (block.kind === "request" ? parseToolRequest(block.body) : parseToolResult(block.body)));
  const strippedText = cleanupText(stripToolBlocks(normalizedText, blocks));
  const jsonCandidate = extractJsonCandidate(strippedText);
  const structured = jsonCandidate ? tryParseJson(jsonCandidate) : null;
  const answerText = cleanupText(structured?.text || strippedText);

  return {
    normalizedText,
    strippedText,
    answerText,
    structured,
    toolTraces,
  };
}

function resolveParsedMedia(core: ParsedMessageCore): ResolvedParsedMedia {
  const inferredFromAnswer = core.structured?.media ? {} : extractMediaFromAnswerText(core.answerText || core.strippedText);
  const inferredFromToolTrace = core.structured?.media || inferredFromAnswer.media ? {} : extractMediaFromToolTraces(core.toolTraces);
  const finalMedia = core.structured?.media || inferredFromAnswer.media || inferredFromToolTrace.media;
  const mediaSource = core.structured?.media ? "structured" : inferredFromAnswer.source || inferredFromToolTrace.source;

  return {
    finalMedia,
    mediaSource,
  };
}

function projectParsedText(core: ParsedMessageCore, media: ResolvedParsedMedia): ParsedTextProjection {
  const toolDisplayText = cleanupText(buildToolDisplayText(core.toolTraces));
  const displayText = cleanupText([toolDisplayText, core.answerText].filter(Boolean).join("\n\n")) || undefined;
  const mediaSummary = buildMediaSummary(media.finalMedia);
  const historyText = buildHistoryText(core.answerText, mediaSummary, core.toolTraces);
  const diagnostics = buildDiagnostics({
    traces: core.toolTraces,
    media: media.finalMedia,
    mediaSource: media.mediaSource,
  });

  return {
    displayText,
    historyText,
    diagnostics,
  };
}

function buildStructuredParsedResult(
  core: ParsedMessageCore,
  media: ResolvedParsedMedia,
  projection: ParsedTextProjection,
): ParsedAssistantResult {
  return {
    kind: "structured",
    result: {
      ...core.structured!,
      media: media.finalMedia,
    },
    displayText: projection.displayText,
    historyText: projection.historyText,
    toolTraces: core.toolTraces,
    diagnostics: projection.diagnostics,
  };
}

function buildTextParsedResult(
  core: ParsedMessageCore,
  media: ResolvedParsedMedia,
  projection: ParsedTextProjection,
): ParsedAssistantResult {
  return {
    kind: "text",
    text: core.answerText || core.strippedText || core.normalizedText,
    media: media.finalMedia,
    displayText: projection.displayText,
    historyText: projection.historyText,
    toolTraces: core.toolTraces,
    diagnostics: projection.diagnostics,
  };
}

/**
 * 解析输出会同时面向三个消费方：
 * - 微信展示文本
 * - 轻历史摘要
 * - 调试日志诊断字段
 * 所以这里把所有来源统一收敛成一个总结果对象。
 */
export function parseAssistantResult(text: string): ParsedAssistantResult {
  const core = parseMessageCore(text);
  const media = resolveParsedMedia(core);
  const projection = projectParsedText(core, media);

  if (core.structured) {
    return buildStructuredParsedResult(core, media, projection);
  }

  return buildTextParsedResult(core, media, projection);
}