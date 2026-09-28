// The registry moved to the sdk (s219) so the integration packages, which
// never depend on business, reach the SAME globalThis-keyed registry. Every
// name stays importable from business (barrel + `./outbound-fetch` subpath).
export {
  DOWNLOAD_TIMEOUT_MS,
  kyOutboundFetch,
  type OutboundBody,
  type OutboundFetch,
  OutboundFetchNotInstalledError,
  type OutboundFetchOptions,
  type OutboundRequestInit,
  outboundDownload,
  outboundFetch,
  registerOutboundFetch,
} from "@chatbotx.io/sdk/outbound-fetch"
