import type { Config } from './config.js';

// The admin page can open profile creation for a limited time while
// DISABLE_USER_CREATION=true. The window lives in memory, so a restart closes it.
export class UserCreation {
  #openUntil = 0;
  constructor(private readonly config: Pick<Config, 'disableUserCreation'>) {}
  allowed() {
    return !this.config.disableUserCreation || this.openUntil() !== null;
  }
  // When the temporary window ends, or null when none is open.
  openUntil() {
    return this.#openUntil > Date.now() ? this.#openUntil : null;
  }
  open(milliseconds: number) {
    this.#openUntil = Date.now() + milliseconds;
  }
  close() {
    this.#openUntil = 0;
  }
}
