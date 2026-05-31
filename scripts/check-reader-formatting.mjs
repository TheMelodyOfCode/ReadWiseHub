import assert from "node:assert/strict";
import { formatReaderParagraphs } from "../src/readerFormatting.ts";

const chunk = (text) => [{ id: "page-7", chunkIndex: 7, text }];

{
  const paragraphs = formatReaderParagraphs(
    chunk(`Chapter 2

1 So wurden vollendet der Himmel und die Erde und all ihr Heer.

2 Und Gott hatte am siebten Tage sein Werk vollendet.`)
  );

  assert.equal(paragraphs[0].text, "Chapter 2");
  assert.equal(paragraphs[0].isHeading, true);
  assert.equal(paragraphs[1].text, "1 So wurden vollendet der Himmel und die Erde und all ihr Heer.");
}

{
  const paragraphs = formatReaderParagraphs(
    chunk(`20 Und Gott sprach: Es wimmeln die Wasser vom Gewimmel lebendiger

21 Und Gott schuf die großen Seeungeheuer und jedes sich regende, lebendige Wesen.`)
  );

  assert.equal(paragraphs.length, 2);
  assert.equal(paragraphs[0].text, "20 Und Gott sprach: Es wimmeln die Wasser vom Gewimmel lebendiger");
  assert.equal(paragraphs[1].text, "21 Und Gott schuf die großen Seeungeheuer und jedes sich regende, lebendige Wesen.");
}

{
  const paragraphs = formatReaderParagraphs(
    chunk(`This sentence continues

on the next extracted line and ends here.`)
  );

  assert.equal(paragraphs.length, 1);
  assert.equal(paragraphs[0].text, "This sentence continues on the next extracted line and ends here.");
}

console.log("Reader formatting regression passed.");
