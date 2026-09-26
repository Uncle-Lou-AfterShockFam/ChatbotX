import type { ListContactsResponse } from "./schema/query"

export const CONTACTS_DEFAULT_PER_PAGE = 50

/** What an unusable contact filter lists: no contact (s206). */
export const EMPTY_CONTACTS_RESPONSE: ListContactsResponse = {
  data: [],
  pageCount: 0,
  totalCount: 0,
  totalCountCapped: false,
}
