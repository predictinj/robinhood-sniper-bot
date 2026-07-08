import pino from 'pino';

const level = process.env.LOG_LEVEL ?? 'info';
const pretty = process.env.NODE_ENV !== 'production' && process.stdout.isTTY;

/**
 * Root logger. Redaction is defence-in-depth: nothing in the codebase should
 * ever pass a private key to a log call, but if it happens it is censored.
 */
export const logger = pino({
  level,
  redact: {
    paths: [
      'privateKey',
      '*.privateKey',
      'PRIVATE_KEY',
      '*.PRIVATE_KEY',
      'config.privateKey',
      'account.privateKey',
    ],
    censor: '[REDACTED]',
  },
  ...(pretty
    ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } } }
    : {}),
});

export function childLogger(scope: string) {
  return logger.child({ scope });
}
