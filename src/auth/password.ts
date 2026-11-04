import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const argon2Async = promisify(argon2);

// OWASP's argon2id minimum: 19 MiB, 2 passes, 1 lane. The parameters are stored in the hash,
// so raising them later does not break existing passwords.
const MEMORY_KIB = 19456;
const PASSES = 2;
const PARALLELISM = 1;
const TAG_LENGTH = 32;

const derive = (password: string, salt: Buffer, m: number, t: number, p: number, len: number) =>
  argon2Async('argon2id', {
    message: password,
    nonce: salt,
    memory: m,
    passes: t,
    parallelism: p,
    tagLength: len,
  });

const b64 = (bytes: Buffer) => bytes.toString('base64').replace(/=+$/, '');

// PHC string: $argon2id$v=19$m=..,t=..,p=..$<salt>$<hash>, base64 without padding.
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const tag = await derive(password, salt, MEMORY_KIB, PASSES, PARALLELISM, TAG_LENGTH);
  return `$argon2id$v=19$m=${MEMORY_KIB},t=${PASSES},p=${PARALLELISM}$${b64(salt)}$${b64(tag)}`;
}

const PHC = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([\w+/]+)\$([\w+/]+)$/;

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const match = PHC.exec(stored);
  if (!match) return false;
  const [, m, t, p, salt, hash] = match as unknown as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const expected = Buffer.from(hash, 'base64');
  const actual = await derive(password, Buffer.from(salt, 'base64'), +m, +t, +p, expected.length);
  return timingSafeEqual(actual, expected);
}
