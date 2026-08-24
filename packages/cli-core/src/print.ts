/**
 * Print `body` to stdout. Strings get a trailing newline if missing;
 * everything else is pretty-printed JSON.
 */
export function print(body: unknown): void {
  if (typeof body === 'string') {
    process.stdout.write(body);
    if (!body.endsWith('\n')) process.stdout.write('\n');
  } else {
    process.stdout.write(JSON.stringify(body, null, 2) + '\n');
  }
}
