import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import app from '../app.js';
import { UnauthorizedError } from '../auth/errors.js';
import { signAccessToken } from '../auth/token.js';
import { sequelize } from '../db/sequelize.js';
import { User } from '../models/index.js';
import { EmailTakenError, authenticate, createUser } from './users.js';

// Runs against the TEST database (see vitest.integration.config.ts), real MySQL, nothing mocked.
beforeEach(async () => {
  await User.destroy({ where: {} });
});

afterAll(async () => {
  await sequelize.close();
});

const password = 'a-long-enough-password';

describe('createUser', () => {
  it('stores an argon2id hash, not the password, and returns no hash', async () => {
    const created = await createUser({ email: 'a@example.com', password, role: 'staff' });
    expect(created).toEqual({ id: expect.any(Number), email: 'a@example.com', role: 'staff' });

    const row = await User.findByPk(created.id);
    expect(row?.passwordHash).toMatch(/^\$argon2id\$/);
    expect(row?.passwordHash).not.toContain(password);
  });

  it('rejects a duplicate email, even in another letter case, and creates nothing', async () => {
    await createUser({ email: 'a@example.com', password, role: 'staff' });
    await expect(
      createUser({ email: 'A@Example.com', password, role: 'admin' }),
    ).rejects.toBeInstanceOf(EmailTakenError);
    expect(await User.count()).toBe(1);
  });

  it('lets only one of two concurrent requests for the same email win', async () => {
    const results = await Promise.allSettled([
      createUser({ email: 'race@example.com', password, role: 'staff' }),
      createUser({ email: 'race@example.com', password, role: 'staff' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await User.count()).toBe(1);
  });
});

describe('authenticate', () => {
  it('returns the id and role for the right password', async () => {
    const { id } = await createUser({ email: 'a@example.com', password, role: 'admin' });
    await expect(authenticate('a@example.com', password)).resolves.toEqual({ id, role: 'admin' });
  });

  it('fails the same way for a wrong password and an unknown email', async () => {
    await createUser({ email: 'a@example.com', password, role: 'staff' });
    const wrongPassword = await authenticate('a@example.com', 'wrong-password!!').catch((e) => e);
    const unknownEmail = await authenticate('nobody@example.com', password).catch((e) => e);
    expect(wrongPassword).toBeInstanceOf(UnauthorizedError);
    expect(unknownEmail).toBeInstanceOf(UnauthorizedError);
    expect(unknownEmail.message).toBe(wrongPassword.message);
  });
});

describe('the whole flow over HTTP', () => {
  it('an admin creates a user, who logs in and reaches /orders but not /users', async () => {
    const admin = await createUser({ email: 'admin@example.com', password, role: 'admin' });
    const adminToken = await signAccessToken({ id: admin.id, role: 'admin' });

    const created = await request(app)
      .post('/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: 'Staff@Example.com', password, role: 'staff' });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({
      id: expect.any(Number),
      email: 'staff@example.com',
      role: 'staff',
    });

    const login = await request(app)
      .post('/auth/login')
      .send({ email: 'STAFF@example.com', password });
    expect(login.status).toBe(200);
    const auth = { Authorization: `Bearer ${login.body.accessToken}` };

    expect((await request(app).get('/orders/999999').set(auth)).status).toBe(404);
    expect((await request(app).post('/users').set(auth).send({})).status).toBe(403);
  });

  it('answers 401 for a wrong password and for an unknown email alike', async () => {
    await createUser({ email: 'a@example.com', password, role: 'staff' });
    const wrong = await request(app)
      .post('/auth/login')
      .send({ email: 'a@example.com', password: 'wrong-password!!' });
    const unknown = await request(app)
      .post('/auth/login')
      .send({ email: 'nobody@example.com', password });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(unknown.body).toEqual(wrong.body);
  });
});
