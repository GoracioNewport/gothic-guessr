/**
 * Types of the message dictionaries (SPEC §10.8). `en` (src/i18n/en.ts) is the source of the key set and
 * of which keys are plural; every other dictionary is a `Dictionary`, so a missing, extra or wrongly
 * shaped entry is a compile error.
 */
import type { ApiErrorCode } from '../../shared/api';
import type { en } from './en';

type Source = typeof en;

/** Every message key. */
export type MessageKey = keyof Source;

/** Keys whose English entry is a plural object. */
export type PluralKey = { [K in MessageKey]: Source[K] extends string ? never : K }[MessageKey];

/** Keys whose English entry is a plain string. */
export type StringKey = Exclude<MessageKey, PluralKey>;

/** Plural forms of one message: the `Intl.PluralRules` categories a language uses; `other` is mandatory. */
export type PluralForms = { readonly other: string } & {
  readonly [C in Exclude<Intl.LDMLPluralRule, 'other'>]?: string;
};

/** A complete dictionary: same keys as `en`, plural where `en` is plural. */
export type Dictionary = {
  readonly [K in MessageKey]: Source[K] extends string ? string : PluralForms;
};

/** Values for `{name}` placeholders. Numbers are inserted with `String()` (format them first if needed). */
export type MessageParams = Readonly<Record<string, string | number>>;

/** Compile-time check: every server error code has an `error.<code>` message. */
type MissingErrorKeys = Exclude<`error.${ApiErrorCode}`, MessageKey>;
const errorKeysComplete: [MissingErrorKeys] extends [never] ? true : MissingErrorKeys = true;
void errorKeysComplete;
