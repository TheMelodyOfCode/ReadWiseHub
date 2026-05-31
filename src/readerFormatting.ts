export type ReaderChunk = {
  id: string;
  chunkIndex: number;
  text: string;
  pageStart?: number;
  pageEnd?: number;
};

export type ReaderParagraph = {
  id: string;
  chunkIndexes: number[];
  text: string;
  isHeading?: boolean;
};

function shouldContinueParagraph(text: string) {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }

  if (isReaderStandaloneHeading(trimmed)) {
    return false;
  }

  return !/[.!?]"?$/.test(trimmed) && !/[:;]$/.test(trimmed);
}

function isReaderStandaloneHeading(text: string) {
  const trimmed = text.trim();
  return /^(chapter|kapitel)\s+\d+[a-z]?$/i.test(trimmed);
}

function isReaderNumberedParagraph(text: string) {
  return /^\d{1,3}\s+\S/.test(text.trim());
}

export function formatReaderParagraphs(chunks: ReaderChunk[]): ReaderParagraph[] {
  const paragraphs: ReaderParagraph[] = [];
  let currentText = "";
  let currentIndexes: number[] = [];
  const pushParagraph = (text: string, chunkIndexes: number[], isHeading = false) => {
    paragraphs.push({
      id: `${chunkIndexes[0]}-${paragraphs.length}`,
      chunkIndexes,
      text,
      isHeading,
    });
  };

  chunks.forEach((chunk) => {
    const parts = chunk.text
      .split(/\n{2,}/)
      .map((part) => part.replace(/\s+/g, " ").trim())
      .filter(Boolean);

    parts.forEach((part) => {
      if (isReaderStandaloneHeading(part)) {
        if (currentText) {
          pushParagraph(currentText, currentIndexes);
          currentText = "";
          currentIndexes = [];
        }
        pushParagraph(part, [chunk.chunkIndex], true);
        return;
      }

      if (!currentText) {
        currentText = part;
        currentIndexes = [chunk.chunkIndex];
        return;
      }

      if (
        shouldContinueParagraph(currentText) &&
        !(isReaderNumberedParagraph(currentText) && isReaderNumberedParagraph(part))
      ) {
        currentText = `${currentText} ${part}`;
        currentIndexes = Array.from(new Set([...currentIndexes, chunk.chunkIndex]));
        return;
      }

      pushParagraph(currentText, currentIndexes);
      currentText = part;
      currentIndexes = [chunk.chunkIndex];
    });
  });

  if (currentText) {
    pushParagraph(currentText, currentIndexes);
  }

  return paragraphs;
}
