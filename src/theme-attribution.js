"use strict";

// Display attribution is separate from managed distribution ownership.
function themeAttribution(theme) {
  const category = theme.category === undefined ? "official" : theme.category;
  if (category !== "official" && category !== "community") {
    throw new Error("theme category must be official or community");
  }
  const author = theme.author;
  if (author !== undefined && (typeof author !== "string" || !author
    || author !== author.trim() || author.length > 160
    || /[\u0000-\u001f\u007f]/.test(author))) {
    throw new Error("theme author must be non-empty plain text of at most 160 characters");
  }
  if (category === "community" && author === undefined) {
    throw new Error("community themes must name their author");
  }
  return { category, author: author === undefined ? null : author };
}

module.exports = { themeAttribution };
