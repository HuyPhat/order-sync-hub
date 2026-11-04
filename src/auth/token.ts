import { jwtVerify, SignJWT } from 'jose';
import { config } from '../config.js';

export const ROLES = ['admin', 'staff'] as const;
export type Role = (typeof ROLES)[number];
export interface AuthUser {
  id: number;
  role: Role;
}

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

const MIN_SECRET_LENGTH = 32;

// Same idea as dbPasswordProblem: a plain-language reason to refuse to start, or undefined.
export function jwtSecretProblem(secret: string): string | undefined {
  return secret.length >= MIN_SECRET_LENGTH
    ? undefined
    : `JWT_SECRET is not set or shorter than ${MIN_SECRET_LENGTH} characters (at least ${MIN_SECRET_LENGTH} required). Add it to .env (see .env.example) or the environment.`;
}

const key = () => new TextEncoder().encode(config.jwtSecret);

// The role rides in the token, so a role change only applies once the old token has expired.
export function signAccessToken({ id, role }: AuthUser): Promise<string> {
  return new SignJWT({ role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(String(id))
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(key());
}

// Throws for anything that is not a currently valid HS256 token issued by signAccessToken.
export async function verifyAccessToken(token: string): Promise<AuthUser> {
  const { payload } = await jwtVerify(token, key(), { algorithms: ['HS256'] });
  const id = Number(payload.sub);
  const role = ROLES.find((r) => r === payload['role']);
  if (!Number.isSafeInteger(id) || id < 1 || !role) throw new Error('Unexpected token claims');
  return { id, role };
}
