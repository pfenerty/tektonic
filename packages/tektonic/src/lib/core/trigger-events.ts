/** GitHub webhook event types that can trigger a pipeline. */
export enum TRIGGER_EVENTS {
  /** Fires on pushes to branches (excludes tag pushes when a tag pipeline is configured). */
  PUSH = 'push',
  /** Fires on pull request opened/synchronized events. */
  PULL_REQUEST = 'pull_request',
  /** Fires on tag pushes (filtered via CEL interceptor on `refs/tags/`). */
  TAG = 'tag',
}
