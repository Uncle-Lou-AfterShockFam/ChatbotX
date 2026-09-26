import {
  type OperatorType,
  operatorTypes,
} from "@chatbotx.io/database/partials"
import {
  isOptionFieldType,
  isOptionOperator,
  OPTION_FIELD_OPERATORS,
  type OptionFieldType,
  optionOperatorTakesList,
} from "@chatbotx.io/utils/custom-field"
import type { ConditionOption, FieldConfig } from "./contact-filter-config"

export type CustomFieldValueInputKind =
  | "none"
  | "text"
  | "number"
  | "date"
  | "datetime"
  | "boolean"
  | "numberInterval"
  | "datetimeInterval"
  | "select"
  | "multiSelect"

export type CustomFieldValueInputConfig = {
  kind: CustomFieldValueInputKind
  defaultValue: string | string[]
}

type CustomFieldTypeRule = {
  singleInput: CustomFieldValueInputKind
  intervalInput?: CustomFieldValueInputKind
  equalityInput?: CustomFieldValueInputKind
  enabledOperators: readonly OperatorType[]
}

const CUSTOM_FIELD_OPERATOR_ORDER = [
  operatorTypes.enum.eq,
  operatorTypes.enum.ne,
  operatorTypes.enum.isNotEmpty,
  operatorTypes.enum.isEmpty,
  operatorTypes.enum.gt,
  operatorTypes.enum.lt,
  operatorTypes.enum.gte,
  operatorTypes.enum.lte,
  operatorTypes.enum.contains,
  operatorTypes.enum.notContains,
  operatorTypes.enum.startsWith,
  operatorTypes.enum.endsWith,
  operatorTypes.enum.isBetween,
  operatorTypes.enum.notBetween,
] as const satisfies readonly OperatorType[]

const VALUELESS_OPERATORS = [
  operatorTypes.enum.isNotEmpty,
  operatorTypes.enum.isEmpty,
] as const satisfies readonly OperatorType[]

const BASE_OPERATORS = [
  operatorTypes.enum.eq,
  operatorTypes.enum.ne,
  ...VALUELESS_OPERATORS,
] as const satisfies readonly OperatorType[]

const TEXT_SEARCH_OPERATORS = [
  operatorTypes.enum.contains,
  operatorTypes.enum.notContains,
  operatorTypes.enum.startsWith,
  operatorTypes.enum.endsWith,
] as const satisfies readonly OperatorType[]

const RANGE_OPERATORS = [
  operatorTypes.enum.gt,
  operatorTypes.enum.lt,
  operatorTypes.enum.gte,
  operatorTypes.enum.lte,
  operatorTypes.enum.isBetween,
  operatorTypes.enum.notBetween,
] as const satisfies readonly OperatorType[]

const textRule = {
  singleInput: "text",
  enabledOperators: [...BASE_OPERATORS, ...TEXT_SEARCH_OPERATORS],
} as const satisfies CustomFieldTypeRule

const CUSTOM_FIELD_TYPE_RULES: Record<string, CustomFieldTypeRule> = {
  shortText: textRule,
  email: textRule,
  phoneNumber: textRule,
  longText: {
    singleInput: "text",
    enabledOperators: BASE_OPERATORS,
  },
  number: {
    singleInput: "number",
    intervalInput: "numberInterval",
    enabledOperators: [
      ...BASE_OPERATORS,
      ...RANGE_OPERATORS,
      ...TEXT_SEARCH_OPERATORS,
    ],
  },
  date: {
    singleInput: "datetime",
    intervalInput: "datetimeInterval",
    equalityInput: "date",
    enabledOperators: [...BASE_OPERATORS, ...RANGE_OPERATORS],
  },
  datetime: {
    singleInput: "datetime",
    intervalInput: "datetimeInterval",
    enabledOperators: [...BASE_OPERATORS, ...RANGE_OPERATORS],
  },
  boolean: {
    singleInput: "boolean",
    enabledOperators: [
      operatorTypes.enum.eq,
      operatorTypes.enum.isNotEmpty,
      operatorTypes.enum.isEmpty,
    ],
  },
}

const DEFAULT_CUSTOM_FIELD_TYPE = "shortText"

const getCustomFieldTypeRule = (
  customFieldType: string | undefined,
): CustomFieldTypeRule =>
  CUSTOM_FIELD_TYPE_RULES[customFieldType ?? DEFAULT_CUSTOM_FIELD_TYPE] ??
  CUSTOM_FIELD_TYPE_RULES[DEFAULT_CUSTOM_FIELD_TYPE]

const isIntervalOperator = (operator?: string): operator is OperatorType =>
  operator === operatorTypes.enum.isBetween ||
  operator === operatorTypes.enum.notBetween

const isEqualityOperator = (operator?: string): operator is OperatorType =>
  operator === operatorTypes.enum.eq || operator === operatorTypes.enum.ne

const isValuelessOperator = (operator?: string): operator is OperatorType =>
  operator === operatorTypes.enum.isNotEmpty ||
  operator === operatorTypes.enum.isEmpty

