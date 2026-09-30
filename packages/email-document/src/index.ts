// The renderers are subpath exports (renderEmail pulls in mjml, Node only):
//   import { renderWeb } from "@chatbotx.io/email-document/render-web"
//   import { renderEmail } from "@chatbotx.io/email-document/render-email"

export { collectRenderInputs, leafBlocks } from "./collect"
export type { RenderAsset, RenderContext } from "./context"
export { UNSUBSCRIBE_PLACEHOLDER } from "./context"
export * from "./errors"
export { fromLegacyElements } from "./legacy"
export {
  hasTemplate,
  TEMPLATE_MAX_BYTES,
  TEMPLATE_MAX_DELIMITERS,
  TEMPLATE_MAX_DEPTH,
  TemplateError,
  templateError,
} from "./liquid"
export { parseDocument } from "./parse"
export * from "./schema"
export { escapeHtml, mergePlain, tokenNames } from "./tokens"
