import type { Readable } from "node:stream"
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  type ListObjectsV2CommandInput,
  PutObjectCommand,
  type PutObjectCommandInput,
  S3Client,
} from "@aws-sdk/client-s3"
import { mapWithConcurrency } from "@chatbotx.io/utils"
import { AwsClient } from "aws4fetch"
import { keys } from "../keys"
import { buildCopySource } from "./copy-source"

const env = keys()

export class Uploader {
  readonly #client: S3Client
  readonly #bucketName: string

  static instance: Uploader

  constructor() {
    this.#client = new S3Client({
      endpoint: env.S3_ENDPOINT,
      credentials:
        env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
          ? {
              accessKeyId: env.S3_ACCESS_KEY_ID,
              secretAccessKey: env.S3_SECRET_ACCESS_KEY,
            }
          : undefined,
      region: env.S3_REGION,
      forcePathStyle: Boolean(env.S3_ENDPOINT),
    })
    this.#bucketName = env.S3_BUCKET
  }

  get client(): S3Client {
    return this.#client
  }

  get bucketName(): string {
    return this.#bucketName
  }

  get accessKeyId(): string {
    return env.S3_ACCESS_KEY_ID ?? ""
  }

  get endpoint(): string | undefined {
    return env.S3_ENDPOINT
  }
  get region(): string {
    return env.S3_REGION
  }

  get secretAccessKey(): string {
    return env.S3_SECRET_ACCESS_KEY ?? ""
  }

  static getInstance(): Uploader {
    if (!Uploader.instance) {
      Uploader.instance = new Uploader()
    }
    return Uploader.instance
  }

  async putObject(
    path: string,
    body: string | Uint8Array | Buffer | Readable,
    options?: Partial<PutObjectCommandInput>,
  ) {
    const command = new PutObjectCommand({
      Bucket: this.#bucketName,
      Key: path,
      Body: body,
      ...options,
    })

    return await this.#client.send(command)
  }

  async getPresignedUpload(filePath: string): Promise<string> {
    const client = new AwsClient({
      service: "s3",
      region: env.S3_REGION,
      accessKeyId: env.S3_ACCESS_KEY_ID ?? "",
      secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? "",
    })

    return (
      await client.sign(
        new Request(
          `${env.S3_ENDPOINT}/${env.S3_BUCKET}/${filePath}?X-Amz-Expires=${5 * 60}`,
          {
            method: "PUT",
          },
        ),
        {
          aws: { signQuery: true },
        },
      )
    ).url.toString()
  }

  async getPresignedDownload(
    filePath: string,
    expiresInSeconds = 60 * 60,
  ): Promise<string> {
    const client = new AwsClient({
      service: "s3",
      region: env.S3_REGION,
      accessKeyId: env.S3_ACCESS_KEY_ID ?? "",
      secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? "",
    })

    return (
      await client.sign(
        new Request(
          `${env.S3_ENDPOINT}/${env.S3_BUCKET}/${filePath}?X-Amz-Expires=${expiresInSeconds}`,
          {
            method: "GET",
          },
        ),
        {
          aws: { signQuery: true },
        },
      )
    ).url.toString()
  }

  async headObject(path: string) {
    const command = new HeadObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: path,
    })

    return await this.#client.send(command)
  }

  async getObject(path: string): Promise<Buffer> {
    const command = new GetObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: path,
    })

    const response = await this.#client.send(command)

    if (!response.Body) {
      throw new Error(`No body found for object: ${path}`)
    }

    // Convert stream to buffer
    const chunks: Uint8Array[] = []
    const stream = response.Body as Readable

    return new Promise((resolve, reject) => {
      stream.on("data", (chunk) => chunks.push(chunk))
      stream.on("error", reject)
      stream.on("end", () => resolve(Buffer.concat(chunks)))
    })
  }

  async getObjectStream(
    path: string,
  ): Promise<{ stream: Readable; contentLength?: number }> {
    const command = new GetObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: path,
    })

    const response = await this.#client.send(command)
    if (!response.Body) {
      throw new Error(`No body found for object: ${path}`)
    }
    return {
      stream: response.Body as Readable,
      contentLength: response.ContentLength,
    }
  }

  async copyObject(sourcePath: string, destinationPath: string) {
    const command = new CopyObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: destinationPath,
      CopySource: buildCopySource(sourcePath, env.S3_BUCKET, env.S3_ENDPOINT),
    })

    return await this.#client.send(command)
  }

  async deleteObject(path: string) {
    const command = new DeleteObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: path,
    })
    return await this.#client.send(command)
  }

  /**
   * One S3 multi-object delete (at most 1000 distinct keys, one listing
   * page; more throws a RangeError before any request). Per key, not
   * all-or-nothing: returns how many keys the store confirmed gone and the
   * first failure; a key the reply omits, or names in `Errors`, counts as
   * failed.
   */
  async deleteObjects(
    keys: string[],
  ): Promise<{ deleted: number; firstFailure?: unknown }> {
    if (keys.length === 0) {
      return { deleted: 0 }
    }
    // Counted by distinct key on both sides: a repeated key in the request or
    // a key acknowledged twice in the reply must never inflate the count.
    const requested = new Set(keys)
    if (requested.size > MAX_DELETE_OBJECTS_KEYS) {
      throw new RangeError(
        `deleteObjects: ${requested.size} keys exceeds the S3 limit of ${MAX_DELETE_OBJECTS_KEYS} per request`,
      )
    }
    const reply = await this.#client.send(
      new DeleteObjectsCommand({
        Bucket: env.S3_BUCKET,
        Delete: {
          Objects: [...requested].map((Key) => ({ Key })),
          Quiet: false,
        },
      }),
    )
    // A key the store names in BOTH lists is ambiguous: count it failed.
    const failed = new Set((reply.Errors ?? []).map((entry) => entry.Key))
    const confirmed = new Set(
      (reply.Deleted ?? [])
        .map((entry) => entry.Key)
        .filter(
          (key): key is string =>
            key !== undefined && requested.has(key) && !failed.has(key),
        ),
    )
    const deleted = confirmed.size
    const error = reply.Errors?.[0]
    if (error) {
      return {
        deleted,
        firstFailure: new Error(
          `${error.Code ?? "DeleteError"} on "${error.Key}": ${error.Message ?? ""}`,
        ),
      }
    }
    if (deleted < requested.size) {
      return {
        deleted,
        firstFailure: new Error(
          `multi-object delete confirmed ${deleted} of ${requested.size} key(s)`,
        ),
      }
    }
    return { deleted }
  }

  async listObjects(
    prefix: string,
    options: Partial<ListObjectsV2CommandInput> = {},
  ) {
    const command = new ListObjectsV2Command({
      ...options,
      Bucket: env.S3_BUCKET,
      Prefix: prefix,
    })
    return await this.#client.send(command)
  }

  /**
   * Deletes every object under `prefix`, paging through the listing. Throws
   * (never silently succeeds) on an empty or non-string prefix, because an
   * empty prefix lists the whole bucket. Bounded: past `maxPages` listing
   * pages it throws `PrefixTooLargeError` so a runaway prefix can never spin
   * a worker forever. Every thrown `PrefixPurgeError` carries `deleted`, the
   * number of objects already gone, so a caller can tell a partial purge from
   * a purge that never started. Callers that must not fail wrap it.
   */
  async deleteByPrefix(
    prefix: string,
    options: { except?: string; maxPages?: number } = {},
  ): Promise<{ deleted: number }> {
    if (typeof prefix !== "string" || prefix.length === 0) {
      throw new TypeError("deleteByPrefix: prefix must be a non-empty string")
    }
    const maxPages = options.maxPages ?? DEFAULT_DELETE_BY_PREFIX_MAX_PAGES
    let deleted = 0
    let continuationToken: string | undefined
    for (let page = 0; ; page++) {
      if (page >= maxPages) {
        throw new PrefixTooLargeError(prefix, maxPages, deleted)
      }
      let listed: Awaited<ReturnType<Uploader["listObjects"]>>
      try {
        listed = await this.listObjects(prefix, {
          ContinuationToken: continuationToken,
        })
      } catch (error) {
        throw new PrefixPurgeError(prefix, deleted, error)
      }
      const keys = (listed.Contents ?? [])
        .map((object) => object.Key)
        .filter((key): key is string => Boolean(key) && key !== options.except)

      // One request per page (a page is at most 1000 keys, the S3 limit),
      // counted per key: S3 deletes do not roll back, so the count must
      // reflect what is actually gone even when one key fails.
      const outcome = await this.#deletePage(keys)
      deleted += outcome.deleted
      const firstFailure = outcome.firstFailure
      if (firstFailure !== undefined) {
        throw new PrefixPurgeError(prefix, deleted, firstFailure)
      }

      if (!listed.IsTruncated) {
        return { deleted }
      }
      // Truncated but no token: the rest of the prefix is unreachable, which
      // must read as a partial purge, never as success.
      if (!listed.NextContinuationToken) {
        throw new PrefixPurgeError(
          prefix,
          deleted,
          new Error("listing is truncated but has no continuation token"),
        )
      }
      continuationToken = listed.NextContinuationToken
    }
  }

  /**
   * One page through the multi-object delete. If that REQUEST fails as a
   * whole (e.g. one key the XML body cannot carry), fall back to per-key
   * deletes, bounded, so one bad key cannot keep up to 999 others from ever
   * being purged; the bad key then fails alone.
   */
  async #deletePage(
    keys: string[],
  ): Promise<Awaited<ReturnType<Uploader["deleteObjects"]>>> {
    try {
      return await this.deleteObjects(keys)
    } catch {
      // Deliberately not rethrown: the per-key pass below re-attempts every
      // key and surfaces its own first failure, which is the actionable one.
      const results = await mapWithConcurrency(
        [...new Set(keys)],
        PER_KEY_FALLBACK_CONCURRENCY,
        (key) => this.deleteObject(key),
      )
      let deleted = 0
      let firstFailure: unknown
      for (const result of results) {
        if (result.status === "fulfilled") {
          deleted++
        } else {
          firstFailure ??= result.reason
        }
      }
      return firstFailure === undefined
        ? { deleted }
        : { deleted, firstFailure }
    }
  }
}

