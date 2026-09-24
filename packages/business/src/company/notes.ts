import {
  and,
  type DatabaseClient,
  db,
  desc,
  eq,
} from "@chatbotx.io/database/client"
import { companyNoteModel } from "@chatbotx.io/database/schema"
import type { CompanyNoteModel } from "@chatbotx.io/database/types"
import { createId } from "@chatbotx.io/utils"
import { BaseService } from "../base.service"
import { notFoundException, validationException } from "../errors"
import { companyActivityService } from "./activity"
import { companyService } from "./service"

export const MAX_COMPANY_NOTE_CHARS = 4000
export const MAX_COMPANY_NOTES_PAGE = 200
const NOTE_NOT_FOUND = "Company note not found"

function parseText(text: unknown): string {
  const value = typeof text === "string" ? text.trim() : ""
  if (value.length === 0) {
    throw validationException("text", "Note text is required.")
  }
  if (value.length > MAX_COMPANY_NOTE_CHARS) {
    throw validationException(
      "text",
      `Note text is at most ${MAX_COMPANY_NOTE_CHARS} characters.`,
    )
  }
  return value
}

/**
 * Free-text notes on a company (s195 CRM 360). Every write is scoped by
 * `workspaceId` AND `companyId`; a note id from another workspace or company
 * is a 404. Add / delete leave a row in the company change log.
 */
class CompanyNoteService extends BaseService {
  async create(props: {
    workspaceId: string
    companyId: string
    text: string
    createdById: string | null
  }): Promise<CompanyNoteModel> {
    const { workspaceId, companyId, createdById } = props
    const text = parseText(props.text)
    await companyService.findOrFail({ workspaceId, id: companyId })
    const note = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(companyNoteModel)
        .values({ id: createId(), workspaceId, companyId, text, createdById })
        .returning()
      await companyActivityService.record({
        tx,
        workspaceId,
        companyId,
        type: "noteAdded",
        actorId: createdById,
        payload: { noteId: row.id, excerpt: text.slice(0, 140) },
      })
      return row
    })
    await this.audit("company.note.create", note.id)
    return note
  }

  async update(props: {
    workspaceId: string
    companyId: string
    noteId: string
    text: string
  }): Promise<CompanyNoteModel> {
    const { workspaceId, companyId, noteId } = props
    const text = parseText(props.text)
    const [note] = await db
      .update(companyNoteModel)
      .set({ text })
      .where(
        and(
          eq(companyNoteModel.id, noteId),
          eq(companyNoteModel.workspaceId, workspaceId),
          eq(companyNoteModel.companyId, companyId),
        ),
      )
      .returning()
    if (!note) {
      throw notFoundException(NOTE_NOT_FOUND)
    }
    await this.audit("company.note.update", noteId)
    return note
  }

  async delete(props: {
    workspaceId: string
    companyId: string
    noteId: string
    actorId: string | null
  }): Promise<void> {
    const { workspaceId, companyId, noteId, actorId } = props
    await db.transaction(async (tx) => {
      const deleted = await tx
        .delete(companyNoteModel)
        .where(
          and(
            eq(companyNoteModel.id, noteId),
            eq(companyNoteModel.workspaceId, workspaceId),
            eq(companyNoteModel.companyId, companyId),
          ),
        )
        .returning({ id: companyNoteModel.id })
      if (deleted.length === 0) {
        throw notFoundException(NOTE_NOT_FOUND)
      }
      await companyActivityService.record({
        tx,
        workspaceId,
        companyId,
        type: "noteDeleted",
        actorId,
        payload: { noteId },
      })
    })
    await this.audit("company.note.delete", noteId)
  }

  /** Newest first. The company is resolved in the workspace first (404 otherwise). */
  async list(props: {
    workspaceId: string
    companyId: string
    limit?: number
    tx?: DatabaseClient
  }): Promise<CompanyNoteModel[]> {
    const { workspaceId, companyId, tx = db } = props
    const limit = Math.min(
      Math.max(Math.trunc(props.limit ?? 50), 1),
      MAX_COMPANY_NOTES_PAGE,
    )
    await companyService.findOrFail({ workspaceId, id: companyId, tx })
    return await tx
      .select()
      .from(companyNoteModel)
      .where(
        and(
          eq(companyNoteModel.workspaceId, workspaceId),
          eq(companyNoteModel.companyId, companyId),
        ),
      )
      .orderBy(desc(companyNoteModel.createdAt), desc(companyNoteModel.id))
      .limit(limit)
  }
}

export const companyNoteService = new CompanyNoteService()
