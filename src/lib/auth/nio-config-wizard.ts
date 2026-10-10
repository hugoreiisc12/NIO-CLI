import { brand } from '../../brand.js';
import { shutdown } from '../shutdown.js';
import { closePool, pingDetailed } from '../../adapters/pg/client.js';
import { generateJwtSecret, jwtSecretWeakness } from '../../gateway/config.js';
import { input, password, confirm, select } from '../prompts.js';
import { c, sym, box, cmd } from '../colors.js';
import { promptFabricCredentials, verifyFabricCredentials } from './fabric-config.js';
import type { ConfigProblem, SslMode } from './nio-config-core.js';
import {
  CONFIG_FILE,
  PG_URL,
  checkConfig,
  describePingFailure,
  readConfigFile,
  writeConfigFile,
} from './nio-config-core.js';

interface WizardValues {
  url: string;
  ssl: SslMode;
  jwt: string;
}

/** Pergunta o modo TLS. Tri-estado — "off" grava `NIO_DATABASE_SSL=false` explícito. */
async function promptSslMode(): Promise<SslMode> {
  return select<SslMode>({
    message: 'TLS/SSL com o Postgres?',
    default: 'off',
    choices: [
      { name: 'Sem TLS — banco interno/LAN (recomendado)', value: 'off' },
      { name: 'TLS com verificação de certificado — nuvem/gerenciado', value: 'verify' },
      { name: 'TLS sem verificar cert — self-signed (menos seguro)', value: 'insecure' },
    ],
  });
}

/** Os prompts do wizard (default = valor atual, se houver). */
async function promptWizard(): Promise<WizardValues> {
  const file = readConfigFile();
  const url = (
    await input({
      message: 'NIO_DATABASE_URL  (postgres://user:senha@host:5432/nio_cli)',
      default: process.env.NIO_DATABASE_URL ?? file.NIO_DATABASE_URL,
      validate: (v) => PG_URL.test(v.trim()) || 'precisa começar com postgres://',
    })
  ).trim();
  const ssl = await promptSslMode();
  const jwt = await promptJwtSecret(file.JWT_SECRET ?? process.env.JWT_SECRET);
  return { url, ssl, jwt };
}

/**
 * `JWT_SECRET`: se o time ainda não tem um, gera um forte aqui e o usuário
 * distribui; senão, cola o valor do time (validado por `jwtSecretWeakness`).
 */
async function promptJwtSecret(current: string | undefined): Promise<string> {
  if (!current || jwtSecretWeakness(current)) {
    const gen = await confirm({
      message:
        'Gerar um JWT_SECRET novo? (só se o time ainda não tem um — invalida sessões atuais)',
      default: !current,
    });
    if (gen) {
      const secret = generateJwtSecret();
      console.log(
        box(
          `${c.bold('JWT_SECRET gerado')} — distribua ${c.bold('este mesmo valor')} pra toda\n` +
            `máquina que roda o \`nio-gateway\` (ele assina/verifica o login):\n\n  ${c.green(secret)}`,
          { borderColor: 'green', title: 'guarde agora' },
        ),
      );
      return secret;
    }
  }
  return (
    await password({
      message: 'JWT_SECRET  (segredo compartilhado do time)',
      mask: '*',
      validate: (v) => jwtSecretWeakness(v.trim()) ?? true,
    })
  ).trim();
}

