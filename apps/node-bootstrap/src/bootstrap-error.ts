// SPDX-License-Identifier: Apache-2.0
/** Safe public error codes shared by native bootstrap tools. */
export class BootstrapError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
