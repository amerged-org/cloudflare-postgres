// SPDX-License-Identifier: Apache-2.0
/** Selected architecture-specific manifest is authoritative; the original index is legacy/provenance only. */
export function selectedImageManifestDigest(value:unknown):string|undefined {
  if(!value || typeof value!=="object" || Array.isArray(value)) throw new Error("image_manifest_entry_invalid");
  const image=value as Record<string,unknown>;
  if(Object.hasOwn(image,"manifestDigest")) {
    if(typeof image.manifestDigest!=="string"||!/^sha256:[0-9a-f]{64}$/.test(image.manifestDigest)) throw new Error("image_selected_manifest_invalid");
    return image.manifestDigest;
  }
  if(image.indexDigest===undefined) return undefined;
  if(typeof image.indexDigest!=="string"||!/^sha256:[0-9a-f]{64}$/.test(image.indexDigest)) throw new Error("image_legacy_index_invalid");
  return image.indexDigest;
}
