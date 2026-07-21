import { writeFile } from "node:fs/promises";
import { escapeXml } from "./format.js";

export const FONT = "Inter, Arial, Helvetica, sans-serif";

export function attrs(values: Record<string, string | number | boolean | null | undefined>): string {
  return Object.entries(values)
    .filter(([, value]) => value !== null && value !== undefined && value !== false)
    .map(([key, value]) => `${key.replaceAll("_", "-")}="${escapeXml(value === true ? key : value)}"`)
    .join(" ");
}

export function element(
  name: string,
  attributes: Record<string, string | number | boolean | null | undefined>,
  body = ""
): string {
  const rendered = attrs(attributes);
  return body ? `<${name} ${rendered}>${body}</${name}>` : `<${name} ${rendered}/>`;
}

export function text(
  x: number,
  y: number,
  value: unknown,
  options: Record<string, string | number | boolean | null | undefined> = {}
): string {
  return element("text", { x, y, "font-family": FONT, fill: "#222", ...options }, escapeXml(value));
}

export function line(x1: number, y1: number, x2: number, y2: number, options: Record<string, unknown> = {}): string {
  return element("line", { x1, y1, x2, y2, stroke: "#333", ...options } as Record<
    string,
    string | number | boolean | null | undefined
  >);
}

export function rect(
  x: number,
  y: number,
  width: number,
  height: number,
  options: Record<string, unknown> = {}
): string {
  return element("rect", { x, y, width: Math.max(0, width), height: Math.max(0, height), ...options } as Record<
    string,
    string | number | boolean | null | undefined
  >);
}

export function circle(cx: number, cy: number, r: number, options: Record<string, unknown> = {}): string {
  return element("circle", { cx, cy, r, ...options } as Record<string, string | number | boolean | null | undefined>);
}

export function polygon(points: Array<[number, number]>, options: Record<string, unknown> = {}): string {
  return element("polygon", { points: points.map(([x, y]) => `${x},${y}`).join(" "), ...options } as Record<
    string,
    string | number | boolean | null | undefined
  >);
}

export function svgDocument(width: number, height: number, content: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img">\n<rect width="100%" height="100%" fill="#fff"/>\n${content}\n</svg>\n`;
}

export async function writeSvg(svg: string, svgPath: string): Promise<void> {
  await writeFile(svgPath, svg, "utf8");
}
