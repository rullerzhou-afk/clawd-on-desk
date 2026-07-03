const TRANSCRIPT_PATH_MAX = 4096;

function normalizeTranscriptPath(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > TRANSCRIPT_PATH_MAX || /[\0\r\n]/.test(text)) return null;
  return text;
}

module.exports = {
  TRANSCRIPT_PATH_MAX,
  normalizeTranscriptPath,
};
