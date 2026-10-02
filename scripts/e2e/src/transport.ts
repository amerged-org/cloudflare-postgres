// SPDX-License-Identifier: Apache-2.0
// https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/#considerations
export function workerScanUnsupported(port: number, message = ""): boolean {
  return (
    port === 25 ||
    /TCP Loop|not allowed|disallowed|unsupported|prohibited|too many|limit exceeded|proxy request failed, cannot connect/i.test(
      message,
    )
  );
}
