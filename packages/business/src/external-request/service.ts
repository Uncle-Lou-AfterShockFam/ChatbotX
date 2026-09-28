import { getProperty } from "dot-prop"
import { BaseService } from "../base.service"
import { contactService } from "../contact/service"
import { contactCustomFieldService } from "../contact-custom-field/service"
import { ChatbotXException } from "../errors"
import { fetchFollowingSafeRedirects, SsrfFetchError } from "../net/safe-fetch"
import { checkSsrfSafety } from "../net/ssrf-guard"

const REQUEST_TIMEOUT_MS = 15_000
const MAX_REDIRECTS = 5

// Every hop's Location is re-checked by the shared guard (an unvalidated
// redirect target is a classic SSRF vector); its refusals keep this
// service's error codes.
const fetchWithRedirectGuard = async (url: string, init: RequestInit) => {
  try {
    return await fetchFollowingSafeRedirects(url, init, MAX_REDIRECTS)
  } catch (error) {
    if (!(error instanceof SsrfFetchError)) {
      throw error
    }
    throw error.reason === "tooManyRedirects"
      ? new ChatbotXException(
          "Too many redirects for this external request",
          "ssrfBlocked",
          400,
        )
      : new ChatbotXException(
          "This URL is not allowed for external requests",
          "ssrfBlocked",
          400,
        )
  }
}

export type ExternalRequestHeader = { key: string; value: string }

export type ExternalRequestBody =
  | { bodyType: "allContactData" }
  | { bodyType: "json"; jsonBody: string }
  | { bodyType: "formEncoded"; formFields: ExternalRequestHeader[] }

export type ExternalRequestInput = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
  url: string
  headers: ExternalRequestHeader[]
  body?: ExternalRequestBody
}

export type ExternalRequestResult = {
  statusCode: number
  durationMs: number
  responseBody: string
  responseHeaders: Record<string, string>
}

export type ExternalRequestMapping = {
  jsonPath: string
  outputFieldId: string
}

class ExternalRequestService extends BaseService {
  private async buildRequest(
    input: ExternalRequestInput,
    workspaceId: string,
    contactId: string | undefined,
  ): Promise<{ url: string; init: RequestInit }> {
    // Best-effort only: undici (Node's fetch) always sends the Host header
    // matching the actual connection target and ignores any Host override,
    // so the validated IP below cannot be pinned through a portable fetch()
    // call — the fetch a few lines down re-resolves the hostname itself.
    // This leaves a narrow DNS-rebinding race window between this check and
    // that connection; there is no portable Web API (usable from both this
    // package's Node callers and the Edge bundle that transitively imports
    // it) that lets us connect to a specific IP while still validating TLS/
    // sending Host against the original hostname.
    const ssrfCheck = await checkSsrfSafety(input.url)
    if (ssrfCheck.unsafe) {
      throw new ChatbotXException(
        "This URL is not allowed for external requests",
        "ssrfBlocked",
        400,
      )
    }

    const headers = new Headers()
    for (const header of input.headers) {
      if (header.key.trim()) {
        headers.set(header.key, header.value)
      }
    }

    let body: string | undefined

    if (input.body?.bodyType === "json") {
      body = input.body.jsonBody
      if (!headers.has("Content-Type")) {
        headers.set("Content-Type", "application/json")
      }
    } else if (input.body?.bodyType === "formEncoded") {
      const params = new URLSearchParams()
      for (const field of input.body.formFields) {
        if (field.key.trim()) {
          params.set(field.key, field.value)
        }
      }
      body = params.toString()
      headers.set("Content-Type", "application/x-www-form-urlencoded")
    } else if (input.body?.bodyType === "allContactData") {
      if (!contactId) {
        throw new ChatbotXException(
          "This request requires a contact and cannot be tested without one",
          "contactRequired",
          400,
        )
      }
      const contact = await contactService.findByIdOrFail({
        workspaceId,
        id: contactId,
      })
      const customFields = await contactCustomFieldService.listValues({
        contactId,
      })
      body = JSON.stringify({ contact, customFields })
      headers.set("Content-Type", "application/json")
    }

    return {
      url: input.url,
      init: {
        method: input.method,
        headers,
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    }
  }

  async execute(
    input: ExternalRequestInput,
    props: { workspaceId: string; contactId?: string },
  ): Promise<ExternalRequestResult> {
    const { url, init } = await this.buildRequest(
      input,
      props.workspaceId,
      props.contactId,
    )

    const startedAt = performance.now()
    const response = await fetchWithRedirectGuard(url, init)
    const durationMs = Math.round(performance.now() - startedAt)

    const responseBody = await response.text()
    const responseHeaders: Record<string, string> = {}
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value
    })

    return {
      statusCode: response.status,
      durationMs,
      responseBody,
      responseHeaders,
    }
  }

  /**
   * Run the request, then write custom fields from its JSON body: `mapping`
   * on a < 400 status, `errorMapping` on >= 400 (so a refusal code can reach
   * a field before the error edge). A non-JSON body writes nothing.
   */
  async executeAndMap(props: {
    workspaceId: string
    contactId: string
    input: ExternalRequestInput
    mapping: ExternalRequestMapping[]
    errorMapping?: ExternalRequestMapping[]
  }): Promise<ExternalRequestResult> {
    const { workspaceId, contactId, input, mapping, errorMapping = [] } = props
    const result = await this.execute(input, { workspaceId, contactId })
    const active = result.statusCode >= 400 ? errorMapping : mapping
    if (active.length === 0) {
      return result
    }

    let responseJson: unknown
    try {
      responseJson = JSON.parse(result.responseBody)
    } catch {
      return result
    }

    const fields = active.flatMap(({ jsonPath, outputFieldId }) => {
      const value = getProperty(
        responseJson as Record<string, unknown>,
        jsonPath,
      )
      if (value === undefined || value === null) {
        return []
      }
      const encodedValue =
        typeof value === "string" ? value : JSON.stringify(value)
      return [{ customFieldId: outputFieldId, value: encodedValue }]
    })

    if (fields.length > 0) {
      await contactCustomFieldService.setValues({
        workspaceId,
        contactId,
        fields,
        skipInvalidOptions: true,
      })
    }

    return result
  }
}

export const externalRequestService = new ExternalRequestService()
