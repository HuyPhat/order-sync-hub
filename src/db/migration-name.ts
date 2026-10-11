// Umzug names a migration after its file, so the same migration is `...create-products.ts` when
// run with tsx and `...create-products.js` when run from dist/. Dropping the extension gives both
// runners one shared history in SequelizeMeta.
export function migrationName(filename: string): string {
  return filename.replace(/\.(ts|js)$/, '');
}
