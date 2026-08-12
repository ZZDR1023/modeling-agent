export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fenced?.[1]?.trim() ?? trimmed;

  try {
    return JSON.parse(candidate) as unknown;
  } catch (initialError) {
    const objectStart = candidate.indexOf("{");
    const objectEnd = candidate.lastIndexOf("}");
    if (objectStart >= 0 && objectEnd > objectStart) {
      try {
        return JSON.parse(candidate.slice(objectStart, objectEnd + 1)) as unknown;
      } catch {
        // Preserve the first parse error because it points to the actual model response.
      }
    }
    throw new Error(
      `Model did not return valid JSON: ${initialError instanceof Error ? initialError.message : String(initialError)}`
    );
  }
}
