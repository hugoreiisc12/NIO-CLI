/**
 * Peças visuais da interface NIO (Ink). O histórico vai num `<Static>` (escreve
 * no scrollback, não re-renderiza); só a mensagem em andamento + o input ficam na
 * área dinâmica, com altura limitada pra nunca estourar o terminal.
 */

export * from './components-blocks.js';
export * from './components-message.js';
export * from './components-input.js';
