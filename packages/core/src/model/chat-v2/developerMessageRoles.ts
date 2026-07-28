import type { ChatMessage } from '../DataValue.js';

export type InstructionMessageRole = Extract<ChatMessage['type'], 'system' | 'developer'>;

export function getInstructionMessageRoles(messages: ChatMessage[]): InstructionMessageRole[] {
  return messages
    .filter(
      (message): message is Extract<ChatMessage, { type: InstructionMessageRole }> =>
        message.type === 'system' || message.type === 'developer',
    )
    .map((message) => message.type);
}

/**
 * AI SDK's provider-neutral ModelMessage represents both Rivet system and
 * developer instructions with role `system`. Restore the explicit Rivet roles
 * only at OpenAI-compatible wire boundaries, after the provider has built its
 * request body.
 */
export function restoreOpenAICompatibleInstructionRoles(body: unknown, roles: InstructionMessageRole[]): unknown {
  if (roles.length === 0) {
    return body;
  }

  if (body == null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Could not preserve developer messages: provider request body is not a JSON object.');
  }

  const record = body as Record<string, unknown>;
  const listKey = Array.isArray(record.messages) ? 'messages' : Array.isArray(record.input) ? 'input' : undefined;
  if (listKey == null) {
    throw new Error('Could not preserve developer messages: provider request body has no messages or input array.');
  }

  const items = record[listKey] as unknown[];
  const instructionIndexes = items.flatMap((item, index) =>
    item != null &&
    typeof item === 'object' &&
    !Array.isArray(item) &&
    ((item as Record<string, unknown>).role === 'system' || (item as Record<string, unknown>).role === 'developer')
      ? [index]
      : [],
  );

  if (instructionIndexes.length !== roles.length) {
    throw new Error(
      `Could not preserve developer messages: expected ${roles.length} instruction message(s), but the provider request contains ${instructionIndexes.length}.`,
    );
  }

  const rewrittenItems = [...items];
  instructionIndexes.forEach((itemIndex, roleIndex) => {
    rewrittenItems[itemIndex] = {
      ...(rewrittenItems[itemIndex] as Record<string, unknown>),
      role: roles[roleIndex],
    };
  });

  return {
    ...record,
    [listKey]: rewrittenItems,
  };
}
