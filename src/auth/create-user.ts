// Creates a user from the command line; this is how the first admin gets in, since there is no
// open signup. The password is read from stdin so it never lands in argv or shell history:
//   read -rs PW; printf '%s' "$PW" | pnpm user:create admin@example.com admin
import { text } from 'node:stream/consumers';
import { ZodError } from 'zod';
import { config } from '../config.js';
import { dbPasswordProblem } from '../db/preflight.js';
import { sequelize } from '../db/sequelize.js';
import { newUserBody } from '../routes/auth.js';
import { EmailTakenError, createUser } from '../services/users.js';

const problem = dbPasswordProblem(config.db.password);
if (problem) {
  console.error(problem);
  process.exit(1);
}

const [email, role] = process.argv.slice(2);

try {
  const password = (await text(process.stdin)).replace(/\r?\n$/, '');
  const user = await createUser(newUserBody.parse({ email, password, role }));
  console.log(`Created ${user.role} ${user.email} (id ${user.id})`);
} catch (error) {
  if (error instanceof ZodError) {
    console.error('Usage: printf \'%s\' "$PASSWORD" | pnpm user:create <email> <admin|staff>');
    for (const { path, message } of error.issues) console.error(`  ${path.join('.')}: ${message}`);
  } else if (error instanceof EmailTakenError) {
    console.error(error.message);
  } else {
    throw error;
  }
  process.exitCode = 1;
} finally {
  await sequelize.close();
}
