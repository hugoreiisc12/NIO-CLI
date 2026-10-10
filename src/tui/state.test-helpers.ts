import type { Event } from '@opencode-ai/sdk';
import type { PartDelta } from './state.js';

export const ev = (type: string, properties: unknown): Event =>
  ({ type, properties }) as unknown as Event;

export const toolPart = (
  name: string,
  status: string,
  input: Record<string, unknown>,
  output = '',
) => ({
  id: `t-${name}-${status}`,
  kind: 'tool' as const,
  text: name,
  tool: { name, status, input, output },
});
export const reasoningPart = (t: string) => ({
  id: `r-${t.slice(0, 5)}`,
  kind: 'reasoning' as const,
  text: t,
});

export const delta = (field: string, text: string, partID = 'prt_1'): PartDelta => ({
  messageID: 'msg_d',
  partID,
  field,
  delta: text,
});
