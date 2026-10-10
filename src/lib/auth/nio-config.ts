/**
 * Config compartilhada da equipe em `~/.nio/config.env` (`NIO_DATABASE_URL`,
 * `JWT_SECRET`). Ler/gravar (chmod 600), validar, e o wizard que `nio init`/
 * `register`/`login` disparam quando falta algo. `load-env.ts` carrega no boot.
 */

export * from './nio-config-core.js';
export * from './nio-config-wizard.js';
