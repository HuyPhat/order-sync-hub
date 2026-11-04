import { UniqueConstraintError } from 'sequelize';
import { UnauthorizedError } from '../auth/errors.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import type { AuthUser, Role } from '../auth/token.js';
import { User } from '../models/index.js';

export class EmailTakenError extends Error {
  override name = 'EmailTakenError';
  constructor() {
    super('Email already registered');
  }
}

export interface NewUser {
  email: string;
  password: string;
  role: Role;
}

// What a client may see of a user: never the hash.
export interface PublicUser {
  id: number;
  email: string;
  role: Role;
}

// Expects an already lowercased email (the routes do that). The unique index is the real guard
// against duplicates, so two concurrent requests cannot both succeed.
export async function createUser({ email, password, role }: NewUser): Promise<PublicUser> {
  const passwordHash = await hashPassword(password);
  try {
    const user = await User.create({ email, passwordHash, role });
    return { id: user.id, email: user.email, role: user.role };
  } catch (error) {
    if (error instanceof UniqueConstraintError) throw new EmailTakenError();
    throw error;
  }
}

// Verified against when the email is unknown, so "no such user" takes as long as "wrong password"
// and the response time does not reveal which emails exist.
let unknownUserHash: Promise<string> | undefined;

// An unknown email and a wrong password fail identically.
export async function authenticate(email: string, password: string): Promise<AuthUser> {
  const user = await User.findOne({ where: { email } });
  const hash = user?.passwordHash ?? (await (unknownUserHash ??= hashPassword('unknown user')));
  const passwordMatches = await verifyPassword(password, hash);
  if (!user || !passwordMatches) throw new UnauthorizedError('Invalid credentials');
  return { id: user.id, role: user.role };
}
