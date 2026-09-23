import { zodBigintAsString } from "@chatbotx.io/utils"
import z from "zod"

const domainsField = z
  .array(z.string().trim().min(1).max(253))
  .max(50)
  .describe(
    "Email domains that identify the company (lower-cased, no @). An inbound email at one of them links the contact automatically. Consumer mailbox domains are rejected.",
  )

export const createCompanyRequest = z.object({
  name: z.string().trim().min(1).max(255).describe("Company name."),
  domains: domainsField.optional(),
  website: z
    .string()
    .trim()
    .max(2048)
    .nullish()
    .describe("Company website URL, informational only."),
  phone: z
    .string()
    .trim()
    .max(64)
    .nullish()
    .describe("Company switchboard phone, informational only."),
  notes: z
    .string()
    .trim()
    .max(10_000)
    .nullish()
    .describe("Free-text notes shown on the company page."),
  stopOnReply: z
    .boolean()
    .optional()
    .describe(
      "When false an inbound reply or the stop tag does not stop the company; the API and deals still do. Default true.",
    ),
})
export type CreateCompanyRequest = z.infer<typeof createCompanyRequest>

export const updateCompanyRequest = createCompanyRequest.partial()
export type UpdateCompanyRequest = z.infer<typeof updateCompanyRequest>

export const stopCompanyRequest = z.object({
  force: z
    .boolean()
    .optional()
    .describe("Re-run the stop cascade on an already-stopped company."),
})
export type StopCompanyRequest = z.infer<typeof stopCompanyRequest>

export const setContactCompanyRequest = z.object({
  contactId: zodBigintAsString(),
  companyId: zodBigintAsString().nullable(),
})
export type SetContactCompanyRequest = z.infer<typeof setContactCompanyRequest>