const resolveInputKind = (
  rule: CustomFieldTypeRule,
  operator?: string,
): CustomFieldValueInputKind => {
  if (isIntervalOperator(operator) && rule.intervalInput) {
    return rule.intervalInput
  }
  if (isEqualityOperator(operator) && rule.equalityInput) {
    return rule.equalityInput
  }
  return rule.singleInput
}

const getDefaultValueForInputKind = (
  kind: CustomFieldValueInputKind,
): string | string[] => {
  switch (kind) {
    case "multiSelect":
      return []
    case "numberInterval":
      return ["0", "0"]
    case "date":
      return ""
    case "datetimeInterval":
      return ["", ""]
    default:
      return ""
  }
}

/**
 * s203: an option field reads its list operators in its own words ("has any
 * of" for a multiSelect `in`); the i18n key, or undefined for the shared label.
 */
const OPTION_OPERATOR_LABEL_KEYS: Record<
  OptionFieldType,
  Partial<Record<string, string>>
> = {
  select: {
    in: "fields.operator.isAnyOf",
    notIn: "fields.operator.isNoneOf",
  },
  multiSelect: {
    in: "fields.operator.hasAnyOf",
    contains: "fields.operator.hasAllOf",
    notIn: "fields.operator.hasNoneOf",
    eq: "fields.operator.isExactly",
    ne: "fields.operator.isNotExactly",
  },
}

export const optionOperatorLabelKey = (
  customFieldType: string | undefined,
  operator: string,
): string | undefined =>
  customFieldType && isOptionFieldType(customFieldType)
    ? OPTION_OPERATOR_LABEL_KEYS[customFieldType][operator]
    : undefined

/** A condition chip's operator label: the option-field wording, else the shared one. */
export const resolveOperatorLabel = (
  customFieldType: string | undefined,
  operator: string,
  operatorLabelByValue: Map<string, string>,
  t: (key: string) => string,
): string => {
  const key = optionOperatorLabelKey(customFieldType, operator)
  return key ? t(key) : (operatorLabelByValue.get(operator) ?? operator)
}

/** Relabels option-field operators (see {@link optionOperatorLabelKey}). */
export const relabelOptionOperators = (
  options: ConditionOption[],
  customFieldType: string | undefined,
  t: (key: string) => string,
): ConditionOption[] =>
  options.map((option) => {
    const key = optionOperatorLabelKey(customFieldType, option.value)
    return key ? { ...option, label: t(key) } : option
  })

export const getCustomFieldConditionOptions = (
  config: FieldConfig,
  conditionOptions: ConditionOption[],
): ConditionOption[] => {
  const optionByOperator = new Map(
    conditionOptions.map((option) => [option.value, option]),
  )
  // s203: an option field offers exactly its own operator table, in order.
  if (config.customFieldType && isOptionFieldType(config.customFieldType)) {
    return OPTION_FIELD_OPERATORS[config.customFieldType].map((operator) => ({
      value: operator,
      label: optionByOperator.get(operator)?.label ?? operator,
    }))
  }
  const rule = getCustomFieldTypeRule(config.customFieldType)
  const enabledOperators = new Set(rule.enabledOperators)

  return CUSTOM_FIELD_OPERATOR_ORDER.map((operator) => {
    const option = optionByOperator.get(operator)
    return {
      value: operator,
      label: option?.label ?? operator,
      disabled: !enabledOperators.has(operator),
    }
  })
}

export const getCustomFieldValueInputConfig = (
  config: FieldConfig | undefined,
  operator: string | undefined,
): CustomFieldValueInputConfig | undefined => {
  // `botField` configs reuse this custom-field input logic unchanged (both
  // are workspace-defined-value fields keyed by `config.customFieldType`) —
  // see the `FieldConfig` doc comment.
  if (!(config?.customFieldId || config?.botFieldId)) {
    return
  }
  if (isValuelessOperator(operator)) {
    return { kind: "none", defaultValue: "" }
  }
  // s203: an option field picks from its options; an operator outside its
  // table (a condition saved before s203, e.g. a select `contains`) keeps the
  // text input it was saved with.
  if (
    config.customFieldType &&
    isOptionFieldType(config.customFieldType) &&
    isOptionOperator(config.customFieldType, operator ?? "")
  ) {
    const kind = optionOperatorTakesList(config.customFieldType, operator ?? "")
      ? "multiSelect"
      : "select"
    return { kind, defaultValue: getDefaultValueForInputKind(kind) }
  }

  const rule = getCustomFieldTypeRule(config.customFieldType)
  const kind = resolveInputKind(rule, operator)

  return {
    kind,
    defaultValue: getDefaultValueForInputKind(kind),
  }
}

export const getDefaultCustomFieldValue = (
  config: FieldConfig | undefined,
  operator: string | undefined,
): string | string[] =>
  getCustomFieldValueInputConfig(config, operator)?.defaultValue ?? ""

export const customFieldOperatorRequiresArrayValue = (
  operator: string | undefined,
  config?: FieldConfig,
): boolean =>
  config?.customFieldType && isOptionFieldType(config.customFieldType)
    ? optionOperatorTakesList(config.customFieldType, operator ?? "")
    : isIntervalOperator(operator)
