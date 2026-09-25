import type { Readable } from "node:stream"
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  type ListObjectsV2CommandInput,
  PutObjectCommand,
  type PutObjectCommandInput,
  S3Client,
} from "@aws-sdk/client-s3"
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

      // Per object, not all-or-nothing: S3 deletes do not roll back, so the
      // count must reflect what is actually gone even when one key fails.
      const results = await Promise.allSettled(
        keys.map((key) => this.deleteObject(key)),
      )
      let firstFailure: unknown
      for (const result of results) {
        if (result.status === "fulfilled") {
          deleted++
        } else {
          firstFailure ??= result.reason
        }
      }
      if (firstFailure !== undefined) {
        throw new PrefixPurgeError(prefix, deleted, firstFailure)
      }

      continuationToken = listed.IsTruncated
        ? listed.NextContinuationToken
        : undefined
      if (!continuationToken) {
        return { deleted }
      }
    }
  }
}

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
