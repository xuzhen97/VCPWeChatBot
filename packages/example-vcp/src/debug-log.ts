import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 这里的日志模块是“低侵入调试辅助层”：
 * - 追加写入本地临时目录，方便排查桥接过程。
 * - 写盘失败不会影响主流程，避免因为日志问题把消息链路拖死。
 */
const LOG_DIR = path.join(os.tmpdir(), "openclaw");
const SOURCE = "example-vcp";

function dateKey(now: Date): string {
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function resolveLogPath(now = new Date()): string {
  return path.join(LOG_DIR, `${SOURCE}-${dateKey(now)}.log`);
}

/**
 * 错误对象会在不同边界上呈现成不同形状。
 * 这里把它规整成稳定的可序列化结构，避免日志里丢失关键上下文。
 */
function normalizeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return {
    value: String(error),
  };
}

/**
 * 所有日志入口最终都会汇总到这里，统一完成两件事：
 * 1. 结构化写入本地日志文件。
 * 2. 同步输出到控制台，方便直接盯终端调试。
 */
function write(level: "INFO" | "WARN" | "ERROR", message: string, details?: Record<string, unknown>): void {
  const now = new Date();
  const entry = {
    time: now.toISOString(),
    source: SOURCE,
    level,
    message,
    details,
  };

  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(resolveLogPath(now), `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    // 日志失败不影响主流程
  }

  const suffix = details ? ` ${JSON.stringify(details)}` : "";
  const line = `[${SOURCE}][${level}] ${message}${suffix}`;
  if (level === "ERROR") {
    console.error(line);
    return;
  }
  console.log(line);
}

export function logInfo(message: string, details?: Record<string, unknown>): void {
  write("INFO", message, details);
}

export function logWarn(message: string, details?: Record<string, unknown>): void {
  write("WARN", message, details);
}

export function logError(message: string, error?: unknown, details?: Record<string, unknown>): void {
  write("ERROR", message, {
    ...details,
    ...(error === undefined ? undefined : { error: normalizeError(error) }),
  });
}

export function getDebugLogPath(): string {
  return resolveLogPath();
}