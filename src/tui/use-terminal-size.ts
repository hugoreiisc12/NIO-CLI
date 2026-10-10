import { useEffect, useState } from 'react';
import { useStdout } from 'ink';

/** rows/columns do terminal, reativo ao resize. */
export function useTerminalSize(): { rows: number; columns: number } {
  const { stdout } = useStdout();
  const [size, setSize] = useState({ rows: stdout?.rows ?? 24, columns: stdout?.columns ?? 80 });
  useEffect(() => {
    if (!stdout) return;
    const on = () => setSize({ rows: stdout.rows ?? 24, columns: stdout.columns ?? 80 });
    stdout.on('resize', on);
    return () => {
      stdout.off('resize', on);
    };
  }, [stdout]);
  return size;
}
