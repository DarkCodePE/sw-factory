// How fab re-launches itself. From source, a subcommand is a separate `.ts` entry run by Bun;
// in a standalone `bun build --compile` binary those files only exist inside the binary, so the
// same executable is invoked again with a subcommand instead.
import { fileURLToPath } from 'node:url';

/** True when running from a standalone executable built with `bun build --compile`. */
export const isCompiled = () => Bun.main.includes('$bunfs') || import.meta.url.includes('$bunfs');

/**
 * argv that runs one fab entry point in a fresh process.
 * @param subcommand hidden CLI subcommand used by the compiled binary
 * @param entry module URL of the source entry used when running from source
 */
export function selfCommand(subcommand: string, entry: URL): string[] {
  return isCompiled() ? [process.execPath, subcommand] : [process.execPath, '--no-env-file', fileURLToPath(entry)];
}