/** S3's per-request cap for DeleteObjects. */
export const MAX_DELETE_OBJECTS_KEYS = 1000

/** Parallel single deletes when a whole multi-object request is refused. */
const PER_KEY_FALLBACK_CONCURRENCY = 8

/** 1000 keys per S3 page: 100 pages = 100k objects under one prefix. */
export const DEFAULT_DELETE_BY_PREFIX_MAX_PAGES = 100

/** A prefix purge that stopped early; `deleted` objects are already gone. */
export class PrefixPurgeError extends Error {
  readonly prefix: string
  readonly deleted: number

  constructor(prefix: string, deleted: number, cause: unknown) {
    super(
      `deleteByPrefix: failed under "${prefix}" after deleting ${deleted} object(s)`,
      { cause },
    )
    this.name = "PrefixPurgeError"
    this.prefix = prefix
    this.deleted = deleted
  }
}

export class PrefixTooLargeError extends PrefixPurgeError {
  readonly maxPages: number

  constructor(prefix: string, maxPages: number, deleted: number) {
    super(prefix, deleted, undefined)
    this.message = `deleteByPrefix: more than ${maxPages} listing pages under "${prefix}" (${deleted} object(s) deleted before the cap)`
    this.name = "PrefixTooLargeError"
    this.maxPages = maxPages
  }
}

export const uploader = Uploader.getInstance()
