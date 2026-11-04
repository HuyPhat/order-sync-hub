import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './password.js';

describe('password hashing', () => {
  it('stores an argon2id PHC string, never the password', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$[\w+/]+\$[\w+/]+$/);
    expect(hash).not.toContain('correct horse');
  });

  it('uses a fresh random salt each time', async () => {
    expect(await hashPassword('same password!')).not.toBe(await hashPassword('same password!'));
  });

  it('accepts the right password and rejects a wrong one', async () => {
    const hash = await hashPassword('correct horse battery');
    await expect(verifyPassword('correct horse battery', hash)).resolves.toBe(true);
    await expect(verifyPassword('correct horse batterz', hash)).resolves.toBe(false);
  });

  it('rejects a malformed or foreign hash instead of throwing', async () => {
    await expect(verifyPassword('x', 'not-a-hash')).resolves.toBe(false);
    await expect(verifyPassword('x', '$argon2i$v=19$m=1,t=1,p=1$YQ$YQ')).resolves.toBe(false);
  });
});
