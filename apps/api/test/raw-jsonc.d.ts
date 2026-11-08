// SPDX-License-Identifier: Apache-2.0
// Vite's ?raw import of a JSONC file: the module's default export is its text.
declare module "*.jsonc?raw" {
  const text: string;
  export default text;
}
