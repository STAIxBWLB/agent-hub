// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Ported to TypeScript from NVIDIA NeMo Switchyard crates/protocol/src/llm.rs at c8848511, modified.

/** Roles and content needed by the in-process routing algorithms. */
export type ConversationRole = 'system' | 'developer' | 'user' | 'assistant' | 'tool';

export interface NormalizedToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export interface NormalizedToolResult {
  toolCallId: string;
  content: string;
  isError?: boolean;
}

export interface NormalizedMessage {
  role: ConversationRole;
  content: string;
  toolCalls: NormalizedToolCall[];
  toolResults: NormalizedToolResult[];
}

export interface Conversation {
  instructions: string[];
  instructionRoles: Array<'system' | 'developer'>;
  messages: NormalizedMessage[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((part) => {
      const item = record(part);
      if (!item) return '';
      if (typeof item.text === 'string') return item.text;
      if (typeof item.content === 'string') return item.content;
      return '';
    }).filter(Boolean).join('\n');
  }
  return '';
}

function parsedArguments(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? {};
  try { return JSON.parse(value) as unknown; }
  catch { return { raw: value }; }
}

function normalizeToolCall(value: unknown): NormalizedToolCall | undefined {
  const call = record(value);
  if (!call) return undefined;
  const fn = record(call.function);
  const name = typeof fn?.name === 'string' ? fn.name : typeof call.name === 'string' ? call.name : '';
  if (!name) return undefined;
  const args = fn ? fn.arguments : call.arguments;
  return { id: typeof call.id === 'string' ? call.id : '', name, arguments: parsedArguments(args) };
}

/** Normalize an OpenAI chat request (or its messages array) to the route IR. */
export function normalizeConversation(input: unknown): Conversation {
  const root = record(input);
  const rawMessages = Array.isArray(input) ? input : Array.isArray(root?.messages) ? root.messages : [];
  const conversation: Conversation = { instructions: [], instructionRoles: [], messages: [] };
  for (const raw of rawMessages) {
    const item = record(raw);
    if (!item) continue;
    const role = typeof item.role === 'string' ? item.role : 'user';
    const content = contentText(item.content);
    if (role === 'system' || role === 'developer') {
      if (content) {
        conversation.instructions.push(content);
        conversation.instructionRoles.push(role);
      }
      continue;
    }
    const toolCalls = (Array.isArray(item.tool_calls) ? item.tool_calls : [])
      .map(normalizeToolCall).filter((call): call is NormalizedToolCall => call !== undefined);
    if (role === 'tool' || role === 'function') {
      conversation.messages.push({
        role: 'user', content: '', toolCalls: [],
        toolResults: [{
          toolCallId: typeof item.tool_call_id === 'string' ? item.tool_call_id : typeof item.name === 'string' ? item.name : '',
          content,
          ...(item.is_error === true || item.isError === true ? { isError: true } : {}),
        }],
      });
      continue;
    }
    const normalizedRole: ConversationRole = role === 'assistant' ? 'assistant' : 'user';
    conversation.messages.push({ role: normalizedRole, content, toolCalls, toolResults: [] });
  }
  return conversation;
}
