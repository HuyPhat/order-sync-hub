import { describe, expect, it } from 'vitest';
import { dbPasswordProblem } from './preflight.js';

describe('dbPasswordProblem', () => {
  it('reports a missing password in plain language', () => {
    expect(dbPasswordProblem('')).toMatch(/MYSQL_PASSWORD is not set/);
  });

  it('names where to set it', () => {
    expect(dbPasswordProblem('')).toMatch(/\.env/);
  });

  it('reports nothing when a password is present', () => {
    expect(dbPasswordProblem('s3cret')).toBeUndefined();
  });
});
