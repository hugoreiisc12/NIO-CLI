import type React from 'react';
import { Box, Text } from 'ink';
import { renderMatrixLogo } from '../matrix-logo.js';
import { theme } from './theme.js';

/** Abertura: logo Matrix + rótulo do motor. */
export function Splash({
  columns,
  engineLabel,
}: {
  columns: number;
  engineLabel: string;
}): React.ReactElement {
  return (
    <Box flexDirection="column" alignItems="center" paddingY={1}>
      <Text>{renderMatrixLogo({ width: Math.min(70, columns), height: 16 })}</Text>
      <Text color={theme.accent}>operador NIO · {engineLabel}</Text>
    </Box>
  );
}

/** Sprint 7.4 — o nio te perguntou algo e está esperando. */
export function AskedQuestion({
  question,
  columns,
}: {
  question: string;
  columns: number;
}): React.ReactElement {
  return (
    <Box paddingX={1}>
      <Text color={theme.accentBright} wrap="truncate-end">
        {'↳ o nio perguntou: '}
        <Text color={theme.text}>
          {question.length > columns - 24 ? question.slice(0, columns - 27) + '…' : question}
        </Text>
      </Text>
    </Box>
  );
}
