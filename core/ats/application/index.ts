/**
 * Everything the dashboard needs, on top of the ATS domain/infra modules.
 * One file per concern (was a single 1400+ line file); this barrel is the single
 * entrypoint consumers (the Next.js API route, the CLI) import from.
 */
import '../../platform/settings-store'; // saved dashboard settings override .env

export * from './state';
export * from './platforms';
export * from './sources-yaml';
export * from './job-settings';
export * from './jobs';
export * from './scoring';
export * from './chat';
export * from './integrations';
export * from './report';
export * from './files';
export * from './sheet-sync';
export * from './site-status';
export * from './data-tasks';
