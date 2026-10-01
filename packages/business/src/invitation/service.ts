import { db } from "@chatbotx.io/database/client"
import type { InvitationModel } from "@chatbotx.io/database/types"
import { BaseService } from "../base.service"

class InvitationService extends BaseService {
  async findByCode(code: string): Promise<InvitationModel | undefined> {
    return await db.query.invitationModel.findFirst({ where: { code } })
  }
}

export const invitationService = new InvitationService()
