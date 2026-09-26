"use client"

import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { useCallback, useEffect, useState } from "react"
import { type ContactFilterCriteria, parseContactFilterParam } from "../schema"

export const EMPTY_CONTACT_FILTER: ContactFilterCriteria = {
  operator: "and",
  conditions: [],
}

/** One value, or the array a repeated `?contactFilter=` arrives as. */
const readContactFilterParam = (params: URLSearchParams) => {
  const values = params.getAll("contactFilter")
  return parseContactFilterParam(values.length > 1 ? values : values[0])
}

const cleanContactFilterUrl = (
  pathname: string,
  searchParams: URLSearchParams,
) => {
  const params = new URLSearchParams(searchParams)
  params.delete("contactFilter")
  const query = params.toString()
  return query ? `${pathname}?${query}` : pathname
}

export function useContactFilterQueryState({
  initialFilter = EMPTY_CONTACT_FILTER,
}: {
  initialFilter?: ContactFilterCriteria
} = {}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const searchParamsKey = searchParams.toString()
  const [filter, setFilterState] =
    useState<ContactFilterCriteria>(initialFilter)
  // Derived from the URL on every render (never an effect), so the first
  // render already knows: an invalid filter must not fetch "everyone" (s206).
  const invalid =
    readContactFilterParam(new URLSearchParams(searchParamsKey)).status ===
    "invalid"

  useEffect(() => {
    const params = new URLSearchParams(searchParamsKey)
    const queryFilter = readContactFilterParam(params)
    if (queryFilter.status !== "valid") {
      return
    }

    setFilterState(queryFilter.filter)
    router.replace(cleanContactFilterUrl(pathname, params), { scroll: false })
  }, [pathname, router, searchParamsKey])

  const clearInvalidFilter = useCallback(() => {
    router.replace(
      cleanContactFilterUrl(pathname, new URLSearchParams(searchParamsKey)),
      { scroll: false },
    )
  }, [pathname, router, searchParamsKey])

  const setFilter = useCallback(
    (next: ContactFilterCriteria) => {
      setFilterState(next)
      if (invalid) {
        clearInvalidFilter()
      }
      return Promise.resolve()
    },
    [clearInvalidFilter, invalid],
  )

  return {
    filter,
    setFilter,
    isActive: filter.conditions.length > 0,
    invalid,
    clearInvalidFilter,
  }
}