/** Wizard: cola `NIO_DATABASE_URL` + `JWT_SECRET`, testa a conexão, grava o arquivo. */
export async function runConfigWizard(): Promise<boolean> {
  console.log(
    box(
      `${c.bold('Configuração da NIO-CLI')}\n` +
        `${c.dim('Cole os valores que o time te passou — vão pra')} ${cmd(CONFIG_FILE)}\n` +
        `${c.dim('(só nesta máquina, chmod 600, nunca commitado).')}`,
      { borderColor: 'cyan', title: 'nio config' },
    ),
  );
  const { url, ssl, jwt } = await promptWizard();

  await closePool();
  process.env.NIO_DATABASE_URL = url;
  process.env.NIO_DATABASE_SSL = ssl === 'off' ? 'false' : 'true';
  if (ssl === 'insecure') process.env.NIO_DATABASE_SSL_INSECURE = '1';
  else delete process.env.NIO_DATABASE_SSL_INSECURE;
  process.env.JWT_SECRET = jwt;

  process.stdout.write(c.dim('  testando a conexão com o Postgres… '));
  const res = await pingDetailed();
  if (!res.ok) {
    console.log(c.red(sym.err));
    console.error(`  ${c.red('Não conectei.')} ${describePingFailure(res).hint}`);
    return false;
  }
  console.log(c.green(sym.ok));

  // Grava SSL explícito; valor vazio some no writeConfigFile (remove flag antigo).
  const updates: Record<string, string> = {
    NIO_DATABASE_URL: url,
    JWT_SECRET: jwt,
    NIO_DATABASE_SSL: ssl === 'off' ? 'false' : 'true',
    NIO_DATABASE_SSL_INSECURE: ssl === 'insecure' ? '1' : '',
  };
  Object.assign(updates, await collectFabricSection());
  writeConfigFile(updates);
  console.log(`  ${c.green(sym.ok)} salvo em ${cmd(CONFIG_FILE)}`);
  return true;
}

/**
 * Passo do Power BI/Fabric. Credencial que não autentica **não** reprova o wizard: o
 * banco e o JWT já foram validados e são o que a maioria dos comandos usa — barrar
 * tudo aqui deixaria a pessoa sem config nenhuma por causa de um segredo digitado
 * errado. Grava assim mesmo e avisa.
 */
async function collectFabricSection(): Promise<Record<string, string>> {
  console.log(`\n  ${c.bold('Power BI / Fabric')} ${c.dim('— credenciais da equipe')}`);
  const fabric = await promptFabricCredentials(readConfigFile());
  if (!fabric) return {};

  process.stdout.write(c.dim('  testando a credencial no Azure AD… '));
  const check = await verifyFabricCredentials(fabric);
  console.log(check.ok ? c.green(sym.ok) : c.yellow(sym.warn));
  console.log(`  ${c.dim(check.detail)}`);
  if (!check.ok) console.log(`  ${c.dim('salvo assim mesmo — corrija com `nio config setup`.')}`);
  return fabric;
}

function problemsBox(problems: ConfigProblem[]): string {
  const label = { missing: 'faltando', invalid: 'inválido', unreachable: 'sem conexão' };
  return box(
    `${c.yellow(sym.warn)} ${c.bold('Config incompleta ou inválida.')}\n\n` +
      problems
        .map(
          (p) =>
            `${c.red(sym.err)} ${c.bold(p.key)} ${c.dim('— ' + label[p.issue])}\n   ${c.dim(p.hint)}`,
        )
        .join('\n') +
      `\n\n${c.dim('Rode')} ${cmd(`${brand.name} config setup`)} ${c.dim('ou crie')} ${cmd(CONFIG_FILE)} ${c.dim('com:')}\n` +
      `   ${c.dim('NIO_DATABASE_URL=postgres://user:senha@host:5432/nio_cli')}\n` +
      `   ${c.dim('JWT_SECRET=<segredo-do-time>')}`,
    { borderColor: 'yellow', title: 'Configuração necessária' },
  );
}

/**
 * Garante a config antes de um comando que precisa dela. TTY + algo faltando/
 * inválido → dispara o wizard. Só rede fora, ou não-TTY → erro e `exit 1`.
 */
export async function ensureConfig(opts: { interactive: boolean }): Promise<void> {
  let problems = await checkConfig();
  if (problems.length === 0) return;

  const fixable = problems.some((p) => p.issue !== 'unreachable' || p.fixable);
  if (opts.interactive && process.stdin.isTTY && fixable && (await runConfigWizard())) {
    problems = await checkConfig();
    if (problems.length === 0) return;
  }

  console.error(problemsBox(problems));
  await shutdown(1); // fecha o pool do checkConfig antes de sair (crash libuv no Windows)
  process.exit(1);
}
