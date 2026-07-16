import { EventEmitter } from "node:events";
import { config } from "../config/env";
import { availableTools, ToolCall, ToolResult } from "./tools";
import { SYSTEM_PROMPT } from "./system-prompt";
import { log } from "../utils/logger";

const SILENT_ACTION_TOOLS = new Set([
  "open_application",
  "quit_application",
  "quit_all_applications",
  "open_url",
  "type_text",
  "press_keys",
  "create_note",
  "create_reminder",
  "create_calendar_event",
  "set_timer",
  "set_alarm",
  "write_file",
  "create_file",
  "delete_file",
  "list_directory",
  "read_file",
  "read_selected_text",
  "get_frontmost_application",
  "search_notes",
  "get_calendar_events",
  "switch_audio_output",
  "trim_video",
  "convert_video",
  "convert_document",
  "edit_document",
  "edit_pdf",
  "scrape_url",
  "get_clipboard_text",
]);

export function getChatCompletionsUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  return /\/v1$/i.test(normalized)
    ? `${normalized}/chat/completions`
    : `${normalized}/v1/chat/completions`;
}

const INSPECTION_TOOLS = new Set([
  "list_directory",
  "read_file",
  "read_selected_text",
  "get_frontmost_application",
  "search_notes",
  "get_calendar_events",
  "convert_document",
  "scrape_url",
  "get_clipboard_text",
]);

const MAX_CALLS_PER_TOOL = 8;

const CONTINUE_AFTER_TOOLS = new Set([
  "edit_document",
  "write_file",
  "create_file",
  "convert_document",
  "edit_pdf"
]);

const SEQUENTIAL_ACTION_TOOLS = new Set([
  "open_application",
  "open_url",
  "type_text",
  "press_keys",
]);

const MAX_COMPOUND_ACTION_FOLLOW_UPS = 3;

export function isCompoundActionRequest(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return false;
  if (/(?:然后|接着|随后|之后|并且|同时|再去|再来|再把)/.test(normalized)) return true;

  const actionVerbs = normalized.match(/(?:打开|进入|访问|搜索|搜|输入|填写|点击|发送|播放|关闭)/g) || [];
  return actionVerbs.length >= 2;
}

function latestUserMessage(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return messages[i].content || "";
  }
  return "";
}

function maxCallsForTool(name: string): number {
  return CONTINUE_AFTER_TOOLS.has(name) ? 20 : MAX_CALLS_PER_TOOL;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  reasoning_content?: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: {
      name: string;
      arguments: string;
    };
  }>;
}

export interface DualChannel {
  speech: string;
  display: string;
}

/**
 * 统一的 TTS 文本清洗函数。
 * 去除 Markdown 符号、emoji、特殊字符，替换为 TTS 可朗读的形式。
 * 所有进入 TTS 的文本必须经过此函数清洗。
 */
