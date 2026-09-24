import { notImplemented } from '../format/errors';
import type { Config } from '../config';
import type { LoadedSource } from './types';

/**
 * Resolve a `wc_open` source (M1.1): a path inside `config.roots`, an
 * `http(s)` URL (size limit + timeout, never following to `file:`), or
 * literal code. The type is auto-detected.
 */
export function loadSource(
  source: string,
  config: Config,
): Promise<LoadedSource> {
  void source;
  void config;
  return notImplemented('M1.1');
}
