(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.petAccessoryDescriptor = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const SAFE_ITEM_ID = /^[a-z][a-z0-9-]{0,31}$/;
  const SAFE_BASENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;

  function resolveAccessoryDescriptor(input) {
    if (!input || typeof input !== "object") return null;
    const attachments = input.attachments;
    const itemId = input.itemId;
    const file = input.file;
    if (!attachments || typeof attachments !== "object") return null;
    if (typeof itemId !== "string" || !SAFE_ITEM_ID.test(itemId)) return null;
    if (typeof file !== "string" || !SAFE_BASENAME.test(file)) return null;

    if (
      attachments.itemOverrides
      && attachments.itemOverrides[itemId]
      && attachments.itemOverrides[itemId].files
      && Object.prototype.hasOwnProperty.call(attachments.itemOverrides[itemId].files, file)
    ) {
      return attachments.itemOverrides[itemId].files[file] || null;
    }

    if (
      attachments.files
      && Object.prototype.hasOwnProperty.call(attachments.files, file)
    ) {
      return attachments.files[file] || null;
    }
    return null;
  }

  return {
    resolveAccessoryDescriptor,
  };
});