export function cleanTextForTTS(text: string): string {
  return text
    .replace(/<display>[\s\S]*?<\/display>/gi, "")
    .replace(/<\/?display>/gi, "")
    .replace(/<\/?speech>/gi, "")
    .replace(/\{"display"\s*:\s*"?/g, "")
    .replace(/"speech"\s*:\s*"?/g, "")
    .replace(/"\s*\}/g, "")
    .replace(/\\n/g, " ")
    .replace(/\\["\\/]/g, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1")
    .replace(/_{1,3}([^_]+)_{1,3}/g, "$1")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "")
    .replace(/^[-*+]\s+/gm, "")
    .replace(/^\d+\.\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/[*#_|]/g, "") // Keep ~
    .replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}\u{2B50}\u{2B55}\u{2702}\u{2705}\u{2708}-\u{270F}\u{2764}\u{2763}\u{00A9}\u{00AE}\u{2122}\u{200D}\u{FE0F}]/gu, "")
    .replace(/℃/g, "度")
    .replace(/°C/g, "度")
    .replace(/°/g, "度")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * 协议解析器 —— 极速单通道模式：
 * display 为大模型输出的原始文本（可含 Markdown）
 * speech 为自动经过 cleanTextForTTS 过滤清洗后的纯文本，用于合成语音
 */
function parseDualChannel(text: string): DualChannel {
  // 兼容性清洗：防范历史遗留会话里可能带有的标签，进行剥离
  const display = text.replace(/<display>[\s\S]*?<\/display>/gi, "").replace(/<\/?display>/gi, "").replace(/<\/?speech>/gi, "").trim() || text;
  const speech = cleanTextForTTS(text);
  return { display, speech };
}

export class DeepSeekClient extends EventEmitter {
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private conversation: ChatMessage[] = [];
  private abortController: AbortController | null = null;
  private aborted = false;
  private toolCallCounts = new Map<string, number>();
  private chatLoopCount = 0;
  private commandExecutionCounts = new Map<string, number>();
  private compoundActionFollowUps = 0;

  constructor(existingMessages?: ChatMessage[]) {
    super();
    this.apiKey = config.llm.apiKey;
    this.baseUrl = config.llm.baseUrl.replace(/\/$/, "");
    this.model = config.llm.model;
    this.conversation = existingMessages && existingMessages.length > 0
      ? [...existingMessages]
      : [{ role: "system", content: SYSTEM_PROMPT }];
  }

  getConversation(): ChatMessage[] {
    return this.conversation;
  }

  abort(): void {
    this.aborted = true;
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.removeAllListeners();
  }



  async sendMessage(text: string): Promise<void> {
    this.aborted = false;
    this.chatLoopCount = 0;
    this.commandExecutionCounts.clear();
    this.compoundActionFollowUps = 0;
    try {
      await this.streamChat(this.conversation);
    } catch (error) {
      if (this.aborted) return;
      this.emit("error", error instanceof Error ? error.message : String(error));
    }
  }

  private async streamChat(messages: ChatMessage[]): Promise<void> {
    if (this.aborted) {
      log(`DeepSeekClient: streamChat called but client is aborted. Exiting.`);
      return;
    }
    this.chatLoopCount++;
    if (this.chatLoopCount > 100) {
      log(`DeepSeekClient: Absolute safety guard triggered (count=${this.chatLoopCount}). Forcing break.`);
      this.emit("error", "任务执行步骤过多（已达100步），已自动中止以防死循环。");
      return;
    }
    const allowedTools = availableTools.filter(
      t => (this.toolCallCounts.get(t.function.name) || 0) < maxCallsForTool(t.function.name)
    );
    if (allowedTools.length === 0) {
      log(`DeepSeekClient: all tools reached max calls, forcing final answer`);
    }
    this.abortController = new AbortController();
    const response = await fetch(getChatCompletionsUrl(this.baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        stream: true,
        max_tokens: 8192,
        tools: allowedTools.length > 0 ? allowedTools : undefined,
        tool_choice: allowedTools.length > 0 ? "auto" : "none",
        thinking: {
          type: config.llm.thinkingEnabled ? "enabled" : "disabled"
        },
        ...(config.llm.thinkingEnabled ? {
          reasoning_effort: config.llm.reasoningEffort,
          reasoningeffort: config.llm.reasoningEffort
        } : {})
      }),
      signal: this.abortController.signal,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`DeepSeek API 错误 ${response.status}: ${body}`);
    }

    if (!response.body) {
      throw new Error("DeepSeek 返回空响应体");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");

    let buffer = "";
    let assistantContent = "";
    let assistantReasoningContent = "";
    const toolCalls: ToolCall[] = [];
    let toolAckEmitted = false;

    while (true) {
      if (this.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;

        const data = trimmed.slice(6);
        if (data === "[DONE]") continue;

        try {
          const chunk = JSON.parse(data);
          const delta = chunk.choices?.[0]?.delta;
          if (!delta) continue;

          if (delta.content) {
            assistantContent += delta.content;
          }

          if (delta.reasoning_content) {
            assistantReasoningContent += delta.reasoning_content;
          }

          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const last = toolCalls[toolCalls.length - 1];
              if (!tc.id && last) {
                last.function.arguments += tc.function?.arguments || "";
                if (tc.function?.name) last.function.name = tc.function.name;
                continue;
              }
              const existing = toolCalls.find((t) => t.id === tc.id);
              if (existing) {
                existing.function.arguments += tc.function?.arguments || "";
                if (tc.function?.name) existing.function.name = tc.function.name;
              } else {
                toolCalls.push({
                  id: tc.id,
                  function: {
                    name: tc.function?.name || "",
                    arguments: tc.function?.arguments || "",
                  },
                });
              }
            }
          }
        } catch {
          // ignore parse errors
        }
      }
    }

    // Check if aborted during streaming
    if (this.aborted) return;

    if (toolCalls.length > 0) {
      const allSilent = toolCalls.every(tc => SILENT_ACTION_TOOLS.has(tc.function.name));

      if (allSilent) {
        log(`DeepSeekClient: all tool calls are silent action tools. Executing silently...`);
        this.conversation.push({
          role: "assistant",
          content: assistantContent || "",
          reasoning_content: assistantReasoningContent || undefined,
          tool_calls: toolCalls.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: tc.function,
          })),
        });

        const toolResults = await this.executeToolCalls(toolCalls);
        if (this.aborted) return;
        this.conversation.push(...toolResults.map((r) => ({
          role: "tool" as const,
          content: r.content,
          tool_call_id: r.tool_call_id,
        })));

        const failed = toolResults.some(r =>
          /无法|失败|错误|Error|Failed|not found|does not|invalid|cannot|could not/i.test(r.content)
        );

        if (failed) {
          log(`DeepSeekClient: Silent tool execution failed. Falling back to chat to report...`);
          toolAckEmitted = false;
          await this.streamChat(this.conversation);
          return;
        }

        const hasInspection = toolCalls.some(tc => INSPECTION_TOOLS.has(tc.function.name));
        const hasContinueAfter = toolCalls.some(tc => CONTINUE_AFTER_TOOLS.has(tc.function.name));
        const needsCompoundActionFollowUp =
          this.compoundActionFollowUps < MAX_COMPOUND_ACTION_FOLLOW_UPS &&
          isCompoundActionRequest(latestUserMessage(this.conversation)) &&
          toolCalls.some(tc => SEQUENTIAL_ACTION_TOOLS.has(tc.function.name));

        if (needsCompoundActionFollowUp) {
          this.compoundActionFollowUps++;
          log(`DeepSeekClient: compound action remains eligible for follow-up (${this.compoundActionFollowUps}/${MAX_COMPOUND_ACTION_FOLLOW_UPS}). Continuing chat loop...`);
        }

        if (hasInspection || hasContinueAfter || needsCompoundActionFollowUp) {
          log(`DeepSeekClient: Silent tools need follow-up (inspection/continue-after). Continuing chat loop to let LLM verify and continue...`);
          toolAckEmitted = false;
          await this.streamChat(this.conversation);
          return;
        }

        this.emit("silent_done");
        return;
      }

      if (!toolAckEmitted && assistantContent.trim()) {
        const parsed = parseDualChannel(assistantContent);
        log(`Tool ack raw: ${assistantContent}`);
        log(`Tool ack speech: ${parsed.speech}`);
        this.emit("tool_ack", parsed.speech);
      }

      this.conversation.push({
        role: "assistant",
        content: assistantContent || "",
        reasoning_content: assistantReasoningContent || undefined,
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: tc.function,
        })),
      });

      const toolResults = await this.executeToolCalls(toolCalls);
      if (this.aborted) return;
      this.conversation.push(...toolResults.map((r) => ({
        role: "tool" as const,
        content: r.content,
        tool_call_id: r.tool_call_id,
      })));

      toolAckEmitted = false;
      await this.streamChat(this.conversation);
      return;
    }

    if (this.aborted) return;
    const parsed = parseDualChannel(assistantContent);
    log(`LLM raw response: ${assistantContent}`);
    log(`LLM speech text: ${parsed.speech}`);
    this.conversation.push({
      role: "assistant",
      content: parsed.display,
      reasoning_content: assistantReasoningContent || undefined
    });


    this.emit("done", parsed);
  }

  private async executeToolCalls(toolCalls: ToolCall[]): Promise<ToolResult[]> {
    const { executeTool } = await import("../control/macos");
    const results: ToolResult[] = [];

    for (const tc of toolCalls) {
      let result: string;
      const signature = `${tc.function.name}:${tc.function.arguments.trim()}`;
      const currentCount = this.commandExecutionCounts.get(signature) || 0;
      const isWhiteListed = ["capture_screen", "get_current_time"].includes(tc.function.name);

      if (!isWhiteListed && currentCount >= 7) {
        log(`[LOOP_PREVENT] Command repeated too many times (count=${currentCount}): ${signature}. Intercepting.`);
        result = `Error: You have already executed this exact command [${tc.function.name}] with these arguments ${currentCount} times in this turn. Repeating it further will yield the identical result. Please stop repeating, try a different approach, or report failure to the user.`;
      } else {
        if (!isWhiteListed) {
          this.commandExecutionCounts.set(signature, currentCount + 1);
        }
        result = await executeTool(tc.function.name, tc.function.arguments);
      }
      this.toolCallCounts.set(tc.function.name, (this.toolCallCounts.get(tc.function.name) || 0) + 1);
      results.push({
        tool_call_id: tc.id,
        role: "tool",
        content: result,
      });
    }

    return results;
  }
}
