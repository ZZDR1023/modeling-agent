import { SaxesParser, type SaxesTagNS } from "saxes";

export const WORDPROCESSINGML_NAMESPACE = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
export const SPREADSHEETML_NAMESPACE = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
export const PACKAGE_RELATIONSHIPS_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/relationships";

export function parseXml(
  xml: Buffer | string,
  handlers: {
    openTag?: (tag: SaxesTagNS) => void;
    closeTag?: (tag: SaxesTagNS) => void;
    text?: (text: string) => void;
  }
): void {
  const parser = new SaxesParser({ xmlns: true, position: true });
  parser.on("opentag", (tag) => handlers.openTag?.(tag));
  parser.on("closetag", (tag) => handlers.closeTag?.(tag));
  parser.on("text", (text) => handlers.text?.(text));
  parser.on("cdata", (text) => handlers.text?.(text));
  parser.on("doctype", () => {
    throw new Error("DOCTYPE declarations are not allowed.");
  });
  parser.on("error", (error) => {
    throw error;
  });
  parser.write(xml.toString("utf8"));
  parser.close();
}

export function attributeValue(tag: SaxesTagNS, local: string, uri?: string): string | undefined {
  return Object.values(tag.attributes).find((attribute) => attribute.local === local && (uri === undefined || attribute.uri === uri))?.value;
}
