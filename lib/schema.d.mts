// Types for lib/schema.mjs (kept byte-identical to the website's copy).
import type { Field, Schema, Ctx } from "./types";
export const FORMAT: number;
export const FIELD_TYPES: string[];
export function getPath(data: unknown, path: string): unknown;
export function selectOptions(field: Field, ctx?: Ctx): { value: unknown; label: string }[];
export function validateField(field: Field, value: unknown, at: string, ctx?: Ctx): string[];
export function validateFields(fields: Field[], data: Record<string, unknown>, at: string, ctx?: Ctx): string[];
export function validateDocument(schema: Schema, doc: unknown, ctx?: Ctx): string[];
export function validateSchema(schema: Schema): string[];
