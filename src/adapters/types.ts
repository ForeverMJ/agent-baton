import type { AgentDirs } from "../core/paths.js";
import type { AgentName, Session, SessionRef } from "../model.js";

/**
 * An adapter knows how to find and parse one agent's local transcripts.
 * It must be read-only with respect to the agent's data.
 */
export interface Adapter {
  readonly name: AgentName;
  /** Is this agent's data present on this machine? */
  available(dirs: AgentDirs): Promise<boolean>;
  /** List sessions whose working directory is inside `projectRoot`. */
  discover(projectRoot: string, dirs: AgentDirs): Promise<SessionRef[]>;
  /**
   * List sessions in any directory, optionally only those updated since `since`.
   * Used to find sessions in *other clones* of the same repository.
   */
  list(dirs: AgentDirs, since?: Date): Promise<SessionRef[]>;
  /** Fully parse one session into the IR. */
  load(ref: SessionRef, dirs: AgentDirs): Promise<Session>;
}
