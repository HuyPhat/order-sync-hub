// A missing password otherwise surfaces as "Access denied (using password: NO)" from deep inside
// mysql2. Returns a plain-language problem, or undefined when the settings look usable.
export function dbPasswordProblem(password: string): string | undefined {
  return password
    ? undefined
    : 'MYSQL_PASSWORD is not set. Add it to .env (see .env.example) or the environment.';
}
